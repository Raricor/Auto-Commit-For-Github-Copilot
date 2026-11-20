import { useMemo } from 'react';
import type { StagedFileInfo } from '../../types';
import { flattenVisible } from '../fileTree';
import type { FileStats, TreeFile, TreeFolder } from '../fileTree';
import DiffTable from './DiffTable';
import FileIcon from './FileIcon';

interface Props {
    root: TreeFolder;
    expandedFolders: Set<string>;
    onToggleFolder: (path: string) => void;
    expandedFiles: Set<string>;
    diffCache: Record<string, string>;
    onToggleFile: (file: StagedFileInfo) => void;
}

/** Shared with the flat list so both views color file names the same way. */
export function fileStatusClass(file: StagedFileInfo): string {
    switch (file.type) {
        case 'added':
            return 'file-status-added';
        case 'deleted':
            return 'file-status-deleted';
        case 'renamed':
            return 'file-status-renamed';
        default:
            return 'file-status-modified';
    }
}

function statusLetter(file: StagedFileInfo): string {
    switch (file.type) {
        case 'added':
            return 'A';
        case 'deleted':
            return 'D';
        case 'renamed':
            return 'R';
        default:
            return 'M';
    }
}

/** Shared with the flat list so both views end with the same status letter. */
export function FileStatusLetter({ file }: { file: StagedFileInfo }) {
    return <span className={`file-status-letter ${fileStatusClass(file)}`}>{statusLetter(file)}</span>;
}

/** Shared with the flat list so both views render identical stats and bars. */
export function FileStatsView({ stats }: { stats: FileStats }) {
    const total = stats.additions + stats.deletions;
    const addRatio = total > 0 ? stats.additions / total : 0;
    const filledBars = Math.round(addRatio * 10);

    return (
        <span className="file-row-stats">
            {stats.additions > 0 && <span className="stat-add">+{stats.additions}</span>}
            {stats.deletions > 0 && <span className="stat-del">-{stats.deletions}</span>}
            <span className="viz-bar">
                {Array.from({ length: 10 }).map((_, index) => {
                    let cls = 'viz-seg empty';
                    if (total > 0) {
                        cls = index < filledBars ? 'viz-seg add' : 'viz-seg del';
                    }
                    return <span key={index} className={cls} />;
                })}
            </span>
        </span>
    );
}

function IndentGuides({ depth }: { depth: number }) {
    if (depth === 0) {
        return null;
    }

    return (
        <span className="file-tree-indent" aria-hidden="true">
            {Array.from({ length: depth }).map((_, index) => (
                <span key={index} className="file-tree-guide" />
            ))}
        </span>
    );
}

function FolderRow({
    node,
    depth,
    expanded,
    onToggle,
}: {
    node: TreeFolder;
    depth: number;
    expanded: boolean;
    onToggle: (path: string) => void;
}) {
    return (
        <div className="file-row" role="none">
            <button
                type="button"
                className="file-tree-row"
                role="treeitem"
                aria-expanded={expanded}
                title={node.path}
                onClick={() => onToggle(node.path)}
            >
                <IndentGuides depth={depth} />
                <span className="file-tree-row-content">
                    <span
                        className={`file-tree-chevron codicon ${
                            expanded ? 'codicon-chevron-down' : 'codicon-chevron-right'
                        }`}
                        aria-hidden="true"
                    />
                    <span className="file-tree-name">{node.name}</span>
                    <span className="file-tree-count">
                        {node.fileCount} {node.fileCount === 1 ? 'file' : 'files'}
                    </span>
                    <span className="file-row-stats">
                        {node.stats.additions > 0 && <span className="stat-add">+{node.stats.additions}</span>}
                        {node.stats.deletions > 0 && <span className="stat-del">-{node.stats.deletions}</span>}
                    </span>
                </span>
            </button>
        </div>
    );
}

function FileRow({
    node,
    depth,
    expanded,
    diffCache,
    onToggle,
}: {
    node: TreeFile;
    depth: number;
    expanded: boolean;
    diffCache: Record<string, string>;
    onToggle: (file: StagedFileInfo) => void;
}) {
    const file = node.file;
    const cachedDiff = diffCache[file.path];
    const waitingForDiff = file.diffOmitted === true && cachedDiff === undefined;
    const diffContent = cachedDiff !== undefined ? cachedDiff : file.diff;

    return (
        <div className="file-row" role="none">
            <button
                type="button"
                className="file-tree-row"
                role="treeitem"
                aria-expanded={expanded}
                onClick={() => onToggle(file)}
            >
                <IndentGuides depth={depth} />
                <span className="file-tree-row-content">
                    <span className="file-tree-file-spacer" aria-hidden="true" />
                    <FileIcon name={node.name} />
                    <span className={`file-tree-name ${fileStatusClass(file)}`} title={file.path}>
                        {node.name}
                    </span>
                    <FileStatsView stats={node.stats} />
                    <FileStatusLetter file={file} />
                </span>
            </button>
            {expanded && (
                <div className="file-row-diff">
                    {waitingForDiff ? (
                        <div className="diff-loading">
                            <span className="spinner spinner-xs" />
                            <span>Loading diff…</span>
                        </div>
                    ) : (
                        <DiffTable content={diffContent} />
                    )}
                </div>
            )}
        </div>
    );
}

export default function FileTree({
    root,
    expandedFolders,
    onToggleFolder,
    expandedFiles,
    diffCache,
    onToggleFile,
}: Props) {
    const rows = useMemo(
        () => flattenVisible(root, expandedFolders),
        [root, expandedFolders]
    );

    return (
        <div className="file-tree" role="tree">
            {rows.map(({ node, depth }) => (
                node.kind === 'folder' ? (
                    <FolderRow
                        key={`folder:${node.path}`}
                        node={node}
                        depth={depth}
                        expanded={expandedFolders.has(node.path)}
                        onToggle={onToggleFolder}
                    />
                ) : (
                    <FileRow
                        key={`file:${node.path}`}
                        node={node}
                        depth={depth}
                        expanded={expandedFiles.has(node.path)}
                        diffCache={diffCache}
                        onToggle={onToggleFile}
                    />
                )
            ))}
        </div>
    );
}
