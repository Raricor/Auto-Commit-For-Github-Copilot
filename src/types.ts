// ─── Domain types ────────────────────────────────────────────────────────────

export interface GitLogEntry {
    hash: string;
    message: string;
    author: string;
    date: string;
}

export interface FileChange {
    path: string;
    /** Previous path for a rename; both paths are required when rebuilding the index. */
    originalPath?: string;
    type: 'added' | 'modified' | 'deleted' | 'renamed';
    diff: string;
}

export type GroupType = 'source' | 'test' | 'deps' | 'config' | 'docs' | 'misc';

export interface FileGroup {
    groupType: GroupType;
    label: string;
    files: FileChange[];
}

export interface CommitCandidate {
    id: string;
    message: string;
    reason: string;
    files: string[];   // relative paths from repo root
    checked: boolean;
}

/**
 * Reasoning effort forwarded to the model. Providers ignore levels a model does not
 * support and fall back to that model's default.
 */
export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface GenerateOptions {
    conventionalCommits: boolean;
    language: string;  // 'en' | 'zh' | 'auto'
    model?: string;    // e.g. 'gpt-4o', 'claude-3.5-sonnet', ''
    prompt?: string;   // user's custom instruction
    /** Fewest commits to produce. 0 or undefined: no lower limit. */
    minCommits?: number;
    /** Most commits to produce. 0 or undefined: no upper limit. */
    maxCommits?: number;
    /** '' or undefined: use the effort configured for the model in VS Code. */
    reasoningEffort?: ReasoningEffort | '';
    /** Most model requests in flight at once (1–8). */
    concurrency?: number;
}

/** A commit-sized group decided by the grouping phase, before its message exists. */
export interface PlannedGroup {
    /** Position in grouping order; stable for the whole generation run. */
    index: number;
    label: string;
    files: string[];
}

export type GenerationStage = 'grouping' | 'generating' | 'ordering';

export interface GenerationProgress {
    stage: GenerationStage;
    /** Finished units in this stage (groups while generating, folders while pre-grouping). */
    done?: number;
    total?: number;
    /** Short human-readable detail, e.g. "1300 files pre-grouped into 17 folders". */
    detail?: string;
}

export type NoticeLevel = 'info' | 'warning';

export interface StagedFileInfo {
    path: string;
    type: string;
    /** Empty when `diffOmitted` is true; request the content with `showDiff`. */
    diff: string;
    /** Set when the staged diff is too large to send to the webview at once. */
    diffOmitted?: boolean;
    additions?: number;
    deletions?: number;
}

// ─── postMessage protocol ────────────────────────────────────────────────────

/** Messages sent from the extension host → webview */
export type ExtensionMessage =
    | { type: 'loading' }
    | { type: 'progress'; progress: GenerationProgress }
    /** Sent once grouping is final; every later candidate or failure refers to one of these groups. */
    | { type: 'groupsPlanned'; groups: PlannedGroup[] }
    | { type: 'addCandidate'; candidate: CommitCandidate; groupIndex?: number }
    /** Generation for this group failed; the webview shows a card that can be retried. */
    | { type: 'groupFailed'; group: PlannedGroup; message: string }
    /** AI commit order, first commit first. Contains the ids of all successful candidates. */
    | { type: 'reorder'; ids: string[] }
    | { type: 'notice'; level: NoticeLevel; message: string }
    | { type: 'done' }
    | { type: 'error'; message: string }
    | { type: 'committed'; count: number; ids: string[] }
    | { type: 'settings'; settings: GenerateOptions }
    | { type: 'availableModels'; models: Array<{ id: string; name: string }> }
    | { type: 'diffContent'; path: string; content: string }
    | { type: 'stagedFiles'; files: StagedFileInfo[] }
    | { type: 'commitHistory'; commits: GitLogEntry[] };

/** Messages sent from the webview → extension host */
export type WebviewMessage =
    | { type: 'ready' }
    | { type: 'updateSettings'; settings: Partial<GenerateOptions> }
    | { type: 'regenerate'; settings: GenerateOptions }
    /** Generate again for one failed group of the current run, using the current settings. */
    | { type: 'retryGroup'; groupIndex: number; settings: GenerateOptions }
    | { type: 'commit'; ids: string[]; orderedCandidates?: CommitCandidate[] }
    | { type: 'openFile'; path: string }
    | { type: 'showDiff'; path: string }
    | { type: 'cancel' }
    | { type: 'refresh' };
