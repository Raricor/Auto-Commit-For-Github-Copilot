import * as vscode from 'vscode';
import { getSettings, updateSettings } from '../config/settings';
import { parseDiff, resolveStagingPaths } from '../git/diffAnalyzer';
import { GitIdentityError } from '../git/gitIdentity';
import { GitService } from '../git/gitService';
import {
    generateCommits,
    generateForGroup,
    getAvailableModels,
    type RequestEstimate,
} from '../llm/llmService';
import type {
    CommitCandidate,
    ExtensionMessage,
    FileChange,
    GenerateOptions,
    GitLogEntry,
    PlannedGroup,
    StagedFileInfo,
    WebviewMessage,
} from '../types';

type ModelInfo = { id: string; name: string };

/** Keep one stagedFiles message small enough for the webview to handle. */
const MAX_STAGED_DIFF_LENGTH = 1024 * 1024;

export class PanelManager {
    private static instance: PanelManager | undefined;

    private panel: vscode.WebviewPanel | undefined;
    private candidates: CommitCandidate[] = [];
    private fileDiffs: Map<string, string> = new Map();
    private fileChanges: FileChange[] = [];
    private sessionLanguage: string | undefined;
    private cancellation: vscode.CancellationTokenSource | undefined;
    private currentRepoRoot: string | undefined;
    private targetRepoUri: vscode.Uri | undefined;
    private recentCommits: GitLogEntry[] = [];
    private availableModels: ModelInfo[] | undefined;
    private generationRunId = 0;
    private generating = false;
    private retrying = false;
    private generationTree: string | undefined;
    private lastRun: { groups: PlannedGroup[]; changes: FileChange[] } | undefined;

    private constructor(private readonly context: vscode.ExtensionContext) { }

    static getInstance(context: vscode.ExtensionContext): PanelManager {
        PanelManager.instance ??= new PanelManager(context);
        return PanelManager.instance;
    }

    async openAndGenerate(targetRepoUri?: vscode.Uri): Promise<void> {
        const switchingRepo =
            !!targetRepoUri &&
            targetRepoUri.fsPath !== this.targetRepoUri?.fsPath;
        if (targetRepoUri) {
            this.targetRepoUri = targetRepoUri;
        }
        const hadPanel = !!this.panel;
        this.ensurePanel();
        this.updatePanelTitle();
        this.panel!.reveal(vscode.ViewColumn.One);

        // If the panel already existed and the user clicked a different repo's
        // ✨ button, refresh the staged files / commit history for the new repo.
        // (For a fresh panel the webview will trigger this via its 'ready' message.)
        if (hadPanel && switchingRepo) {
            await Promise.all([
                this.loadStagedFiles(),
                this.loadCommitHistory(),
            ]);
        }
    }

    private updatePanelTitle(): void {
        if (!this.panel) {
            return;
        }
        const base = 'AutoCommit For Github Copilot';
        if (this.targetRepoUri) {
            const name = this.targetRepoUri.fsPath.split(/[\\/]/).pop();
            this.panel.title = name ? `${base} — ${name}` : base;
        } else {
            this.panel.title = base;
        }
    }

    // ─── Panel lifecycle ────────────────────────────────────────────────────────

    private ensurePanel(): void {
        if (this.panel) {
            return;
        }

        this.panel = vscode.window.createWebviewPanel(
            'autocommit-for-github-copilot',
            'AutoCommit For Github Copilot',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(this.context.extensionUri, 'out', 'webview'),
                ],
            }
        );

        this.panel.webview.html = buildWebviewHtml(this.panel.webview, this.context.extensionUri);

        this.panel.webview.onDidReceiveMessage(
            (msg: WebviewMessage) => {
                this.handleMessage(msg).catch((err) => {
                    console.error('[AutoCommit] handleMessage error:', err);
                    this.post({ type: 'error', message: String(err) });
                });
            },
            undefined,
            this.context.subscriptions
        );

        this.panel.onDidDispose(() => {
            this.panel = undefined;
            this.cancellation?.cancel();
        });
    }

    // ─── Message handler ────────────────────────────────────────────────────────

    private async handleMessage(msg: WebviewMessage): Promise<void> {
        switch (msg.type) {
            case 'ready': {
                const models = await this.loadModels();
                const settings = await this.normalizeModelSetting(
                    this.effectiveSettings(),
                    models,
                    true
                );
                this.post({ type: 'settings', settings });
                await Promise.all([
                    this.loadStagedFiles(),
                    this.loadCommitHistory(),
                ]);
                break;
            }

            case 'updateSettings': {
                await updateSettings(msg.settings);
                if (msg.settings.language !== undefined) {
                    this.sessionLanguage =
                        msg.settings.language === 'auto' ? undefined : msg.settings.language;
                }
                if (msg.settings.model !== undefined) {
                    const settings = await this.normalizeModelSetting(
                        this.effectiveSettings(),
                        this.availableModels,
                        true
                    );
                    this.post({ type: 'settings', settings });
                }
                break;
            }

            case 'regenerate': {
                this.sessionLanguage =
                    msg.settings.language === 'auto' ? undefined : msg.settings.language;
                await this.loadStagedFiles();
                await this.generate(msg.settings);
                break;
            }

            case 'retryGroup': {
                await this.retryGroup(msg.groupIndex, msg.settings);
                break;
            }

            case 'commit': {
                await this.commitSelected(msg.ids, msg.orderedCandidates);
                break;
            }

            case 'openFile': {
                if (!this.currentRepoRoot) {
                    return;
                }
                const uri = vscode.Uri.joinPath(
                    vscode.Uri.file(this.currentRepoRoot),
                    msg.path
                );
                try {
                    await vscode.window.showTextDocument(uri, { preview: true });
                } catch {
                    vscode.window.showWarningMessage(`Could not open file: ${msg.path}`);
                }
                break;
            }

            case 'showDiff': {
                await this.sendFileDiff(msg.path);
                break;
            }

            case 'cancel': {
                this.generationRunId += 1;
                this.cancellation?.cancel();
                this.generating = false;
                this.retrying = false;
                this.post({ type: 'done' });
                break;
            }

            case 'refresh': {
                await Promise.all([
                    this.loadStagedFiles(),
                    this.loadCommitHistory(),
                ]);
                break;
            }
        }
    }

    // ─── Load models ────────────────────────────────────────────────────────────

    private async loadModels(): Promise<ModelInfo[] | undefined> {
        try {
            const models = await getAvailableModels();
            this.availableModels = models;
            this.post({ type: 'availableModels', models });
            return models;
        } catch (err) {
            console.error('[AutoCommit] Failed to load models:', err);
            return undefined;
        }
    }

    // ─── Load staged files ──────────────────────────────────────────────────────

    private async loadCommitHistory(): Promise<void> {
        try {
            const repo = await GitService.getRepository(this.targetRepoUri);
            if (!repo) {
                this.post({ type: 'commitHistory', commits: [] });
                return;
            }
            const gitService = new GitService(repo);
            this.recentCommits = await gitService.getRecentCommits(20);
            this.post({ type: 'commitHistory', commits: this.recentCommits });
        } catch (err) {
            console.error('[AutoCommit] Failed to load commit history:', err);
            this.post({ type: 'commitHistory', commits: [] });
        }
    }

    private async loadStagedFiles(): Promise<void> {
        try {
            const repo = await GitService.getRepository(this.targetRepoUri);
            if (!repo) {
                this.post({ type: 'stagedFiles', files: [] });
                return;
            }
            const gitService = new GitService(repo);
            this.currentRepoRoot = gitService.repoRoot;
            // Remember the actually-resolved repo so subsequent calls stay locked on it.
            this.targetRepoUri = repo.rootUri;
            this.updatePanelTitle();
            const diff = await gitService.getStagedDiff();
            if (!diff.trim()) {
                this.post({ type: 'stagedFiles', files: [] });
                return;
            }
            const changes = parseDiff(diff);
            this.fileChanges = changes;
            this.fileDiffs.clear();
            for (const change of changes) {
                this.fileDiffs.set(change.path, change.diff);
            }
            const omitDiffs =
                changes.reduce((total, change) => total + change.diff.length, 0) >
                MAX_STAGED_DIFF_LENGTH;
            const files: StagedFileInfo[] = changes.map((change) => {
                const { additions, deletions } = countDiffLines(change.diff);
                return {
                    path: change.path,
                    type: change.type,
                    diff: omitDiffs ? '' : change.diff,
                    ...(omitDiffs ? { diffOmitted: true } : {}),
                    additions,
                    deletions,
                };
            });
            this.post({ type: 'stagedFiles', files });
        } catch (err) {
            console.error('[AutoCommit] Failed to load staged files:', err);
            this.post({ type: 'stagedFiles', files: [] });
        }
    }

    // ─── Generation pipeline ────────────────────────────────────────────────────

    private async generate(overrideSettings?: GenerateOptions): Promise<void> {
        // A new run supersedes any retry that is still in flight.
        this.cancellation?.cancel();
        this.cancellation = new vscode.CancellationTokenSource();
        const token = this.cancellation.token;
        const runId = ++this.generationRunId;
        const isActiveRun = () => runId === this.generationRunId && !token.isCancellationRequested;

        this.generating = true;
        this.retrying = false;
        this.candidates = [];
        this.lastRun = undefined;
        this.post({ type: 'loading' });

        try {
            const repo = await GitService.getRepository(this.targetRepoUri);
            if (!isActiveRun()) { return; }
            if (!repo) {
                this.post({ type: 'error', message: 'No Git repository found. Make sure the workspace contains a git repository.' });
                return;
            }

            const gitService = new GitService(repo);
            this.currentRepoRoot = gitService.repoRoot;
            this.targetRepoUri = repo.rootUri;

            const requestedSettings = overrideSettings ?? this.effectiveSettings();
            let settings = await this.normalizeModelSetting(requestedSettings, undefined, true);
            if ((requestedSettings.model ?? '') !== (settings.model ?? '')) {
                this.post({ type: 'settings', settings });
            }

            if (settings.language === 'auto') {
                settings = { ...settings, language: await gitService.detectLanguage() };
                if (!isActiveRun()) { return; }
            }

            let diff: string;
            let generationTree: string;
            try {
                diff = await gitService.getStagedDiff();
                // Snapshot the exact index content the model is about to see;
                // commitSelected only commits this tree, never the working tree.
                generationTree = await gitService.writeIndexTree();
            } catch (err) {
                if (isActiveRun()) {
                    this.post({ type: 'error', message: `Failed to read staged diff: ${String(err)}` });
                }
                return;
            }

            if (!isActiveRun()) { return; }

            if (!diff.trim()) {
                this.post({
                    type: 'error',
                    message: 'No staged changes found. Please run git add to stage files first.',
                });
                return;
            }

            this.generationTree = generationTree;
            const changes = parseDiff(diff);
            this.fileChanges = changes;

            this.fileDiffs.clear();
            for (const change of changes) {
                this.fileDiffs.set(change.path, change.diff);
            }

            if (changes.length === 0) {
                if (isActiveRun()) {
                    this.post({ type: 'error', message: 'Could not analyse the staged changes.' });
                }
                return;
            }

            const result = await generateCommits(
                changes,
                settings,
                token,
                this.recentCommits,
                {
                    onProgress: (progress) => {
                        if (!isActiveRun()) { return; }
                        this.post({ type: 'progress', progress });
                    },
                    onGroupsPlanned: (groups) => {
                        if (!isActiveRun()) { return; }
                        this.lastRun = { groups, changes };
                        this.post({ type: 'groupsPlanned', groups });
                    },
                    onCandidate: (groupIndex, candidate) => {
                        if (!isActiveRun()) { return; }
                        this.candidates.push(candidate);
                        this.post({ type: 'addCandidate', candidate, groupIndex });
                    },
                    onGroupFailed: (group, error) => {
                        if (!isActiveRun()) { return; }
                        this.post({ type: 'groupFailed', group, message: error.message });
                    },
                    onNotice: (level, message) => {
                        if (!isActiveRun()) { return; }
                        this.post({ type: 'notice', level, message });
                    },
                    onReorder: (ids) => {
                        if (!isActiveRun()) { return; }
                        const byId = new Map(this.candidates.map((candidate) => [candidate.id, candidate]));
                        this.candidates = ids
                            .map((id) => byId.get(id))
                            .filter((candidate): candidate is CommitCandidate => candidate !== undefined);
                        this.post({ type: 'reorder', ids });
                    },
                    confirmRequests: (estimate) => this.confirmRequests(estimate),
                }
            );

            if (result.declined && isActiveRun()) {
                this.post({
                    type: 'notice',
                    level: 'info',
                    message: 'Stopped before sending generation requests.',
                });
            }
        } catch (err) {
            if (isActiveRun() && !(token.isCancellationRequested || err instanceof vscode.CancellationError)) {
                this.post({ type: 'error', message: `Generation failed: ${String(err)}` });
            }
        } finally {
            if (runId === this.generationRunId) {
                this.generating = false;
                if (!token.isCancellationRequested) { this.post({ type: 'done' }); }
            }
        }
    }

    /** Confirms a run that would send many model requests. */
    private async confirmRequests(estimate: RequestEstimate): Promise<boolean> {
        const message = estimate.stage === 'grouping'
            ? `Grouping ${this.fileChanges.length} files needs about ${estimate.requests} model requests.`
            : `Generating ${estimate.groups} commits needs about ${estimate.requests} model requests.`;
        const detail =
            'Large changes are analyzed in several requests. Each request may count toward your Copilot premium request quota.';
        const choice = await vscode.window.showWarningMessage(
            message,
            { modal: true, detail },
            'Continue'
        );
        return choice === 'Continue';
    }

    /** Regenerates one failed group from the last planned run. */
    private async retryGroup(groupIndex: number, overrideSettings?: GenerateOptions): Promise<void> {
        if (this.generating || this.retrying) { return; }

        const run = this.lastRun;
        const group = run?.groups.find((planned) => planned.index === groupIndex);
        if (!run || !group) {
            this.post({
                type: 'groupFailed',
                group: { index: groupIndex, label: '', files: [] },
                message: 'This group is no longer available. Generate again.',
            });
            return;
        }

        this.retrying = true;
        const cancellation = new vscode.CancellationTokenSource();
        this.cancellation = cancellation;
        const token = cancellation.token;

        try {
            const requestedSettings = overrideSettings ?? this.effectiveSettings();
            let settings = await this.normalizeModelSetting(requestedSettings, undefined, true);
            if ((requestedSettings.model ?? '') !== (settings.model ?? '')) {
                this.post({ type: 'settings', settings });
            }
            if (token.isCancellationRequested) { return; }

            if (settings.language === 'auto') {
                const repo = await GitService.getRepository(this.targetRepoUri);
                if (!repo) {
                    throw new Error(
                        'No Git repository found. Make sure the workspace contains a git repository.'
                    );
                }
                settings = {
                    ...settings,
                    language: await new GitService(repo).detectLanguage(),
                };
                if (token.isCancellationRequested) { return; }
            }

            const candidate = await generateForGroup(
                group,
                run.changes,
                settings,
                token,
                this.recentCommits
            );
            if (token.isCancellationRequested) { return; }

            this.candidates.push(candidate);
            this.post({ type: 'addCandidate', candidate, groupIndex: group.index });
        } catch (err) {
            if (!token.isCancellationRequested && !(err instanceof vscode.CancellationError)) {
                this.post({
                    type: 'groupFailed',
                    group,
                    message: err instanceof Error ? err.message : String(err),
                });
            }
        } finally {
            if (this.cancellation === cancellation) {
                this.retrying = false;
            }
        }
    }

    // ─── Commit execution ───────────────────────────────────────────────────────

    private async commitSelected(ids: string[], orderedCandidates?: CommitCandidate[]): Promise<void> {
        if (this.generating || this.retrying) { return; }
        // Use ordered candidates from webview if provided (user may have reordered/edited)
        const allCandidates = orderedCandidates ?? this.candidates;
        const selected = allCandidates.filter((c) => ids.includes(c.id));
        if (selected.length === 0) {
            return;
        }

        const repo = await GitService.getRepository(this.targetRepoUri);
        if (!repo) {
            this.post({ type: 'error', message: 'Git repository not found.' });
            return;
        }

        const gitService = new GitService(repo);
        this.targetRepoUri = repo.rootUri;

        try {
            await gitService.assertCommitIdentityConfigured();
            const currentTree = await gitService.writeIndexTree();
            if (!this.generationTree || currentTree !== this.generationTree) {
                this.post({
                    type: 'error',
                    message: 'The staged changes have changed since generation. Generate again before committing.',
                });
                return;
            }

            const commits = selected.map((candidate) => ({
                id: candidate.id,
                paths: resolveStagingPaths(candidate.files, this.fileChanges),
                message: candidate.message,
            }));
            const { committedIds, error } = await gitService.commitFromSnapshot(
                currentTree,
                commits
            );

            if (committedIds.length > 0) {
                this.post({ type: 'committed', count: committedIds.length, ids: committedIds });
                this.candidates = this.candidates.filter((c) => !committedIds.includes(c.id));
            }

            if (error) {
                this.post({
                    type: 'error',
                    message: `Commit failed after ${committedIds.length} commit(s): ${error.message}`,
                });
            } else {
                void vscode.window.showInformationMessage(
                    `AutoCommit: ${committedIds.length} commit${committedIds.length > 1 ? 's' : ''} created.`
                );
            }

            // Refresh staged-files panel and commit history after committing
            await this.loadStagedFiles();
            await this.loadCommitHistory();
        } catch (err) {
            this.post({
                type: 'error',
                message: err instanceof GitIdentityError
                    ? err.message
                    : `Commit failed: ${String(err)}`,
            });
        }
    }

    // ─── Helpers ────────────────────────────────────────────────────────────────

    private async sendFileDiff(filePath: string): Promise<void> {
        const content = this.fileDiffs.get(filePath);
        if (content !== undefined) {
            this.post({ type: 'diffContent', path: filePath, content });
        } else {
            const repo = await GitService.getRepository(this.targetRepoUri);
            if (!repo) { return; }
            const gitService = new GitService(repo);
            try {
                const fullDiff = await gitService.getStagedDiff();
                const changes = parseDiff(fullDiff);
                const found = changes.find((c) => c.path === filePath);
                if (found) {
                    this.post({ type: 'diffContent', path: filePath, content: found.diff });
                }
            } catch {
                // ignore
            }
        }
    }

    private async normalizeModelSetting(
        settings: GenerateOptions,
        models?: ModelInfo[],
        persistFallback = false
    ): Promise<GenerateOptions> {
        const model = settings.model ?? '';
        const normalized = { ...settings, model };
        if (!model) {
            return normalized;
        }

        const availableModels = models ?? this.availableModels ?? (await this.loadModels());
        if (!availableModels) {
            return normalized;
        }
        if (availableModels.some((available) => available.id === model)) {
            return normalized;
        }

        const fallback = { ...normalized, model: '' };
        if (persistFallback) {
            await updateSettings({ model: '' });
        }
        return fallback;
    }

    private effectiveSettings(): GenerateOptions {
        const base = getSettings();
        if (this.sessionLanguage) {
            return { ...base, language: this.sessionLanguage };
        }
        return base;
    }

    private post(msg: ExtensionMessage): void {
        void this.panel?.webview.postMessage(msg);
    }
}

// ─── Webview HTML ─────────────────────────────────────────────────────────────

function countDiffLines(diff: string): { additions: number; deletions: number } {
    let additions = 0;
    let deletions = 0;
    // Only lines before the first hunk can be +++/--- headers; after it a
    // deleted "-- comment" line is a real change.
    let inHunk = false;
    for (const line of diff.split('\n')) {
        if (line.startsWith('@@')) { inHunk = true; }
        if (!inHunk) { continue; }
        if (line.startsWith('+')) {
            additions += 1;
        } else if (line.startsWith('-')) {
            deletions += 1;
        }
    }
    return { additions, deletions };
}

function buildWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(
        vscode.Uri.joinPath(extensionUri, 'out', 'webview', 'index.js')
    );
    const styleUri = webview.asWebviewUri(
        vscode.Uri.joinPath(extensionUri, 'out', 'webview', 'index.css')
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
  <title>AutoCommit For Github Copilot</title>
  <link rel="stylesheet" href="${styleUri}">
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function getNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let nonce = '';
    for (let i = 0; i < 32; i++) {
        nonce += chars[Math.floor(Math.random() * chars.length)];
    }
    return nonce;
}
