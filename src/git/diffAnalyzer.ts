import * as path from 'path';
import type { FileChange, FileGroup, GroupType } from '../types';

// ─── Diff parser ─────────────────────────────────────────────────────────────

/** Parses a raw `git diff --cached` output into individual FileChange objects. */
export function parseDiff(rawDiff: string): FileChange[] {
    const results: FileChange[] = [];
    // Each file diff starts with "diff --git a/... b/..."
    const segments = rawDiff.split(/^(?=diff --git )/m).filter(Boolean);

    for (const segment of segments) {
        const headerEnd = segment.indexOf('\n');
        const header = (headerEnd === -1 ? segment : segment.slice(0, headerEnd)).replace(/\r$/, '');
        if (!header.startsWith('diff --git ')) {
            continue;
        }

        let filePath: string | undefined;
        let type: FileChange['type'] = 'modified';
        let originalPath: string | undefined;

        const renameFrom = segment.match(/^rename from (.+)$/m);
        const renameTo = segment.match(/^rename to (.+)$/m);
        const copyFrom = segment.match(/^copy from (.+)$/m);
        const copyTo = segment.match(/^copy to (.+)$/m);

        if (renameFrom && renameTo) {
            // A rename header has two different paths, so read both from the
            // dedicated lines instead of trying to split the header.
            type = 'renamed';
            originalPath = decodeDiffPath(renameFrom[1]);
            filePath = decodeDiffPath(renameTo[1]);
        } else if (copyFrom && copyTo) {
            // Copies behave like additions: only the destination path is staged.
            type = 'added';
            filePath = decodeDiffPath(copyTo[1]);
        } else {
            filePath = parseHeaderPath(header);
            if (filePath === undefined) {
                continue;
            }
            if (/^new file mode/m.test(segment)) {
                type = 'added';
            } else if (/^deleted file mode/m.test(segment)) {
                type = 'deleted';
            }
        }

        results.push({ path: filePath, originalPath, type, diff: segment });
    }

    return results;
}

/**
 * Extracts the path from a `diff --git` header. For non-rename/non-copy
 * entries both sides are identical, so the unquoted form can be split by
 * length instead of searching for the ` b/` separator (a path may itself
 * contain that sequence).
 */
function parseHeaderPath(header: string): string | undefined {
    const unquotedPrefix = 'diff --git a/';
    if (header.startsWith(unquotedPrefix)) {
        const remainder = header.slice(unquotedPrefix.length);
        const separatorLength = 3; // " b/"
        const pathLength = (remainder.length - separatorLength) / 2;
        if (!Number.isInteger(pathLength) || pathLength <= 0) {
            return undefined;
        }
        const aPath = remainder.slice(0, pathLength);
        const bPath = remainder.slice(pathLength + separatorLength);
        return aPath === bPath ? aPath : undefined;
    }

    // Git quotes a path when it contains quotes/control characters; with
    // core.quotePath=false non-ASCII bytes stay literal inside those quotes.
    const quoted = header.match(/^diff --git "a\/((?:[^"\\]|\\.)+)" "b\/((?:[^"\\]|\\.)+)"$/);
    if (!quoted) {
        return undefined;
    }
    const aPath = unescapeGitQuotedPath(quoted[1]);
    const bPath = unescapeGitQuotedPath(quoted[2]);
    return aPath === bPath ? bPath : undefined;
}

/** Expands renamed files to both pathspecs needed to stage the complete rename. */
export function resolveStagingPaths(files: string[], changes: FileChange[]): string[] {
    const changesByPath = new Map(changes.map((change) => [change.path, change]));
    const paths = new Set<string>();

    for (const file of files) {
        const change = changesByPath.get(file);
        if (change?.type === 'renamed' && change.originalPath) {
            paths.add(change.originalPath);
        }
        paths.add(file);
    }

    return [...paths];
}

function decodeDiffPath(value: string): string {
    return value.startsWith('"') && value.endsWith('"')
        ? unescapeGitQuotedPath(value.slice(1, -1))
        : value;
}

/**
 * Decodes a git "quoted" path, where non-ASCII bytes appear as `\NNN` octal
 * escapes and a few characters use C-style escapes (\\, \", \t, \n, \r).
 * The decoded byte sequence is interpreted as UTF-8.
 */
function unescapeGitQuotedPath(s: string): string {
    const bytes: number[] = [];
    const cEscapes: Record<string, number> = {
        '"': 0x22, '\\': 0x5c, t: 0x09, n: 0x0a, r: 0x0d, b: 0x08, f: 0x0c, a: 0x07, v: 0x0b,
    };
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (ch === '\\' && i + 3 < s.length && /[0-3]/.test(s[i + 1]) && /[0-7]/.test(s[i + 2]) && /[0-7]/.test(s[i + 3])) {
            bytes.push(parseInt(s.substr(i + 1, 3), 8));
            i += 3;
        } else if (ch === '\\' && i + 1 < s.length && cEscapes[s[i + 1]] !== undefined) {
            bytes.push(cEscapes[s[i + 1]]);
            i += 1;
        } else {
            // core.quotePath=false leaves non-ASCII characters literal even
            // when the path is quoted for another reason (e.g. a double quote).
            const codePoint = s.codePointAt(i)!;
            if (codePoint < 0x80) {
                bytes.push(codePoint);
            } else {
                bytes.push(...new TextEncoder().encode(String.fromCodePoint(codePoint)));
                if (codePoint > 0xffff) {
                    i += 1;
                }
            }
        }
    }
    return new TextDecoder('utf-8').decode(Uint8Array.from(bytes));
}

// ─── File grouper ─────────────────────────────────────────────────────────────

/** Groups FileChange[] into FileGroup[] so each group → one LLM call → one commit. */
export function groupFiles(changes: FileChange[]): FileGroup[] {
    const map = new Map<string, FileGroup>();

    for (const change of changes) {
        const key = classifyFile(change.path);

        if (!map.has(key.groupKey)) {
            map.set(key.groupKey, {
                groupType: key.type,
                label: key.label,
                files: [],
            });
        }

        map.get(key.groupKey)!.files.push(change);
    }

    return Array.from(map.values());
}

// ─── Classification helpers ──────────────────────────────────────────────────

interface Classification {
    groupKey: string;
    type: GroupType;
    label: string;
}

/** Priority-ordered rules that assign a file to exactly one group. */
function classifyFile(filePath: string): Classification {
    const fileName = path.posix.basename(filePath);
    const ext = path.posix.extname(filePath).toLowerCase();
    const parts = filePath.split('/');

    // 1. Dependency lock / manifest files
    if (
        /^(package\.json|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|npm-shrinkwrap\.json|requirements\.txt|Pipfile|Pipfile\.lock|Cargo\.toml|Cargo\.lock|go\.mod|go\.sum|composer\.json|composer\.lock|Gemfile|Gemfile\.lock|pyproject\.toml|poetry\.lock)$/.test(
            fileName
        )
    ) {
        return { groupKey: 'deps', type: 'deps', label: 'deps' };
    }

    // 2. Test files
    if (
        /\.(test|spec)\.[jt]sx?$/.test(fileName) ||
        parts.some((p) => p === '__tests__' || p === 'test' || p === 'tests' || p === '__test__' || p === 'e2e')
    ) {
        return { groupKey: 'test', type: 'test', label: 'test' };
    }

    // 3. Config files
    if (
        /\.(config|rc)\.[jt]sx?$/.test(fileName) ||
        /^\.env/.test(fileName) ||
        ['.yaml', '.yml', '.toml', '.ini', '.editorconfig'].includes(ext) ||
        /^(tsconfig.*|jest\.config.*|vite\.config.*|webpack\.config.*|babel\.config.*|\.eslintrc.*|\.prettierrc.*|\.stylelintrc.*|\.babelrc.*)$/.test(
            fileName
        )
    ) {
        return { groupKey: 'config', type: 'config', label: 'config' };
    }

    // 4. Documentation
    if (['.md', '.mdx', '.rst', '.txt', '.adoc'].includes(ext) || parts[0] === 'docs' || parts[0] === 'doc') {
        return { groupKey: 'docs', type: 'docs', label: 'docs' };
    }

    // 5. Source files — group by top-level directory
    if (parts.length > 1) {
        const topDir = parts[0];
        return { groupKey: `source:${topDir}`, type: 'source', label: `source: ${topDir}/` };
    }

    // 6. Root-level miscellaneous files
    return { groupKey: 'misc', type: 'misc', label: 'misc' };
}
