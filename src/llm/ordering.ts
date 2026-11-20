import * as vscode from 'vscode';
import type { CommitCandidate, GenerationProgress, NoticeLevel } from '../types';
import { checkCancellation } from './cancellation';
import { findJsonValue, stripThinking } from './jsonExtract';
import type { ModelClient } from './modelClient';
import { isProviderError } from './modelClient';
import { buildOrderingPrompt, type OrderingItem } from './promptBuilder';

export interface OrderingEntry {
    groupIndex: number;
    candidate: CommitCandidate;
}

export interface OrderingEvents {
    onProgress?(progress: GenerationProgress): void;
    onNotice?(level: NoticeLevel, message: string): void;
    /** Emitted with candidate ids in commit order, first commit first. */
    onReorder?(ids: string[]): void;
}

export interface OrderCandidatesArgs {
    entries: OrderingEntry[];
    client: ModelClient;
    token: vscode.CancellationToken;
    events?: OrderingEvents;
}

interface CandidateSlot {
    key: string;
    candidate: CommitCandidate;
}

/**
 * Reorders successful candidates with one extra model request. Ordering is
 * best-effort: provider/output/budget failures keep the generated order, while
 * cancellation still aborts the whole run.
 */
export async function orderCandidates(args: OrderCandidatesArgs): Promise<string[] | undefined> {
    const { entries, client, token, events } = args;
    if (entries.length < 2) { return undefined; }

    checkCancellation(token);
    events?.onProgress?.({ stage: 'ordering' });

    const slots: CandidateSlot[] = entries.map((entry, index) => ({
        key: `c${index + 1}`,
        candidate: entry.candidate,
    }));
    const items: OrderingItem[] = slots.map(slot => ({
        id: slot.key,
        message: slot.candidate.message,
        reason: slot.candidate.reason,
        files: slot.candidate.files,
    }));

    // Shrink optional evidence before giving up: ids, messages and reasons are
    // required for a meaningful order, file lists are not.
    let prompt: string | undefined;
    for (const fileLimit of [8, 3, 0]) {
        const candidate = buildOrderingPrompt(items, fileLimit);
        const fits = await guard(() => client.fits(candidate), token, events);
        if (!fits.ok) { return undefined; }
        if (fits.value) {
            prompt = candidate;
            break;
        }
    }
    if (!prompt) {
        events?.onNotice?.(
            'info',
            'AI ordering was skipped because the request cannot fit the model input budget; kept the generated order.',
        );
        return undefined;
    }

    let request = await requestOrder(prompt, client, token, events);
    if (request.status === 'failed') { return undefined; }
    if (request.status === 'invalid') {
        const retryPrompt = `${prompt}\n\nYour previous reply could not be used: ` +
            'The reply was not a JSON array of candidate ids. Reply with ONLY the JSON array of ids.';
        const fits = await guard(() => client.fits(retryPrompt), token, events);
        if (!fits.ok) { return undefined; }
        if (!fits.value) {
            events?.onNotice?.('info', 'Could not determine a commit order; kept the generated order.');
            return undefined;
        }
        request = await requestOrder(retryPrompt, client, token, events);
        if (request.status !== 'ok') {
            events?.onNotice?.('info', 'Could not determine a commit order; kept the generated order.');
            return undefined;
        }
    }

    checkCancellation(token);
    const ordered = repairOrder(request.keys, slots);
    const ids = ordered.map(slot => slot.candidate.id);
    events?.onReorder?.(ids);
    return ids;
}

type OrderRequest =
    | { status: 'ok'; keys: string[] }
    | { status: 'invalid' }
    | { status: 'failed' };

async function requestOrder(
    prompt: string,
    client: ModelClient,
    token: vscode.CancellationToken,
    events?: OrderingEvents,
): Promise<OrderRequest> {
    const response = await guard(() => client.send(prompt), token, events);
    if (!response.ok) { return { status: 'failed' }; }
    const keys = parseOrder(response.value);
    return keys === null ? { status: 'invalid' } : { status: 'ok', keys };
}

type Guarded<T> = { ok: true; value: T } | { ok: false };

async function guard<T>(
    operation: () => Promise<T>,
    token: vscode.CancellationToken,
    events?: OrderingEvents,
): Promise<Guarded<T>> {
    try {
        return { ok: true, value: await operation() };
    } catch (error) {
        if (token.isCancellationRequested || error instanceof vscode.CancellationError) {
            throw new vscode.CancellationError();
        }
        if (isProviderError(error)) {
            const message = error instanceof Error ? error.message : String(error);
            events?.onNotice?.(
                'warning',
                `AI commit ordering failed (${message}); kept the generated order.`,
            );
            return { ok: false };
        }
        throw error;
    }
}

function parseOrder(raw: string): string[] | null {
    return findJsonValue(stripThinking(raw), '[', ']', value => {
        if (!Array.isArray(value) || value.length === 0) { return null; }
        if (!value.every(item => typeof item === 'string')) { return null; }
        return value as string[];
    });
}

/**
 * Unknown ids are ignored, duplicate ids keep their first position, and ids
 * the model omitted are appended in their generated order.
 */
function repairOrder(keys: string[], slots: CandidateSlot[]): CandidateSlot[] {
    const byKey = new Map(slots.map(slot => [slot.key, slot]));
    const seen = new Set<string>();
    const ordered: CandidateSlot[] = [];

    for (const rawKey of keys) {
        const key = rawKey.trim();
        const slot = byKey.get(key);
        if (!slot || seen.has(key)) { continue; }
        seen.add(key);
        ordered.push(slot);
    }
    for (const slot of slots) {
        if (!seen.has(slot.key)) { ordered.push(slot); }
    }
    return ordered;
}
