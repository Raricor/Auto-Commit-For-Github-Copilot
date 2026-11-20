import type { StagedFileInfo } from '../types';

export interface FileStats {
    additions: number;
    deletions: number;
}

export interface TreeFile {
    kind: 'file';
    path: string;
    name: string;
    file: StagedFileInfo;
    stats: FileStats;
}

export interface TreeFolder {
    kind: 'folder';
    /** Full directory path, also used as the expansion-state key. */
    path: string;
    /** Display name; a merged single-child chain joins the names with "/". */
    name: string;
    children: TreeNode[];
    /** Number of files in this subtree. */
    fileCount: number;
    /** Sum of the additions/deletions in this subtree. */
    stats: FileStats;
}

export type TreeNode = TreeFolder | TreeFile;

const EMPTY_STATS: FileStats = { additions: 0, deletions: 0 };

/**
 * Counts changed lines from the first hunk onward. Before the first "@@" only
 * the "+++"/"---" file headers can start with +/-; inside a hunk a deleted
 * "-- comment" line is a real change. Mirrors the host's countDiffLines.
 */
export function countDiffStats(diff: string): FileStats {
    let additions = 0;
    let deletions = 0;
    let inHunk = false;

    for (const line of diff.split('\n')) {
        if (!inHunk) {
            if (!line.startsWith('@@')) {
                continue;
            }
            inHunk = true;
        }
        if (line.startsWith('+')) {
            additions += 1;
        } else if (line.startsWith('-')) {
            deletions += 1;
        }
    }

    return { additions, deletions };
}

/** Uses host-provided counts when present and falls back to parsing the diff. */
export function statsForFile(file: StagedFileInfo): FileStats {
    if (file.additions !== undefined && file.deletions !== undefined) {
        return { additions: file.additions, deletions: file.deletions };
    }

    const counted = countDiffStats(file.diff ?? '');
    return {
        additions: file.additions ?? counted.additions,
        deletions: file.deletions ?? counted.deletions,
    };
}

function compareNames(a: string, b: string): number {
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

function sortChildren(folder: TreeFolder): void {
    folder.children.sort((a, b) => {
        if (a.kind !== b.kind) {
            return a.kind === 'folder' ? -1 : 1;
        }
        return compareNames(a.name, b.name);
    });

    for (const child of folder.children) {
        if (child.kind === 'folder') {
            sortChildren(child);
        }
    }
}

/**
 * Collapses a directory that has exactly one subdirectory and no direct files
 * into that subdirectory. The merged node keeps the deepest path and joins the
 * display names, e.g. "src" + "webview" + "components" -> "src/webview/components".
 */
function mergeSingleChildChains(folder: TreeFolder): void {
    for (const child of folder.children) {
        if (child.kind === 'folder') {
            mergeSingleChildChains(child);
        }
    }

    while (folder.path !== '') {
        const folders = folder.children.filter((child): child is TreeFolder => child.kind === 'folder');
        const hasDirectFile = folder.children.some((child) => child.kind === 'file');
        if (hasDirectFile || folders.length !== 1) {
            break;
        }

        const only = folders[0];
        folder.name = `${folder.name}/${only.name}`;
        folder.path = only.path;
        folder.children = only.children;
    }
}

function computeAggregates(folder: TreeFolder): { fileCount: number; stats: FileStats } {
    let fileCount = 0;
    let additions = 0;
    let deletions = 0;

    for (const child of folder.children) {
        if (child.kind === 'file') {
            fileCount += 1;
            additions += child.stats.additions;
            deletions += child.stats.deletions;
        } else {
            const childTotals = computeAggregates(child);
            fileCount += childTotals.fileCount;
            additions += childTotals.stats.additions;
            deletions += childTotals.stats.deletions;
        }
    }

    folder.fileCount = fileCount;
    folder.stats = { additions, deletions };
    return { fileCount, stats: folder.stats };
}

/** Builds a virtual root folder (path "") containing the staged files. */
export function buildFileTree(files: StagedFileInfo[]): TreeFolder {
    const root: TreeFolder = {
        kind: 'folder',
        path: '',
        name: '',
        children: [],
        fileCount: 0,
        stats: { ...EMPTY_STATS },
    };

    for (const file of files) {
        const segments = file.path.split('/').filter((segment) => segment.length > 0);
        if (segments.length === 0) {
            continue;
        }

        let folder = root;
        for (let index = 0; index < segments.length - 1; index += 1) {
            const name = segments[index];
            let child = folder.children.find(
                (candidate): candidate is TreeFolder => candidate.kind === 'folder' && candidate.name === name
            );
            if (child === undefined) {
                child = {
                    kind: 'folder',
                    path: folder.path === '' ? name : `${folder.path}/${name}`,
                    name,
                    children: [],
                    fileCount: 0,
                    stats: { ...EMPTY_STATS },
                };
                folder.children.push(child);
            }
            folder = child;
        }

        const name = segments[segments.length - 1];
        folder.children.push({
            kind: 'file',
            path: file.path,
            name,
            file,
            stats: statsForFile(file),
        });
    }

    mergeSingleChildChains(root);
    sortChildren(root);
    computeAggregates(root);
    return root;
}

/** Returns every real folder path, excluding the virtual root. */
export function allFolderPaths(root: TreeFolder): string[] {
    const paths: string[] = [];

    const visit = (folder: TreeFolder): void => {
        for (const child of folder.children) {
            if (child.kind === 'folder') {
                paths.push(child.path);
                visit(child);
            }
        }
    };

    visit(root);
    return paths;
}

/**
 * Small changes open fully; large changes open only the first level so the
 * tree stays readable when thousands of files are staged.
 */
export function defaultExpanded(root: TreeFolder, totalFiles: number): Set<string> {
    if (totalFiles <= 30) {
        return new Set(allFolderPaths(root));
    }

    const firstLevel = root.children
        .filter((child): child is TreeFolder => child.kind === 'folder')
        .map((child) => child.path);
    return new Set(firstLevel);
}

/** Returns only the rows currently visible with the given folders expanded. */
export function flattenVisible(
    root: TreeFolder,
    expanded: Set<string>
): Array<{ node: TreeNode; depth: number }> {
    const rows: Array<{ node: TreeNode; depth: number }> = [];

    const visit = (folder: TreeFolder, depth: number): void => {
        for (const child of folder.children) {
            rows.push({ node: child, depth });
            if (child.kind === 'folder' && expanded.has(child.path)) {
                visit(child, depth + 1);
            }
        }
    };

    visit(root, 0);
    return rows;
}

/**
 * Keeps existing folders exactly as the user left them, applies the default
 * state to folders that just appeared, and drops folders that disappeared.
 */
export function mergeExpanded(
    previous: Set<string>,
    previousRoot: TreeFolder | null,
    nextRoot: TreeFolder,
    totalFiles: number
): Set<string> {
    const previousPaths = new Set(previousRoot === null ? [] : allFolderPaths(previousRoot));
    const nextPaths = allFolderPaths(nextRoot);
    const defaults = defaultExpanded(nextRoot, totalFiles);
    const merged = new Set<string>();

    for (const path of nextPaths) {
        if (previousPaths.has(path)) {
            if (previous.has(path)) {
                merged.add(path);
            }
        } else if (defaults.has(path)) {
            merged.add(path);
        }
    }

    return merged;
}
