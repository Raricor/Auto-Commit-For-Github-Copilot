import type * as vscode from 'vscode';
import type {
    CommitCandidate, FileChange, FileGroup, GenerateOptions, GitLogEntry, PlannedGroup,
} from '../types';
import { checkCancellation } from './cancellation';
import { isStatsOnly } from './fileKinds';
import { findJsonValue, stripThinking } from './jsonExtract';
import type { ModelClient } from './modelClient';
import {
    buildPrompt, buildSummaryPrompt, type EvidencePart,
} from './promptBuilder';
import { InputBudgetError, statsOnlyEvidence } from './promptBudget';

/** A per-group failure caused by the model's output, not by the provider. */
export class GroupOutputError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'GroupOutputError';
    }
}

export interface RequestEstimate {
    groups: number;
    requests: number;
    /** 'grouping': asked before folder-batch grouping; groups is then the number of batches. */
    stage: 'grouping' | 'generation';
}

/** Ask the user before a run that would send this many model requests. */
export const CONFIRM_REQUEST_THRESHOLD = 40;

export interface GenerateGroupArgs {
    group: PlannedGroup;
    changes: FileChange[];
    options: GenerateOptions;
    history?: GitLogEntry[];
    client: ModelClient;
    token: vscode.CancellationToken;
}

/** Generates one candidate, retrying once on unusable output. */
export async function generateGroupCandidate(args: GenerateGroupArgs): Promise<CommitCandidate> {
    const { group, changes, options, history, client, token } = args;
    checkCancellation(token);

    const byPath = new Map(changes.map(change => [change.path, change]));
    const files = group.files
        .map(filePath => byPath.get(filePath))
        .filter((file): file is FileChange => file !== undefined);
    if (files.length !== group.files.length) {
        throw new GroupOutputError('The group refers to a file that is no longer staged.');
    }

    const fileGroup: FileGroup = { groupType: 'misc', label: group.label, files };
    const fullPrompt = buildPrompt(fileGroup, options, history);
    if (await client.fits(fullPrompt)) {
        return requestCandidate(client, token, group, fullPrompt);
    }

    // Instructions and the file manifest must fit even without evidence.
    if (!await client.fits(buildPrompt(fileGroup, options, history, ''))) {
        throw new InputBudgetError();
    }

    const regular = files.filter(file => !isStatsOnly(file.path));
    const statsEvidence = files
        .filter(file => isStatsOnly(file.path))
        .map(statsOnlyEvidence)
        .join('\n\n');

    let summary = '';
    if (regular.length > 0) {
        const parts: EvidencePart[] = regular.map(file => ({
            path: file.path, type: file.type, offset: 0, text: file.diff,
        }));
        summary = (await summarizeParts(client, token, parts, 'diffs', group.label)).join('\n\n');
    }

    let evidence = joinEvidence(summary, statsEvidence);
    let prompt = buildPrompt(fileGroup, options, history, evidence);
    let rounds = 0;
    while (!await client.fits(prompt)) {
        if (rounds++ >= 3 || !summary) { throw new InputBudgetError(); }
        const reduced = (await summarizeParts(
            client, token, [{ text: summary }], 'summaries', group.label,
        )).join('\n\n');
        if (reduced.length >= summary.length) {
            throw new GroupOutputError(
                'The model did not shorten its summaries enough. Stage fewer files and generate again.',
            );
        }
        summary = reduced;
        evidence = joinEvidence(summary, statsEvidence);
        prompt = buildPrompt(fileGroup, options, history, evidence);
    }

    return requestCandidate(client, token, group, prompt);
}

function joinEvidence(summary: string, stats: string): string {
    return [summary, stats].filter(part => part.length > 0).join('\n\n');
}

async function requestCandidate(
    client: ModelClient,
    token: vscode.CancellationToken,
    group: PlannedGroup,
    prompt: string,
): Promise<CommitCandidate> {
    const first = await client.send(prompt);
    try {
        return candidateFromResponse(first, group);
    } catch (error) {
        const reason = (error instanceof Error ? error.message : 'The reply was not usable.').replace(/\.\s*$/, '');
        const retryPrompt = `${prompt}\n\nYour previous reply could not be used: ${reason}. Reply with ONLY the JSON object.`;
        // The retry is a full request and must pass the same budget check.
        if (!await client.fits(retryPrompt)) { throw new InputBudgetError(); }
        checkCancellation(token);
        const second = await client.send(retryPrompt);
        try {
            return candidateFromResponse(second, group);
        } catch {
            throw new GroupOutputError(`The model returned unusable output twice: ${reason}`);
        }
    }
}

function candidateFromResponse(raw: string, group: PlannedGroup): CommitCandidate {
    let parsed: { message: string; reason: string };
    try {
        parsed = parseResponse(raw);
    } catch {
        throw new GroupOutputError('The reply was not a valid commit JSON object.');
    }
    const message = parsed.message.trim();
    const reason = parsed.reason.trim();
    if (!message || !reason) {
        throw new GroupOutputError('The commit message or reason was empty.');
    }
    return {
        id: generateId(),
        message,
        reason,
        files: [...group.files],
        checked: true,
    };
}

/**
 * Strips thinking blocks and scans for the first balanced JSON object whose
 * message/reason fields are strings. Balanced scanning keeps braces inside
 * JSON strings from ending the object early.
 */
export function parseResponse(raw: string): { message: string; reason: string } {
    const parsed = findJsonValue(stripThinking(raw), '{', '}', value => {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) { return null; }
        const record = value as Record<string, unknown>;
        if (typeof record.message !== 'string' || typeof record.reason !== 'string') { return null; }
        return { message: record.message, reason: record.reason };
    });
    if (!parsed) {
        throw new Error(`Could not parse LLM response: ${raw.slice(0, 300)}`);
    }
    return parsed;
}

/**
 * Rough request count shown before a phase. Generation includes the single
 * ordering request when at least two candidates will exist. A group whose
 * evidence needs chunked summaries costs one request per chunk plus one final
 * summary.
 */
export function estimateRequests(
    groups: PlannedGroup[],
    changes: FileChange[],
    budget: number,
    stage: 'grouping' | 'generation' = 'generation',
): RequestEstimate {
    const threshold = budget * 2 * 0.9;
    const byPath = new Map(changes.map(change => [change.path, change]));
    let requests = groups.length;

    if (stage === 'generation' && groups.length >= 2) {
        // The ordering phase runs after every group has settled.
        requests += 1;
    }

    for (const group of groups) {
        let characters = 0;
        for (const filePath of group.files) {
            if (isStatsOnly(filePath)) {
                characters += 100;
            } else {
                characters += byPath.get(filePath)?.diff.length ?? 0;
            }
        }
        if (threshold > 0 && characters > threshold) {
            requests += Math.ceil(characters / threshold) + 1;
        }
    }

    return { groups: groups.length, requests, stage };
}

/** Split requests, never discard input. Even a single oversized file is analyzed. */
async function summarizeParts(
    client: ModelClient,
    token: vscode.CancellationToken,
    parts: EvidencePart[],
    source: 'diffs' | 'summaries',
    label: string,
): Promise<string[]> {
    checkCancellation(token);
    const prompt = buildSummaryPrompt(label, parts, source);
    if (await client.fits(prompt)) {
        const summary = (await client.send(prompt)).trim();
        if (!summary) {
            throw new GroupOutputError('The model returned an empty diff summary. Generate again.');
        }
        return [summary];
    }

    let left: EvidencePart[];
    let right: EvidencePart[];
    if (parts.length > 1) {
        const mid = Math.floor(parts.length / 2);
        left = parts.slice(0, mid);
        right = parts.slice(mid);
    } else {
        const part = parts[0];
        if (!part || part.text.length <= 1) { throw new InputBudgetError(); }
        let mid = Math.floor(part.text.length / 2);
        // Keep UTF-16 surrogate pairs intact across requests.
        if (/[\uD800-\uDBFF]/.test(part.text[mid - 1]) && /[\uDC00-\uDFFF]/.test(part.text[mid])) { mid--; }
        if (mid === 0) { throw new InputBudgetError(); }
        left = [{ ...part, text: part.text.slice(0, mid) }];
        right = [{ ...part, offset: (part.offset ?? 0) + mid, text: part.text.slice(mid) }];
    }

    // The two halves are independent requests; run them concurrently. The
    // limiter is only held per request, so this cannot deadlock.
    const [first, second] = await Promise.all([
        summarizeParts(client, token, left, source, label),
        summarizeParts(client, token, right, source, label),
    ]);
    return [...first, ...second];
}

function generateId(): string {
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
