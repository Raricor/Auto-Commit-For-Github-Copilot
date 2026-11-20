import { useEffect, useMemo, useRef, useState } from 'react';
import type { StagedFileInfo } from '../../types';
import {
    allFolderPaths,
    buildFileTree,
    defaultExpanded,
    mergeExpanded,
} from '../fileTree';
import type { FileStats, TreeFolder } from '../fileTree';
import { getState, setState } from '../vscodeApi';
import DiffTable from './DiffTable';
import FileIcon from './FileIcon';
import FileTree, { FileStatsView, FileStatusLetter, fileStatusClass } from './FileTree';

interface Props {
    files: StagedFileInfo[];
    loading: boolean;
    onRefresh?: () => void;
    diffCache: Record<string, string>;
    onShowDiff: (path: string) => void;
}

type FileView = 'tree' | 'list';

function readFileView(): FileView {
    const state = getState();
    if (typeof state === 'object' && state !== null && !Array.isArray(state)) {
        const view = (state as Record<string, unknown>).fileView;
        if (view === 'tree' || view === 'list') {
            return view;
        }
    }
    return 'tree';
}

/** Merges the view choice into any state the webview already persists. */
function persistFileView(view: FileView): void {
    const state = getState();
    const base = typeof state === 'object' && state !== null && !Array.isArray(state)
        ? state as Record<string, unknown>
        : {};
    setState({ ...base, fileView: view });
}

interface HeaderProps {
    fileCount: number;
    stats: FileStats;
    view: FileView;
    showDetails: boolean;
    onRefresh?: () => void;
    onSelectView: (view: FileView) => void;
    onExpandAll: () => void;
    onCollapseAll: () => void;
}

function FileChangesHeader({
    fileCount,
    stats,
    view,
    showDetails,
    onRefresh,
    onSelectView,
    onExpandAll,
    onCollapseAll,
}: HeaderProps) {
    return (
        <div className="file-changes-header">
            <div className="file-changes-title">
                <span>File Changes</span>
                {showDetails && (
                    <span className="file-changes-count">
                        {fileCount} {fileCount === 1 ? 'file' : 'files'}
                    </span>
                )}
            </div>
            <div className="file-changes-stats">
                {showDetails && (
                    <>
                        <span className="stat-add">+{stats.additions}</span>
                        <span className="stat-del">-{stats.deletions}</span>
                    </>
                )}
                {showDetails && (
                    <div className="file-changes-actions">
                        {view === 'tree' && (
                            <>
                                <button
                                    type="button"
                                    className="action-btn"
                                    title="Expand all"
                                    onClick={onExpandAll}
                                >
                                    <span className="codicon codicon-expand-all" aria-hidden="true" />
                                </button>
                                <button
                                    type="button"
                                    className="action-btn"
                                    title="Collapse all"
                                    onClick={onCollapseAll}
                                >
                                    <span className="codicon codicon-collapse-all" aria-hidden="true" />
                                </button>
                            </>
                        )}
                        <button
                            type="button"
                            className={`action-btn${view === 'tree' ? ' active' : ''}`}
                            title="Tree view"
                            aria-pressed={view === 'tree'}
                            onClick={() => onSelectView('tree')}
                        >
                            <span className="codicon codicon-list-tree" aria-hidden="true" />
                        </button>
                        <button
                            type="button"
                            className={`action-btn${view === 'list' ? ' active' : ''}`}
                            title="List view"
                            aria-pressed={view === 'list'}
                            onClick={() => onSelectView('list')}
                        >
                            <span className="codicon codicon-list-flat" aria-hidden="true" />
                        </button>
                    </div>
                )}
                {onRefresh && (
                    <button
                        type="button"
                        className="action-btn"
                        title="Refresh staged files"
                        onClick={onRefresh}
                    >
                        <span className="codicon codicon-refresh" aria-hidden="true" />
                    </button>
                )}
            </div>
        </div>
    );
}

export default function FileChanges({ files, loading, onRefresh, diffCache, onShowDiff }: Props) {
    const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
    const [view, setView] = useState<FileView>(readFileView);
    const root = useMemo(() => buildFileTree(files), [files]);
    const [expandedFolders, setExpandedFolders] = useState<Set<string>>(
        () => defaultExpanded(root, files.length)
    );
    const previousRoot = useRef<TreeFolder | null>(null);

    useEffect(() => {
        setExpandedFolders(previous => mergeExpanded(previous, previousRoot.current, root, files.length));
        previousRoot.current = root;
    }, [root, files.length]);

    const statsByPath = useMemo(() => {
        const map = new Map<string, FileStats>();
        const visit = (folder: TreeFolder): void => {
            for (const child of folder.children) {
                if (child.kind === 'file') {
                    map.set(child.path, child.stats);
                } else {
                    visit(child);
                }
            }
        };
        visit(root);
        return map;
    }, [root]);

    const toggleFile = (file: StagedFileInfo) => {
        const isExpanded = expandedFiles.has(file.path);
        if (!isExpanded && file.diffOmitted && diffCache[file.path] === undefined) {
            onShowDiff(file.path);
        }
        setExpandedFiles(prev => {
            const next = new Set(prev);
            if (next.has(file.path)) next.delete(file.path);
            else next.add(file.path);
            return next;
        });
    };

    const toggleFolder = (path: string) => {
        setExpandedFolders(prev => {
            const next = new Set(prev);
            if (next.has(path)) next.delete(path);
            else next.add(path);
            return next;
        });
    };

    const selectView = (next: FileView) => {
        if (next === view) {
            return;
        }
        setView(next);
        persistFileView(next);
    };

    const expandAll = () => {
        setExpandedFolders(new Set(allFolderPaths(root)));
    };

    const collapseAll = () => {
        setExpandedFolders(new Set());
    };

    if (loading) {
        return (
            <div className="file-changes">
                <FileChangesHeader
                    fileCount={0}
                    stats={{ additions: 0, deletions: 0 }}
                    view={view}
                    showDetails={false}
                    onRefresh={onRefresh}
                    onSelectView={selectView}
                    onExpandAll={expandAll}
                    onCollapseAll={collapseAll}
                />
                <div className="loading-wrap">
                    <div className="spinner" />
                    <span>Loading staged changes…</span>
                </div>
            </div>
        );
    }

    if (files.length === 0) {
        return (
            <div className="file-changes">
                <FileChangesHeader
                    fileCount={0}
                    stats={{ additions: 0, deletions: 0 }}
                    view={view}
                    showDetails={false}
                    onRefresh={onRefresh}
                    onSelectView={selectView}
                    onExpandAll={expandAll}
                    onCollapseAll={collapseAll}
                />
                <div className="empty-state">
                    <p>No staged changes found.</p>
                    <p style={{ marginTop: 6 }}>
                        Run <code>git add &lt;files&gt;</code> to stage files first.
                    </p>
                </div>
            </div>
        );
    }

    return (
        <div className="file-changes">
            <FileChangesHeader
                fileCount={files.length}
                stats={root.stats}
                view={view}
                showDetails
                onRefresh={onRefresh}
                onSelectView={selectView}
                onExpandAll={expandAll}
                onCollapseAll={collapseAll}
            />
            <div className="file-changes-body">
                {view === 'tree' ? (
                    <FileTree
                        root={root}
                        expandedFolders={expandedFolders}
                        onToggleFolder={toggleFolder}
                        expandedFiles={expandedFiles}
                        diffCache={diffCache}
                        onToggleFile={toggleFile}
                    />
                ) : (
                    files.map(file => {
                        const isExpanded = expandedFiles.has(file.path);
                        const fileStats = statsByPath.get(file.path) ?? { additions: 0, deletions: 0 };
                        const cachedDiff = diffCache[file.path];
                        const waitingForDiff = file.diffOmitted === true && cachedDiff === undefined;
                        const diffContent = cachedDiff !== undefined ? cachedDiff : file.diff;
                        const slash = file.path.lastIndexOf('/');
                        const name = slash === -1 ? file.path : file.path.slice(slash + 1);
                        const directory = slash === -1 ? '' : file.path.slice(0, slash + 1);

                        return (
                            <div key={file.path} className="file-row">
                                <button
                                    type="button"
                                    className="file-row-header"
                                    onClick={() => toggleFile(file)}
                                >
                                    <span
                                        className={`file-row-chevron codicon ${
                                            isExpanded ? 'codicon-chevron-down' : 'codicon-chevron-right'
                                        }`}
                                        aria-hidden="true"
                                    />
                                    <FileIcon name={name} />
                                    <span className={`file-row-name ${fileStatusClass(file)}`}>{name}</span>
                                    {directory && (
                                        <span className="file-row-dir" title={file.path}>{directory}</span>
                                    )}
                                    <FileStatsView stats={fileStats} />
                                    <FileStatusLetter file={file} />
                                </button>
                                {isExpanded && (
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
                    })
                )}
            </div>
        </div>
    );
}
