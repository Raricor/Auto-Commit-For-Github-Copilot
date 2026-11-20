import * as vscode from 'vscode';
import type {
    CommitCandidate, FileChange, GenerateOptions, GenerationProgress,
    GitLogEntry, NoticeLevel, PlannedGroup,
} from '../types';
import { checkCancellation, createLinkedToken } from './cancellation';
import { createLimiter } from './concurrency';
import {
    CONFIRM_REQUEST_THRESHOLD, estimateRequests, generateGroupCandidate,
    type RequestEstimate,
} from './generation';
import { planGroups } from './grouping';
import { createModelClient, isProviderError } from './modelClient';
import { orderCandidates } from './ordering';

let _modelCache: vscode.LanguageModelChat | undefined;
let _cachedModelId: string | undefined;

/** Returns all available language models with human-readable names. */
export async function getAvailableModels(): Promise<Array<{ id: string; name: string }>> {
    // Fetch ALL models — not just copilot vendor — so the user sees
    // the same full list they get in Copilot Chat (Claude, Gemini, etc.)
    const models = await vscode.lm.selectChatModels();
    return models.map((m) => ({ id: m.id, name: m.name || m.id }));
}

/** Returns the best available Copilot model, caching the result. */
async function getModel(preferredModelId?: string): Promise<vscode.LanguageModelChat> {
    // Return cache only if the preferred model hasn't changed
    if (_modelCache && _cachedModelId === (preferredModelId ?? '')) {
        return _modelCache;
    }

    let models: vscode.LanguageModelChat[] = [];

    if (preferredModelId) {
        models = await vscode.lm.selectChatModels({ id: preferredModelId });
    }

    if (models.length === 0) {
        // Prefer gpt-4o; fall back to any available model
        models = await vscode.lm.selectChatModels({ vendor: 'copilot', family: 'gpt-4o' });
    }
    if (models.length === 0) {
        models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    }
    if (models.length === 0) {
        models = await vscode.lm.selectChatModels();
    }
    if (models.length === 0) {
        throw new Error(
            'No GitHub Copilot language model found. ' +
            'Please ensure GitHub Copilot is installed and you are signed in.'
        );
    }

    _modelCache = models[0];
    _cachedModelId = preferredModelId ?? '';
    return _modelCache;
}

/** Clears the cached model (e.g. on extension deactivation). */
export function clearModelCache(): void {
    _modelCache = undefined;
    _cachedModelId = undefined;
}

export type { RequestEstimate };

export interface GenerationEvents {
    onProgress?(progress: GenerationProgress): void;
    /** Emitted once, after grouping is final and the user accepted the estimate. */
    onGroupsPlanned?(groups: PlannedGroup[]): void;
    onCandidate?(groupIndex: number, candidate: CommitCandidate): void;
    onGroupFailed?(group: PlannedGroup, error: Error): void;
    onNotice?(level: NoticeLevel, message: string): void;
    /** AI commit order: candidate ids, first commit first. */
    onReorder?(ids: string[]): void;
    /** Asked when the estimate exceeds CONFIRM_REQUEST_THRESHOLD. Resolve false to stop. */
    confirmRequests?(estimate: RequestEstimate): Promise<boolean>;
}

export interface GenerationResult {
    groups: PlannedGroup[];
    /** Successful candidates in group order. */
    candidates: Array<{ groupIndex: number; candidate: CommitCandidate }>;
    failed: Array<{ group: PlannedGroup; error: Error }>;
    /** Candidate ids in commit order, when ordering ran. */
    order?: string[];
    /** Set when the user declined the request estimate; nothing was generated. */
    declined?: boolean;
}

export { CONFIRM_REQUEST_THRESHOLD };

// Exposed for the later ordering phase, which adds its own requests.
export { estimateRequests };

/**
 * Groups staged changes, optionally confirms the request estimate, then
 * generates every group concurrently. Provider failures abort all in-flight
 * work; output/budget failures stay local to their group.
 */
export async function generateCommits(
    changes: FileChange[],
    options: GenerateOptions,
    token: vscode.CancellationToken,
    history?: GitLogEntry[],
    events?: GenerationEvents,
): Promise<GenerationResult> {
    if (changes.length === 0) {
        return { groups: [], candidates: [], failed: [] };
    }

    const abort = createLinkedToken(token);
    const limiter = createLimiter(clampConcurrency(options.concurrency));

    try {
        checkCancellation(token);
        const model = await getModel(options.model);
        checkCancellation(token);
        // Set synchronously by the client as soon as a provider round-trip
        // fails, before queued requests can take a freed limiter slot.
        let providerError: Error | undefined;
        const client = createModelClient(model, options, abort.token, limiter, undefined, error => {
            if (token.isCancellationRequested || providerError) { return; }
            providerError = toError(error);
            abort.abort();
        });

        let groups: PlannedGroup[];
        try {
            const planned = await planGroups({
                changes,
                options,
                client,
                token: abort.token,
                confirmRequests: events?.confirmRequests,
                events: {
                    onProgress: progress => {
                        if (!token.isCancellationRequested) { events?.onProgress?.(progress); }
                    },
                    onNotice: (level, message) => {
                        if (!token.isCancellationRequested) { events?.onNotice?.(level, message); }
                    },
                },
            });
            if (planned.declined) {
                return { groups: [], candidates: [], failed: [], declined: true };
            }
            groups = planned.groups;
        } catch (error) {
            if (token.isCancellationRequested) { throw new vscode.CancellationError(); }
            throw error;
        }
        checkCancellation(token);

        const estimate = estimateRequests(groups, changes, client.budget, 'generation');
        if (estimate.requests > CONFIRM_REQUEST_THRESHOLD && events?.confirmRequests) {
            const accepted = await events.confirmRequests(estimate);
            checkCancellation(token);
            if (!accepted) {
                return { groups: [], candidates: [], failed: [], declined: true };
            }
        }

        if (!token.isCancellationRequested) { events?.onGroupsPlanned?.(groups); }

        const candidates: Array<{ groupIndex: number; candidate: CommitCandidate }> = [];
        const failed: Array<{ group: PlannedGroup; error: Error }> = [];
        let done = 0;
        const total = groups.length;

        const recordFailure = (group: PlannedGroup, error: Error): void => {
            failed.push({ group, error });
            if (!token.isCancellationRequested) { events?.onGroupFailed?.(group, error); }
        };
        const recordDone = (): void => {
            done += 1;
            if (!token.isCancellationRequested) {
                events?.onProgress?.({ stage: 'generating', done, total });
            }
        };

        const tasks = groups.map(group => (async (): Promise<void> => {
            try {
                if (providerError) {
                    recordFailure(group, providerError);
                    return;
                }
                checkCancellation(abort.token);
                const candidate = await generateGroupCandidate({
                    group,
                    changes,
                    options,
                    history,
                    client,
                    token: abort.token,
                });
                checkCancellation(token);
                candidates.push({ groupIndex: group.index, candidate });
                if (!token.isCancellationRequested) {
                    events?.onCandidate?.(group.index, candidate);
                }
            } catch (error) {
                if (token.isCancellationRequested) {
                    throw new vscode.CancellationError();
                }
                if (providerError) {
                    recordFailure(group, providerError);
                    return;
                }
                const failure = toError(error);
                if (isProviderError(failure) && !(failure instanceof vscode.CancellationError)) {
                    // Abort every other in-flight request, then report this
                    // original error to all groups that could not finish.
                    providerError = failure;
                    abort.abort();
                    recordFailure(group, failure);
                    return;
                }
                if (failure instanceof vscode.CancellationError) {
                    // Without a provider error this is a user cancellation.
                    throw failure;
                }
                recordFailure(group, failure);
            } finally {
                recordDone();
            }
        })());

        await Promise.all(tasks);
        if (providerError) { throw providerError; }

        candidates.sort((a, b) => a.groupIndex - b.groupIndex);
        failed.sort((a, b) => a.group.index - b.group.index);

        let order: string[] | undefined;
        if (candidates.length >= 2) {
            checkCancellation(token);
            order = await orderCandidates({
                entries: candidates,
                client,
                token,
                events: {
                    onProgress: progress => {
                        if (!token.isCancellationRequested) { events?.onProgress?.(progress); }
                    },
                    onNotice: (level, message) => {
                        if (!token.isCancellationRequested) { events?.onNotice?.(level, message); }
                    },
                    onReorder: ids => {
                        if (!token.isCancellationRequested) { events?.onReorder?.(ids); }
                    },
                },
            });
        }

        return order
            ? { groups, candidates, failed, order }
            : { groups, candidates, failed };
    } finally {
        abort.dispose();
    }
}

/** Regenerates one group (used for retrying a failed card). */
export async function generateForGroup(
    group: PlannedGroup,
    changes: FileChange[],
    options: GenerateOptions,
    token: vscode.CancellationToken,
    history?: GitLogEntry[],
): Promise<CommitCandidate> {
    const abort = createLinkedToken(token);
    try {
        checkCancellation(token);
        const model = await getModel(options.model);
        checkCancellation(token);
        const limiter = createLimiter(clampConcurrency(options.concurrency));
        const client = createModelClient(model, options, abort.token, limiter, undefined, () => abort.abort());
        return await generateGroupCandidate({
            group, changes, options, history, client, token: abort.token,
        });
    } finally {
        abort.dispose();
    }
}

function clampConcurrency(value: number | undefined): number {
    const requested = value ?? 4;
    const safe = Number.isFinite(requested) ? requested : 4;
    return Math.max(1, Math.min(8, Math.floor(safe)));
}

function toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}
