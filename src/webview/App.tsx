import { Check, ChevronDown, ChevronRight, GitCommit, RotateCw, Sparkles, Square } from 'lucide-react';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { GenerateOptions } from '../types';
import CandidatesList from './components/CandidatesList';
import CommitHistory from './components/CommitHistory';
import FileChanges from './components/FileChanges';
import GenerationProgress from './components/GenerationProgress';
import Notices from './components/Notices';
import SettingsPanel from './components/SettingsPanel';
import {
    canSubmit,
    checkedCount,
    commitPayload,
    hasRetryingSlots,
    initialState,
    isCommitBusy,
    orderedCandidates,
    reducer,
    slotKey,
} from './state';
import type { Slot } from './state';
import { useFlip } from './useFlip';
import { onMessage, postMessage } from './vscodeApi';

export default function App() {
    const [state, dispatch] = useReducer(reducer, initialState);
    const listRef = useRef<HTMLDivElement | null>(null);

    const displaySlots = useMemo(() => [...state.slots].reverse(), [state.slots]);
    const displayKeys = useMemo(() => displaySlots.map(slotKey), [displaySlots]);
    const { capture } = useFlip(displayKeys, listRef);

    useEffect(() => {
        const cleanup = onMessage((msg) => {
            switch (msg.type) {
                case 'loading':
                    dispatch({ type: 'SET_LOADING' });
                    break;
                case 'progress':
                    dispatch({ type: 'PROGRESS', progress: msg.progress });
                    break;
                case 'groupsPlanned':
                    dispatch({ type: 'GROUPS_PLANNED', groups: msg.groups });
                    break;
                case 'addCandidate':
                    dispatch({ type: 'ADD_CANDIDATE', candidate: msg.candidate, groupIndex: msg.groupIndex });
                    break;
                case 'groupFailed':
                    dispatch({ type: 'GROUP_FAILED', group: msg.group, message: msg.message });
                    break;
                case 'reorder':
                    // Measure the old order before React applies the new one.
                    capture();
                    dispatch({ type: 'AI_REORDER', ids: msg.ids });
                    break;
                case 'notice':
                    dispatch({ type: 'NOTICE', level: msg.level, message: msg.message });
                    break;
                case 'done':
                    dispatch({ type: 'DONE' });
                    break;
                case 'error':
                    dispatch({ type: 'ERROR', message: msg.message });
                    break;
                case 'committed':
                    dispatch({ type: 'COMMITTED', count: msg.count, ids: msg.ids });
                    break;
                case 'settings':
                    dispatch({ type: 'SET_SETTINGS', settings: msg.settings });
                    break;
                case 'availableModels':
                    dispatch({ type: 'SET_MODELS', models: msg.models });
                    break;
                case 'stagedFiles':
                    dispatch({ type: 'SET_STAGED_FILES', files: msg.files });
                    break;
                case 'commitHistory':
                    dispatch({ type: 'SET_COMMIT_HISTORY', commits: msg.commits });
                    break;
                case 'diffContent':
                    dispatch({ type: 'SET_DIFF_CONTENT', path: msg.path, content: msg.content });
                    break;
            }
        });

        postMessage({ type: 'ready' });
        return cleanup;
    }, [capture]);

    const badgeToken = state.reorderBadges?.token;
    useEffect(() => {
        if (badgeToken === undefined) return;
        const timer = window.setTimeout(() => dispatch({ type: 'CLEAR_REORDER_BADGES' }), 2500);
        return () => window.clearTimeout(timer);
    }, [badgeToken]);

    const handleGenerate = useCallback(() => {
        if (state.committing) {
            return;
        }
        dispatch({ type: 'ERROR', message: '' }); // clear error
        postMessage({
            type: 'regenerate',
            settings: {
                ...state.settings,
                prompt: state.prompt,
            },
        });
    }, [state.settings, state.prompt, state.committing]);

    const handleCommit = useCallback(() => {
        if (!canSubmit(state)) {
            return;
        }
        const { ids, orderedCandidates: ordered } = commitPayload(state);
        if (ids.length > 0) {
            dispatch({ type: 'SET_COMMITTING', committing: true });
            postMessage({ type: 'commit', ids, orderedCandidates: ordered });
        }
    }, [state]);

    const handleCommitOne = useCallback((id: string) => {
        if (isCommitBusy(state)) {
            return;
        }
        const slot = state.slots.find((s) => s.status === 'ready' && s.candidate?.id === id);
        if (!slot) {
            return;
        }
        dispatch({ type: 'SET_COMMITTING', committing: true });
        postMessage({ type: 'commit', ids: [id], orderedCandidates: orderedCandidates(state) });
    }, [state]);

    const handleRetryGroup = useCallback((groupIndex: number) => {
        dispatch({ type: 'RETRY_GROUP', groupIndex });
        postMessage({
            type: 'retryGroup',
            groupIndex,
            settings: { ...state.settings, prompt: state.prompt },
        });
    }, [state.settings, state.prompt]);

    const handleUndoReorder = useCallback(() => {
        capture();
        dispatch({ type: 'UNDO_REORDER' });
    }, [capture]);

    const handleOpenFile = useCallback((path: string) => {
        postMessage({ type: 'openFile', path });
    }, []);

    const handleShowDiff = useCallback((path: string) => {
        postMessage({ type: 'showDiff', path });
    }, []);

    const handleToggleCandidate = useCallback((id: string) => {
        dispatch({ type: 'TOGGLE_CANDIDATE', id });
    }, []);

    const handleUpdateSetting = useCallback((key: string, value: unknown) => {
        dispatch({ type: 'UPDATE_SETTING', key, value });
        postMessage({
            type: 'updateSettings',
            settings: { [key]: value } as Partial<GenerateOptions>,
        });
    }, []);

    const handleSetPrompt = useCallback((prompt: string) => {
        dispatch({ type: 'SET_PROMPT', prompt });
    }, []);

    const handleReorderSlots = useCallback((slots: Slot[]) => {
        dispatch({ type: 'REORDER_SLOTS', slots });
    }, []);

    const handleUpdateMessage = useCallback((id: string, message: string) => {
        dispatch({ type: 'UPDATE_CANDIDATE_MESSAGE', id, message });
    }, []);

    const handleDismissNotice = useCallback((id: number) => {
        dispatch({ type: 'DISMISS_NOTICE', id });
    }, []);

    const handleStop = useCallback(() => {
        postMessage({ type: 'cancel' });
    }, []);

    const handleRefresh = useCallback(() => {
        postMessage({ type: 'refresh' });
    }, []);

    const [commitsExpanded, setCommitsExpanded] = useState(true);
    const checked = checkedCount(state);
    const hasStaged = state.stagedFiles.length > 0;
    const showCandidates = state.slots.length > 0;
    const ordering = state.generating && state.progress?.stage === 'ordering';
    const commitBusy = isCommitBusy(state);
    const retrying = hasRetryingSlots(state);

    return (
        <div className="app">
            <div className="main-content">
                {/* Left Panel - Config / Actions / Commits */}
                <div className="left-panel">
                    {/* Collapsible Configuration */}
                    <SettingsPanel
                        settings={state.settings}
                        models={state.models}
                        prompt={state.prompt}
                        onUpdate={handleUpdateSetting}
                        onPromptChange={handleSetPrompt}
                    />

                    {/* Action Buttons */}
                    <div className="action-buttons">
                        {state.generating ? (
                            <button className="btn-stop" onClick={handleStop}>
                                <Square size={14} />
                                Stop Generating
                            </button>
                        ) : (
                            <button
                                className="btn-generate"
                                disabled={!hasStaged || state.committing}
                                onClick={handleGenerate}
                            >
                                <Sparkles size={16} />
                                Generate Commits
                            </button>
                        )}
                        {showCandidates && !state.generating && (
                            <button className="btn-regen" disabled={state.committing} onClick={handleGenerate}>
                                <RotateCw size={16} />
                                Regenerate
                            </button>
                        )}
                    </div>

                    {/* Error */}
                    {state.error && state.error.length > 0 && (
                        <div className="error-banner">
                            <p>{state.error}</p>
                            <button className="error-retry-btn" onClick={handleGenerate}>Retry</button>
                        </div>
                    )}

                    {/* Informational and warning notices */}
                    <Notices notices={state.notices} onDismiss={handleDismissNotice} />

                    {/* Success */}
                    {state.success && <div className="success-banner">{state.success}</div>}

                    {/* Generation progress */}
                    {state.generating && <GenerationProgress progress={state.progress} />}

                    {/* Generated Commits */}
                    {showCandidates && (
                        <div className="panel-card">
                            <button
                                className="panel-toggle"
                                onClick={() => setCommitsExpanded(!commitsExpanded)}
                            >
                                <div className="panel-toggle-left">
                                    <GitCommit size={16} />
                                    <span>Generated Commits</span>
                                    <span className="panel-toggle-count">({state.slots.length})</span>
                                    {ordering && (
                                        <span className="ordering-indicator">
                                            <span className="spinner spinner-xs" />
                                            <span>Ordering…</span>
                                        </span>
                                    )}
                                </div>
                                <div className="panel-toggle-right">
                                    {commitsExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                                </div>
                            </button>

                            {commitsExpanded && (
                                <div className="panel-body commits-body">
                                    <div className="section-divider">
                                        Pending ({state.slots.length})
                                    </div>
                                    <CandidatesList
                                        slots={state.slots}
                                        moves={state.reorderBadges?.moves ?? {}}
                                        showAiReorder={state.aiReorder !== null}
                                        onUndoReorder={handleUndoReorder}
                                        onToggle={handleToggleCandidate}
                                        onOpenFile={handleOpenFile}
                                        onReorder={handleReorderSlots}
                                        onUpdateMessage={handleUpdateMessage}
                                        onCommitOne={handleCommitOne}
                                        onRetryGroup={handleRetryGroup}
                                        commitDisabled={commitBusy}
                                        listRef={listRef}
                                    />
                                    <button
                                        className="btn-commit-all"
                                        disabled={!canSubmit(state)}
                                        onClick={handleCommit}
                                    >
                                        <Check size={16} />
                                        Commit Selected ({checked})
                                    </button>
                                </div>
                            )}
                        </div>
                    )}

                    {/* Retry-in-progress hint while commits are blocked */}
                    {retrying && !state.generating && (
                        <div className="retrying-hint">Waiting for the failed group to finish retrying…</div>
                    )}

                    {/* Commit History */}
                    {state.commitHistory.length > 0 && (
                        <CommitHistory commits={state.commitHistory} />
                    )}
                </div>

                {/* Right Panel - File Changes */}
                <div className="right-panel">
                    <FileChanges
                        files={state.stagedFiles}
                        loading={state.stagedLoading}
                        onRefresh={handleRefresh}
                        diffCache={state.diffCache}
                        onShowDiff={handleShowDiff}
                    />
                </div>
            </div>
        </div>
    );
}
