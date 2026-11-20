import type {
    CommitCandidate,
    GenerateOptions,
    GenerationProgress,
    GitLogEntry,
    NoticeLevel,
    PlannedGroup,
    StagedFileInfo,
} from '../types';

export type SlotStatus = 'pending' | 'ready' | 'failed' | 'retrying';

/** One planned commit. Array order is the commit order (first commit first). */
export interface Slot {
    groupIndex: number;
    label: string;
    files: string[];
    status: SlotStatus;
    candidate?: CommitCandidate;
    error?: string;
}

export interface Notice {
    id: number;
    level: NoticeLevel;
    message: string;
}

/** Badge data for the most recent AI order change; cleared after a short delay. */
export interface ReorderBadges {
    moves: Record<string, number>;
    token: number;
}

/** The order to restore if the user clicks Undo. */
export interface AiReorder {
    previous: Slot[];
}

export interface AppState {
    generating: boolean;
    committing: boolean;
    slots: Slot[];
    progress: GenerationProgress | null;
    notices: Notice[];
    error: string | null;
    success: string | null;
    models: Array<{ id: string; name: string }>;
    settings: GenerateOptions;
    prompt: string;
    commitHistory: GitLogEntry[];
    stagedFiles: StagedFileInfo[];
    stagedLoading: boolean;
    /** Diff content fetched on demand for files whose diff was omitted. */
    diffCache: Record<string, string>;
    aiReorder: AiReorder | null;
    reorderBadges: ReorderBadges | null;
    noticeSeq: number;
    badgeSeq: number;
    legacySeq: number;
}

export type Action =
    | { type: 'SET_LOADING' }
    | { type: 'SET_COMMITTING'; committing: boolean }
    | { type: 'GROUPS_PLANNED'; groups: PlannedGroup[] }
    | { type: 'ADD_CANDIDATE'; candidate: CommitCandidate; groupIndex?: number }
    | { type: 'GROUP_FAILED'; group: PlannedGroup; message: string }
    | { type: 'RETRY_GROUP'; groupIndex: number }
    | { type: 'AI_REORDER'; ids: string[] }
    | { type: 'UNDO_REORDER' }
    | { type: 'REORDER_SLOTS'; slots: Slot[] }
    | { type: 'CLEAR_REORDER_BADGES' }
    | { type: 'DONE' }
    | { type: 'ERROR'; message: string }
    | { type: 'PROGRESS'; progress: GenerationProgress }
    | { type: 'NOTICE'; level: NoticeLevel; message: string }
    | { type: 'DISMISS_NOTICE'; id: number }
    | { type: 'COMMITTED'; count: number; ids: string[] }
    | { type: 'SET_SETTINGS'; settings: GenerateOptions }
    | { type: 'SET_MODELS'; models: Array<{ id: string; name: string }> }
    | { type: 'SET_STAGED_FILES'; files: StagedFileInfo[] }
    | { type: 'SET_DIFF_CONTENT'; path: string; content: string }
    | { type: 'TOGGLE_CANDIDATE'; id: string }
    | { type: 'SET_PROMPT'; prompt: string }
    | { type: 'UPDATE_SETTING'; key: string; value: unknown }
    | { type: 'SET_COMMIT_HISTORY'; commits: GitLogEntry[] }
    | { type: 'UPDATE_CANDIDATE_MESSAGE'; id: string; message: string };

export const initialState: AppState = {
    generating: false,
    committing: false,
    slots: [],
    progress: null,
    notices: [],
    error: null,
    success: null,
    models: [],
    settings: { conventionalCommits: true, language: 'en' },
    prompt: '',
    commitHistory: [],
    stagedFiles: [],
    stagedLoading: true,
    diffCache: {},
    aiReorder: null,
    reorderBadges: null,
    noticeSeq: 0,
    badgeSeq: 0,
    legacySeq: 0,
};

/** Stable identity for a slot, used as the React key and for FLIP measurement. */
export function slotKey(slot: Slot): string {
    return slot.candidate ? `candidate:${slot.candidate.id}` : `group:${slot.groupIndex}`;
}

function pendingSlot(group: PlannedGroup): Slot {
    return {
        groupIndex: group.index,
        label: group.label,
        files: group.files,
        status: 'pending',
    };
}

function updateCandidateSlot(state: AppState, id: string, update: (c: CommitCandidate) => CommitCandidate): AppState {
    return {
        ...state,
        slots: state.slots.map((slot) =>
            slot.candidate?.id === id
                ? { ...slot, candidate: update(slot.candidate) }
                : slot
        ),
    };
}

/**
 * How many display positions each key moved. Keys are in commit order (first
 * commit first) while the UI renders them reversed, so a card that moves later
 * in commit order moves up on screen. Positive values mean upward movement.
 */
export function computeDisplayMoves(previousKeys: string[], nextKeys: string[]): Record<string, number> {
    const previousIndex = new Map<string, number>();
    previousKeys.forEach((key, index) => previousIndex.set(key, index));

    const moves: Record<string, number> = {};
    nextKeys.forEach((key, index) => {
        const oldIndex = previousIndex.get(key);
        if (oldIndex === undefined) return;
        // UI shows last commit at the top, so display index is the reverse index.
        const oldDisplay = previousKeys.length - 1 - oldIndex;
        const newDisplay = nextKeys.length - 1 - index;
        const delta = oldDisplay - newDisplay;
        if (delta !== 0) moves[key] = delta;
    });
    return moves;
}

/** Badge movement for candidate ids only; pending/failed slots move but show no badge. */
export function computeReorderMoves(previous: Slot[], next: Slot[]): Record<string, number> {
    const moves = computeDisplayMoves(previous.map(slotKey), next.map(slotKey));
    const result: Record<string, number> = {};
    for (const slot of next) {
        const key = slotKey(slot);
        if (slot.candidate && moves[key]) result[slot.candidate.id] = moves[key];
    }
    return result;
}

export function orderedCandidates(state: AppState): CommitCandidate[] {
    const result: CommitCandidate[] = [];
    for (const slot of state.slots) {
        if (slot.status === 'ready' && slot.candidate) result.push(slot.candidate);
    }
    return result;
}

export function selectedIds(state: AppState): string[] {
    return orderedCandidates(state).filter((candidate) => candidate.checked).map((candidate) => candidate.id);
}

export function checkedCount(state: AppState): number {
    return selectedIds(state).length;
}

export function hasRetryingSlots(state: AppState): boolean {
    return state.slots.some((slot) => slot.status === 'retrying');
}

export function isCommitBusy(state: AppState): boolean {
    return state.generating || state.committing || hasRetryingSlots(state);
}

export function canSubmit(state: AppState): boolean {
    return !isCommitBusy(state) && selectedIds(state).length > 0;
}

export function commitPayload(state: AppState): { orderedCandidates: CommitCandidate[]; ids: string[] } {
    const ordered = orderedCandidates(state);
    return {
        orderedCandidates: ordered,
        ids: ordered.filter((candidate) => candidate.checked).map((candidate) => candidate.id),
    };
}

export function reducer(state: AppState, action: Action): AppState {
    switch (action.type) {
        case 'SET_LOADING':
            return {
                ...state,
                generating: true,
                committing: false,
                slots: [],
                progress: { stage: 'grouping' },
                notices: [],
                error: null,
                success: null,
                aiReorder: null,
                reorderBadges: null,
                legacySeq: 0,
            };
        case 'SET_COMMITTING':
            return { ...state, committing: action.committing, error: null, success: null };
        case 'GROUPS_PLANNED': {
            const groups = [...action.groups].sort((a, b) => a.index - b.index);
            return { ...state, slots: groups.map(pendingSlot) };
        }
        case 'ADD_CANDIDATE': {
            if (action.groupIndex === undefined) {
                const groupIndex = -1 - state.legacySeq;
                return {
                    ...state,
                    legacySeq: state.legacySeq + 1,
                    slots: [
                        ...state.slots,
                        {
                            groupIndex,
                            label: '',
                            files: action.candidate.files,
                            status: 'ready',
                            candidate: action.candidate,
                        },
                    ],
                };
            }

            const index = state.slots.findIndex((slot) => slot.groupIndex === action.groupIndex);
            if (index === -1) {
                return {
                    ...state,
                    slots: [
                        ...state.slots,
                        {
                            groupIndex: action.groupIndex,
                            label: '',
                            files: action.candidate.files,
                            status: 'ready',
                            candidate: action.candidate,
                        },
                    ],
                };
            }

            return {
                ...state,
                slots: state.slots.map((slot, i) =>
                    i === index
                        ? {
                            ...slot,
                            files: action.candidate.files,
                            status: 'ready',
                            candidate: action.candidate,
                            error: undefined,
                        }
                        : slot
                ),
            };
        }
        case 'GROUP_FAILED': {
            const index = state.slots.findIndex((slot) => slot.groupIndex === action.group.index);
            if (index === -1) {
                return {
                    ...state,
                    slots: [
                        ...state.slots,
                        {
                            groupIndex: action.group.index,
                            label: action.group.label,
                            files: action.group.files,
                            status: 'failed',
                            error: action.message,
                        },
                    ],
                };
            }
            return {
                ...state,
                slots: state.slots.map((slot, i) =>
                    i === index
                        ? {
                            ...slot,
                            label: action.group.label,
                            files: action.group.files,
                            status: 'failed',
                            candidate: undefined,
                            error: action.message,
                        }
                        : slot
                ),
            };
        }
        case 'RETRY_GROUP':
            return {
                ...state,
                slots: state.slots.map((slot) =>
                    slot.groupIndex === action.groupIndex
                        ? { ...slot, status: 'retrying', candidate: undefined, error: undefined }
                        : slot
                ),
            };
        case 'AI_REORDER': {
            const byId = new Map<string, Slot>();
            for (const slot of state.slots) {
                if (slot.candidate) byId.set(slot.candidate.id, slot);
            }

            const front: Slot[] = [];
            const used = new Set<string>();
            for (const id of action.ids) {
                const slot = byId.get(id);
                if (!slot || used.has(id)) continue;
                used.add(id);
                front.push(slot);
            }

            const next = [...front, ...state.slots.filter((slot) => {
                const id = slot.candidate?.id;
                return !id || !used.has(id);
            })];
            // The AI kept the generated order: no banner, no Undo, no badges.
            if (next.every((slot, i) => slot === state.slots[i])) return state;

            return {
                ...state,
                slots: next,
                aiReorder: { previous: state.slots },
                reorderBadges: {
                    moves: computeReorderMoves(state.slots, next),
                    token: state.badgeSeq + 1,
                },
                badgeSeq: state.badgeSeq + 1,
            };
        }
        case 'UNDO_REORDER': {
            if (!state.aiReorder) return state;
            const current = new Map(state.slots.map((slot) => [slotKey(slot), slot]));
            const restored: Slot[] = [];
            for (const slot of state.aiReorder.previous) {
                const key = slotKey(slot);
                const live = current.get(key);
                if (live) {
                    restored.push(live);
                    current.delete(key);
                }
            }
            // Keep any slot that appeared after the AI reorder.
            for (const slot of state.slots) {
                if (current.has(slotKey(slot))) restored.push(slot);
            }
            return {
                ...state,
                slots: restored,
                aiReorder: null,
                reorderBadges: {
                    moves: computeReorderMoves(state.slots, restored),
                    token: state.badgeSeq + 1,
                },
                badgeSeq: state.badgeSeq + 1,
            };
        }
        case 'REORDER_SLOTS':
            return { ...state, slots: action.slots, aiReorder: null, reorderBadges: null };
        case 'CLEAR_REORDER_BADGES':
            return { ...state, reorderBadges: null };
        case 'DONE':
            return { ...state, generating: false, progress: null };
        case 'ERROR':
            return { ...state, generating: false, committing: false, progress: null, error: action.message };
        case 'PROGRESS':
            return { ...state, progress: action.progress };
        case 'NOTICE':
            return {
                ...state,
                noticeSeq: state.noticeSeq + 1,
                notices: [...state.notices, { id: state.noticeSeq + 1, level: action.level, message: action.message }],
            };
        case 'DISMISS_NOTICE':
            return { ...state, notices: state.notices.filter((notice) => notice.id !== action.id) };
        case 'COMMITTED':
            return {
                ...state,
                committing: false,
                slots: state.slots.filter((slot) => !slot.candidate || !action.ids.includes(slot.candidate.id)),
                success: `${action.count} commit${action.count > 1 ? 's' : ''} created successfully.`,
            };
        case 'SET_SETTINGS':
            return { ...state, settings: action.settings };
        case 'SET_MODELS':
            return { ...state, models: action.models };
        case 'SET_STAGED_FILES':
            return { ...state, stagedFiles: action.files, stagedLoading: false, diffCache: {} };
        case 'SET_DIFF_CONTENT':
            return { ...state, diffCache: { ...state.diffCache, [action.path]: action.content } };
        case 'TOGGLE_CANDIDATE':
            return updateCandidateSlot(state, action.id, (candidate) => ({ ...candidate, checked: !candidate.checked }));
        case 'SET_PROMPT':
            return { ...state, prompt: action.prompt };
        case 'UPDATE_SETTING':
            return { ...state, settings: { ...state.settings, [action.key]: action.value } };
        case 'SET_COMMIT_HISTORY':
            return { ...state, commitHistory: action.commits };
        case 'UPDATE_CANDIDATE_MESSAGE':
            return updateCandidateSlot(state, action.id, (candidate) => ({ ...candidate, message: action.message }));
        default:
            return state;
    }
}
