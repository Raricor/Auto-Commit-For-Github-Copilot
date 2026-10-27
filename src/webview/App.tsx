import { Check, ChevronDown, ChevronRight, GitCommit, RotateCw, Sparkles, Square } from 'lucide-react';
import { useCallback, useEffect, useReducer, useState } from 'react';
import type { CommitCandidate, GenerateOptions, GitLogEntry } from '../types';
import CandidatesList from './components/CandidatesList';
import CommitHistory from './components/CommitHistory';
import FileChanges from './components/FileChanges';
import SettingsPanel from './components/SettingsPanel';
import { onMessage, postMessage } from './vscodeApi';

interface StagedFile {
    path: string;
    type: string;
    diff: string;
}

interface AppState {
    generating: boolean;
    committing: boolean;
    candidates: CommitCandidate[];
    stagedFiles: StagedFile[];
    stagedLoading: boolean;
    error: string | null;
    success: string | null;
    models: Array<{ id: string; name: string }>;
    settings: GenerateOptions;
    prompt: string;
    commitHistory: GitLogEntry[];
}

type Action =
    | { type: 'SET_LOADING' }
    | { type: 'SET_COMMITTING'; committing: boolean }
    | { type: 'ADD_CANDIDATE'; candidate: CommitCandidate }
    | { type: 'DONE' }
    | { type: 'ERROR'; message: string }
    | { type: 'COMMITTED'; count: number; ids: string[] }
    | { type: 'SET_SETTINGS'; settings: GenerateOptions }
    | { type: 'SET_MODELS'; models: Array<{ id: string; name: string }> }
    | { type: 'SET_STAGED_FILES'; files: StagedFile[] }
    | { type: 'TOGGLE_CANDIDATE'; id: string }
    | { type: 'SET_PROMPT'; prompt: string }
    | { type: 'UPDATE_SETTING'; key: string; value: unknown }
    | { type: 'SET_COMMIT_HISTORY'; commits: GitLogEntry[] }
    | { type: 'REORDER_CANDIDATES'; candidates: CommitCandidate[] }
    | { type: 'UPDATE_CANDIDATE_MESSAGE'; id: string; message: string };

const initialState: AppState = {
    generating: false,
    committing: false,
    candidates: [],
    stagedFiles: [],
    stagedLoading: true,
    error: null,
    success: null,
    models: [],
    settings: { conventionalCommits: true, language: 'en' },
    prompt: '',
    commitHistory: [],
};

function reducer(state: AppState, action: Action): AppState {
    switch (action.type) {
        case 'SET_LOADING':
            return { ...state, generating: true, candidates: [], error: null, success: null };
        case 'SET_COMMITTING':
            return { ...state, committing: action.committing, error: null, success: null };
        case 'ADD_CANDIDATE':
            return { ...state, candidates: [...state.candidates, action.candidate] };
        case 'DONE':
            return { ...state, generating: false };
        case 'ERROR':
            return { ...state, generating: false, committing: false, error: action.message };
        case 'COMMITTED':
            return {
                ...state,
                committing: false,
                candidates: state.candidates.filter((c) => !action.ids.includes(c.id)),
                success: `${action.count} commit${action.count > 1 ? 's' : ''} created successfully.`,
            };
        case 'SET_SETTINGS':
            return { ...state, settings: action.settings };
        case 'SET_MODELS':
            return { ...state, models: action.models };
        case 'SET_STAGED_FILES':
            return { ...state, stagedFiles: action.files, stagedLoading: false };
        case 'TOGGLE_CANDIDATE':
            return {
                ...state,
                candidates: state.candidates.map((c) =>
                    c.id === action.id ? { ...c, checked: !c.checked } : c
                ),
            };
        case 'SET_PROMPT':
            return { ...state, prompt: action.prompt };
        case 'UPDATE_SETTING':
            return { ...state, settings: { ...state.settings, [action.key]: action.value } };
        case 'SET_COMMIT_HISTORY':
            return { ...state, commitHistory: action.commits };
        case 'REORDER_CANDIDATES':
            return { ...state, candidates: action.candidates };
        case 'UPDATE_CANDIDATE_MESSAGE':
            return {
                ...state,
                candidates: state.candidates.map((c) =>
                    c.id === action.id ? { ...c, message: action.message } : c
                ),
            };
        default:
            return state;
    }
}

export default function App() {
    const [state, dispatch] = useReducer(reducer, initialState);

    useEffect(() => {
        const cleanup = onMessage((msg) => {
            switch (msg.type) {
                case 'loading':
                    dispatch({ type: 'SET_LOADING' });
                    break;
                case 'addCandidate':
                    dispatch({ type: 'ADD_CANDIDATE', candidate: msg.candidate });
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
            }
        });

        postMessage({ type: 'ready' });
        return cleanup;
    }, []);

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
        if (state.committing || state.generating) {
            return;
        }
        const ids = state.candidates.filter((c) => c.checked).map((c) => c.id);
        if (ids.length > 0) {
            dispatch({ type: 'SET_COMMITTING', committing: true });
            postMessage({ type: 'commit', ids, orderedCandidates: state.candidates });
        }
    }, [state.candidates, state.committing, state.generating]);

    const handleCommitOne = useCallback((id: string) => {
        if (state.committing || state.generating || !state.candidates.some((c) => c.id === id)) {
            return;
        }
        dispatch({ type: 'SET_COMMITTING', committing: true });
        postMessage({ type: 'commit', ids: [id], orderedCandidates: state.candidates });
    }, [state.candidates, state.committing, state.generating]);

    const handleOpenFile = useCallback((path: string) => {
        postMessage({ type: 'openFile', path });
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

    const handleReorderCandidates = useCallback((candidates: CommitCandidate[]) => {
        dispatch({ type: 'REORDER_CANDIDATES', candidates });
    }, []);

    const handleUpdateMessage = useCallback((id: string, message: string) => {
        dispatch({ type: 'UPDATE_CANDIDATE_MESSAGE', id, message });
    }, []);

    const handleStop = useCallback(() => {
        postMessage({ type: 'cancel' });
    }, []);

    const handleRefresh = useCallback(() => {
        postMessage({ type: 'refresh' });
    }, []);

    const [commitsExpanded, setCommitsExpanded] = useState(true);
    const checkedCount = state.candidates.filter((c) => c.checked).length;
    const hasStaged = state.stagedFiles.length > 0;
    const showCandidates = state.candidates.length > 0;

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

                    {/* Success */}
                    {state.success && <div className="success-banner">{state.success}</div>}

                    {/* Generating spinner */}
                    {state.generating && (
                        <div className="loading-wrap">
                            <div className="spinner" />
                            <span>Grouping changes and generating commits...</span>
                        </div>
                    )}

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
                                    <span className="panel-toggle-count">({state.candidates.length})</span>
                                </div>
                                <div className="panel-toggle-right">
                                    {commitsExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                                </div>
                            </button>

                            {commitsExpanded && (
                                <div className="panel-body commits-body">
                                    <div className="section-divider">
                                        Pending ({state.candidates.length})
                                    </div>
                                    <CandidatesList
                                        candidates={state.candidates}
                                        onToggle={handleToggleCandidate}
                                        onOpenFile={handleOpenFile}
                                        onReorder={handleReorderCandidates}
                                        onUpdateMessage={handleUpdateMessage}
                                        onCommitOne={handleCommitOne}
                                        commitDisabled={state.committing || state.generating}
                                    />
                                    <button
                                        className="btn-commit-all"
                                        disabled={checkedCount === 0 || state.committing || state.generating}
                                        onClick={handleCommit}
                                    >
                                        <Check size={16} />
                                        Commit Selected ({checkedCount})
                                    </button>
                                </div>
                            )}
                        </div>
                    )}

                    {/* Commit History */}
                    {state.commitHistory.length > 0 && (
                        <CommitHistory commits={state.commitHistory} />
                    )}
                </div>

                {/* Right Panel - File Changes */}
                <div className="right-panel">
                    <FileChanges files={state.stagedFiles} loading={state.stagedLoading} onRefresh={handleRefresh} />
                </div>
            </div>
        </div>
    );
}
