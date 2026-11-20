import { execFile } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { validateGitIdentity } from './gitIdentity';

const execFileAsync = promisify(execFile);

// ─── Minimal types for the VS Code Git extension API ─────────────────────────

interface GitExtension {
    getAPI(version: 1): GitAPI;
}

interface GitAPI {
    repositories: GitRepository[];
}

export interface GitRepository {
    rootUri: vscode.Uri;
    diff(cached?: boolean): Promise<string>;
    state: {
        indexChanges: Array<{ uri: vscode.Uri }>;
    };
}

/** Picks the best matching repository given a preferred root URI. */
function pickRepository(
    repos: GitRepository[],
    preferred?: vscode.Uri
): GitRepository | undefined {
    if (repos.length === 0) {
        return undefined;
    }
    if (preferred) {
        const hit = repos.find((r) => r.rootUri.fsPath === preferred.fsPath);
        if (hit) {
            return hit;
        }
    }
    const active = vscode.window.activeTextEditor?.document.uri.fsPath;
    if (active) {
        const hit = repos
            .filter((r) => active.startsWith(r.rootUri.fsPath))
            .sort((a, b) => b.rootUri.fsPath.length - a.rootUri.fsPath.length)[0];
        if (hit) {
            return hit;
        }
    }
    return repos.length === 1 ? repos[0] : undefined;
}

// ─── GitService ───────────────────────────────────────────────────────────────

export class GitService {
    readonly repoRoot: string;

    constructor(private readonly repo: GitRepository) {
        this.repoRoot = repo.rootUri.fsPath;
    }

    /**
     * Returns the best matching open repository.
     *
     * Resolution order:
     *   1. Exact `rootUri` match against `preferred` (typically passed when the
     *      command is invoked from a `scm/title` button — VS Code provides the
     *      `SourceControl` instance as the first argument).
     *   2. The deepest repository containing the active editor's file.
     *   3. If exactly one repository is open, return it.
     *   4. Otherwise prompt the user to pick one via QuickPick.
     */
    static async getRepository(preferred?: vscode.Uri): Promise<GitRepository | undefined> {
        const ext = vscode.extensions.getExtension<GitExtension>('vscode.git');
        if (!ext) {
            return undefined;
        }
        if (!ext.isActive) {
            try {
                await ext.activate();
            } catch {
                return undefined;
            }
        }
        const api = ext.exports.getAPI(1);
        const repos = api.repositories;
        if (repos.length === 0) {
            return undefined;
        }

        const auto = pickRepository(repos, preferred);
        if (auto) {
            return auto;
        }

        // Multiple repositories and no unambiguous winner — ask the user.
        const pick = await vscode.window.showQuickPick(
            repos.map((r) => ({
                label: vscode.workspace.asRelativePath(r.rootUri, false) || r.rootUri.fsPath,
                description: r.rootUri.fsPath,
                repo: r,
            })),
            { placeHolder: 'Select a Git repository for AutoCommit' }
        );
        return pick?.repo;
    }

    /** Returns the full staged diff text. Forces stable prefixes and `core.quotePath=false` so parsing does not depend on user diff config. */
    async getStagedDiff(): Promise<string> {
        const { stdout } = await this.git([
            'diff', '--cached', '--no-color', '--no-ext-diff',
            '--src-prefix=a/', '--dst-prefix=b/',
        ]);
        return stdout;
    }

    /** Returns staged file paths (relative to repo root, forward slashes). */
    getStagedFilePaths(): string[] {
        return this.repo.state.indexChanges.map((c) =>
            c.uri.fsPath.replace(this.repoRoot + '/', '').replace(/\\/g, '/')
        );
    }

    /**
     * Detects the language of the current git user's commits.
     * Reads up to 20 commit subjects authored by the current user.
     * Returns 'zh' if non-ASCII characters make up >20% of total, else 'en'.
     */
    async detectLanguage(): Promise<'en' | 'zh'> {
        try {
            const { stdout: emailOut } = await this.git(['config', 'user.email']);
            const userEmail = emailOut.trim().toLowerCase();

            const { stdout: logOut } = await this.git([
                'log',
                '--format=%ae\t%s',
                '-50',
                '--no-merges',
            ]);

            const subjects = logOut
                .trim()
                .split('\n')
                .filter((line) => {
                    const tab = line.indexOf('\t');
                    return tab !== -1 && line.slice(0, tab).toLowerCase() === userEmail;
                })
                .map((line) => line.slice(line.indexOf('\t') + 1))
                .slice(0, 20);

            if (subjects.length === 0) {
                return 'en';
            }

            const allText = subjects.join('');
            const nonAsciiCount = (allText.match(/[^\x00-\x7F]/g) ?? []).length;
            return nonAsciiCount / allText.length > 0.2 ? 'zh' : 'en';
        } catch {
            return 'en';
        }
    }

    /** Rejects before index mutation when Git's configured author identity is incomplete. */
    async assertCommitIdentityConfigured(): Promise<void> {
        const [name, email] = await Promise.all([
            this.getOptionalConfig('user.name'),
            this.getOptionalConfig('user.email'),
        ]);
        validateGitIdentity(name, email);
    }

    private async getOptionalConfig(key: string): Promise<string | undefined> {
        try {
            const { stdout } = await this.git(['config', '--get', key]);
            return stdout.trim() || undefined;
        } catch {
            return undefined;
        }
    }

    /** `git write-tree`. Fails when the index has unresolved conflicts. */
    async writeIndexTree(): Promise<string> {
        const { stdout } = await this.git(['write-tree']);
        return stdout.trim();
    }

    /**
     * Commits each entry with exactly the staged content recorded in `snapshotTree`,
     * never the working tree. Afterwards the index again equals `snapshotTree`,
     * so whatever was not committed stays staged exactly as before.
     * Stops at the first failure; earlier commits stay.
     */
    async commitFromSnapshot(
        snapshotTree: string,
        commits: Array<{ id: string; paths: string[]; message: string }>,
    ): Promise<{ committedIds: string[]; error?: Error }> {
        if (await this.hasHead()) {
            await this.git(['read-tree', 'HEAD']);
        } else {
            await this.git(['read-tree', '--empty']);
        }

        const committedIds: string[] = [];
        let error: Error | undefined;
        try {
            for (const commit of commits) {
                try {
                    await this.git([
                        'restore', `--source=${snapshotTree}`, '--staged', '--', ...commit.paths,
                    ]);
                    await this.git(['commit', '-m', commit.message]);
                    committedIds.push(commit.id);
                } catch (err) {
                    error = err instanceof Error ? err : new Error(String(err));
                    break;
                }
            }
        } finally {
            // Restore the full original snapshot even when a hook aborted a
            // commit, so the user's staged state is never lost.
            await this.git(['read-tree', snapshotTree]);
            try {
                await this.git(['update-index', '-q', '--refresh']);
            } catch {
                // A stale stat cache is harmless; the index content is correct.
            }
        }

        return error ? { committedIds, error } : { committedIds };
    }

    private async hasHead(): Promise<boolean> {
        try {
            await this.git(['rev-parse', '--verify', '--quiet', 'HEAD']);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Returns the most recent commits on the current branch (up to `count`).
     */
    async getRecentCommits(count: number = 20): Promise<Array<{ hash: string; message: string; author: string; date: string }>> {
        try {
            const { stdout } = await this.git([
                'log',
                `--max-count=${count}`,
                '--no-merges',
                '--format=%H%x1f%s%x1f%an%x1f%ai',
            ]);
            if (!stdout.trim()) return [];
            return stdout.trim().split('\n').map((line) => {
                const [hash, message, author, date] = line.split('\x1f');
                return { hash: hash.slice(0, 8), message, author, date: date.slice(0, 16) };
            });
        } catch {
            return [];
        }
    }

    private async git(args: string[]): Promise<{ stdout: string; stderr: string }> {
        // Always disable octal-escaping of non-ASCII paths so we get UTF-8 directly.
        return execFileAsync('git', ['-c', 'core.quotePath=false', ...args], {
            cwd: this.repoRoot,
            encoding: 'utf8',
            maxBuffer: 64 * 1024 * 1024,
        });
    }
}
