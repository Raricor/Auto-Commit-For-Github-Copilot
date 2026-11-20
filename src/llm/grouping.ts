import { groupFiles } from '../git/diffAnalyzer';
import type {
    FileChange, GenerateOptions, GenerationProgress, NoticeLevel, PlannedGroup,
} from '../types';
import type * as vscode from 'vscode';
import type { ModelClient } from './modelClient';
import { checkCancellation } from './cancellation';
import { findJsonValue, stripThinking } from './jsonExtract';
import {
    buildGroupingPrompt, buildMergePrompt, type GroupingBatch, type MergeGroupInfo,
} from './promptBuilder';
import { InputBudgetError, groupingEvidence, prepareGroupingPrompt } from './promptBudget';
import { preGroup } from './preGroup';
import {
    inRange, mergeToMax, rangeFeedback, resolveCommitRange, splitToMin,
    type CommitRange,
} from './commitRange';
import { CONFIRM_REQUEST_THRESHOLD, type RequestEstimate } from './generation';

export interface GroupingEvents {
    onProgress?(progress: GenerationProgress): void;
    onNotice?(level: NoticeLevel, message: string): void;
}

interface ParsedGroup {
    label: string;
    files: string[];
}

export interface PlanGroupsArgs {
    changes: FileChange[];
    options: GenerateOptions;
    client: ModelClient;
    token: vscode.CancellationToken;
    events?: GroupingEvents;
    /** Asked before a folder-batch run with many planned requests. */
    confirmRequests?(estimate: RequestEstimate): Promise<boolean>;
}

export interface PlanGroupsResult {
    groups: PlannedGroup[];
    /** Set when the user declined the grouping request estimate. */
    declined?: boolean;
}

interface ParsedAttempt {
    parsed: ParsedGroup[] | null;
    groups: ParsedGroup[];
    missing: FileChange[];
    invalidReason?: string;
}

interface FlatOutcome extends ParsedAttempt {
    fallback: boolean;
}

interface MergeOutcome {
    groups: ParsedGroup[];
    /** Present when a merge prompt was actually sent; used for range retries. */
    prompt?: string;
}

/** Evidence floor used only to decide whether flat grouping can fit at all. */
const BUCKET_EVIDENCE_LIMIT = 400;

/**
 * Decides the final commit-sized groups before any commit message is
 * generated. Small changes use one flat grouping request; large ones are
 * pre-grouped by folder, grouped in bounded batches, then merged across
 * batches. A single file needs no grouping round-trip at all.
 */
export async function planGroups(args: PlanGroupsArgs): Promise<PlanGroupsResult> {
    const { changes, options, client, token, events } = args;
    events?.onProgress?.({ stage: 'grouping' });

    const range = resolveCommitRange(options.minCommits, options.maxCommits, changes.length);
    for (const notice of range.notices) {
        events?.onNotice?.(notice.level, notice.message);
    }

    if (changes.length === 0) { return { groups: [] }; }
    if (changes.length === 1) {
        return {
            groups: [{ index: 0, label: changes[0].path, files: [changes[0].path] }],
        };
    }

    const useBuckets = changes.length > 100 || !await flatGroupingFits(changes, options, range, client);
    if (!useBuckets) {
        return { groups: await planFlat(changes, options, range, client, token, events) };
    }
    return planBucketed(args, range);
}

async function planFlat(
    changes: FileChange[],
    options: GenerateOptions,
    range: CommitRange,
    client: ModelClient,
    token: vscode.CancellationToken,
    events?: GroupingEvents,
): Promise<PlannedGroup[]> {
    const prompt = await prepareGroupingPrompt(
        changes,
        evidence => buildGroupingPrompt(evidence, options, range),
        client.model,
        token,
        () => checkCancellation(token),
    );

    const outcome = await groupWithRetry(changes, prompt, client, token);
    if (outcome.fallback) {
        events?.onNotice?.('warning', 'AI grouping output was invalid twice; fell back to folder and type rules.');
        return plannedFromParsed(adjustToRange(
            parsedFromFileGroups(changes),
            range,
            events,
        ));
    }

    let groups = finalizeGroups(outcome, changes, events);
    if (!inRange(groups.length, range)) {
        const retried = await retryFlatGrouping(
            prompt, groups.length, range, changes, client, token, events,
        );
        if (retried) { groups = retried; }
    }
    groups = adjustToRange(groups, range, events);
    return plannedFromParsed(groups);
}

async function flatGroupingFits(
    changes: FileChange[],
    options: GenerateOptions,
    range: CommitRange,
    client: ModelClient,
): Promise<boolean> {
    const evidence = groupingEvidence(changes, BUCKET_EVIDENCE_LIMIT);
    return client.fits(buildGroupingPrompt(evidence, options, range));
}

async function retryFlatGrouping(
    prompt: string,
    count: number,
    range: CommitRange,
    changes: FileChange[],
    client: ModelClient,
    token: vscode.CancellationToken,
    events?: GroupingEvents,
): Promise<ParsedGroup[] | null> {
    const retryPrompt = `${prompt}\n\n${rangeFeedback(count, range)} Reply with ONLY the JSON array.`;
    if (!await client.fits(retryPrompt)) { return null; }

    const attempt = await sendAndParse(retryPrompt, changes, client);
    if (attempt.parsed === null || attempt.groups.length === 0) { return null; }
    return finalizeGroups(attempt, changes, events);
}

async function planBucketed(
    args: PlanGroupsArgs,
    range: CommitRange,
): Promise<PlanGroupsResult> {
    const { changes, options, client, token, events } = args;
    const byPath = new Map(changes.map(change => [change.path, change]));
    const initialBuckets = preGroup(changes.map(change => change.path));
    const buckets = await fitBucketsToBudget(initialBuckets, byPath, options, client, token);

    // A batch run is one request per bucket plus the cross-batch merge. Confirm
    // before any of those requests are sent.
    const plannedRequests = buckets.length + (buckets.length > 1 ? 1 : 0);
    events?.onProgress?.({
        stage: 'grouping',
        detail: `${changes.length} files pre-grouped into ${buckets.length} folders`,
    });
    if (plannedRequests > CONFIRM_REQUEST_THRESHOLD && args.confirmRequests) {
        const accepted = await args.confirmRequests({
            groups: buckets.length,
            requests: plannedRequests,
            stage: 'grouping',
        });
        checkCancellation(token);
        if (!accepted) { return { groups: [], declined: true }; }
    }

    const bucketGroups: ParsedGroup[][] = buckets.map(() => []);
    let fallbackBatches = 0;
    let missingFiles = 0;
    let missingBatches = 0;
    let done = 0;
    const total = buckets.length;

    const tasks = buckets.map((bucket, batchIndex) => (async (): Promise<void> => {
        try {
            checkCancellation(token);
            const bucketChanges = bucket
                .map(filePath => byPath.get(filePath))
                .filter((file): file is FileChange => file !== undefined);
            const batch: GroupingBatch = {
                size: bucket.length,
                directory: commonDirectory(bucket),
                total: changes.length,
            };
            const prompt = await prepareGroupingPrompt(
                bucketChanges,
                evidence => buildGroupingPrompt(evidence, options, undefined, batch),
                client.model,
                token,
                () => checkCancellation(token),
            );
            const outcome = await groupWithRetry(bucketChanges, prompt, client, token);
            if (outcome.fallback) {
                fallbackBatches += 1;
                bucketGroups[batchIndex] = parsedFromFileGroups(bucketChanges);
                return;
            }

            const groups = outcome.groups.map(group => ({ ...group, files: [...group.files] }));
            if (outcome.missing.length > 0) {
                missingFiles += outcome.missing.length;
                missingBatches += 1;
                groups.push(...parsedFromFileGroups(outcome.missing));
            }
            bucketGroups[batchIndex] = groups;
        } finally {
            done += 1;
            events?.onProgress?.({ stage: 'grouping', done, total });
        }
    })());

    await Promise.all(tasks);

    if (fallbackBatches > 0) {
        events?.onNotice?.(
            'warning',
            `AI grouping fell back to folder rules in ${fallbackBatches} of ${buckets.length} batches.`,
        );
    }
    if (missingFiles > 0) {
        events?.onNotice?.(
            'info',
            `AI grouping missed ${missingFiles} file(s) across ${missingBatches} batch(es); grouped them by folder and type.`,
        );
    }

    let groups = bucketGroups.flat();
    if (buckets.length > 1) {
        const mergeInput = groups;
        const merge = await mergeAcrossBatches(mergeInput, range, client, token, events);
        groups = merge.groups;

        if (merge.prompt && !inRange(groups.length, range)) {
            // The retry prompt still uses the ids from the original merge
            // input, not the already-merged groups.
            const retryPrompt = `${merge.prompt}\n\n${rangeFeedback(groups.length, range)} Reply with ONLY the JSON array.`;
            if (await client.fits(retryPrompt)) {
                const retried = await requestMerge(retryPrompt, mergeInput, client, token);
                if (retried) { groups = retried; }
            }
        }
    }

    groups = adjustToRange(groups, range, events);
    return { groups: plannedFromParsed(groups) };
}

/**
 * Splits a bucket until its 400-character grouping prompt fits. A single file
 * that still cannot fit is a genuine budget failure.
 */
async function fitBucketsToBudget(
    buckets: string[][],
    byPath: Map<string, FileChange>,
    options: GenerateOptions,
    client: ModelClient,
    token: vscode.CancellationToken,
): Promise<string[][]> {
    const result: string[][] = [];
    for (const bucket of buckets) {
        result.push(...await fitBucket(bucket, byPath, options, client, token));
    }
    return result;
}

async function fitBucket(
    bucket: string[],
    byPath: Map<string, FileChange>,
    options: GenerateOptions,
    client: ModelClient,
    token: vscode.CancellationToken,
): Promise<string[][]> {
    checkCancellation(token);
    const bucketChanges = bucket
        .map(filePath => byPath.get(filePath))
        .filter((file): file is FileChange => file !== undefined);
    const batch: GroupingBatch = {
        size: bucket.length,
        directory: commonDirectory(bucket),
        total: byPath.size,
    };
    const evidence = groupingEvidence(bucketChanges, BUCKET_EVIDENCE_LIMIT);
    if (await client.fits(buildGroupingPrompt(evidence, options, undefined, batch))) {
        return [bucket];
    }
    if (bucket.length <= 1) { throw new InputBudgetError(); }

    const mid = Math.floor(bucket.length / 2);
    return [
        ...await fitBucket(bucket.slice(0, mid), byPath, options, client, token),
        ...await fitBucket(bucket.slice(mid), byPath, options, client, token),
    ];
}

async function mergeAcrossBatches(
    groups: ParsedGroup[],
    range: CommitRange,
    client: ModelClient,
    token: vscode.CancellationToken,
    events?: GroupingEvents,
): Promise<MergeOutcome> {
    const infos: MergeGroupInfo[] = groups.map((group, index) => mergeInfo(group, index));
    const attempts: Array<[number, number]> = [[5, 3], [2, 3], [0, 3], [0, 1]];

    let prompt: string | undefined;
    for (const [exampleLimit, directoryLimit] of attempts) {
        const candidate = buildMergePrompt(infos, range, exampleLimit, directoryLimit);
        if (await client.fits(candidate)) {
            prompt = candidate;
            break;
        }
    }
    if (!prompt) {
        events?.onNotice?.(
            'info',
            'AI merge was skipped because the request cannot fit the model input budget; kept folder batches separate.',
        );
        return { groups };
    }

    const merged = await requestMerge(prompt, groups, client, token);
    if (!merged) {
        events?.onNotice?.('warning', 'AI merge output was invalid twice; kept folder batches separate.');
        return { groups };
    }
    return { groups: merged, prompt };
}

/** One merge request with a single structural retry; null means "do not merge". */
async function requestMerge(
    prompt: string,
    groups: ParsedGroup[],
    client: ModelClient,
    token: vscode.CancellationToken,
): Promise<ParsedGroup[] | null> {
    const ids = groups.map((_group, index) => `g${index + 1}`);
    let parsed = await sendAndParseMerge(prompt, client, token);
    if (parsed === null) {
        const retryPrompt = `${prompt}\n\nYour previous reply could not be used: ` +
            'The reply was not a valid [{label, groups}] JSON array. Reply with ONLY the JSON array.';
        if (!await client.fits(retryPrompt)) { return null; }
        checkCancellation(token);
        parsed = await sendAndParseMerge(retryPrompt, client, token);
        if (parsed === null) { return null; }
    }
    return repairMerge(parsed, groups, ids);
}

async function sendAndParseMerge(
    prompt: string,
    client: ModelClient,
    token: vscode.CancellationToken,
): Promise<Array<{ label: string; groups: string[] }> | null> {
    const raw = await client.send(prompt);
    checkCancellation(token);
    return parseMergeResponse(raw);
}

function mergeInfo(group: ParsedGroup, index: number): MergeGroupInfo {
    const counts = new Map<string, number>();
    for (const filePath of group.files) {
        const directory = directoryOf(filePath);
        counts.set(directory, (counts.get(directory) ?? 0) + 1);
    }
    const directories = [...counts.entries()]
        .sort((left, right) => right[1] - left[1] || compareText(left[0], right[0]))
        .map(([directory]) => directory);
    return {
        id: `g${index + 1}`,
        label: group.label,
        fileCount: group.files.length,
        directories,
        examples: [...group.files].sort(compareText),
    };
}

/**
 * Applies the merge reply. Unknown ids are dropped, duplicate ids keep their
 * first use, and omitted ids stay as independent groups in their old order.
 */
function repairMerge(
    parsed: Array<{ label: string; groups: string[] }>,
    groups: ParsedGroup[],
    ids: string[],
): ParsedGroup[] {
    const byId = new Map(ids.map((id, index) => [id, groups[index]]));
    const used = new Set<string>();
    const result: ParsedGroup[] = [];

    for (const entry of parsed) {
        const files: string[] = [];
        for (const rawId of entry.groups) {
            const id = rawId.trim();
            const group = byId.get(id);
            if (!group || used.has(id)) { continue; }
            used.add(id);
            files.push(...group.files);
        }
        if (files.length > 0) {
            result.push({ label: entry.label, files });
        }
    }
    for (let index = 0; index < groups.length; index++) {
        if (!used.has(ids[index])) {
            result.push({ ...groups[index], files: [...groups[index].files] });
        }
    }
    return result;
}

async function groupWithRetry(
    changes: FileChange[],
    prompt: string,
    client: ModelClient,
    token: vscode.CancellationToken,
): Promise<FlatOutcome> {
    let attempt = await sendAndParse(prompt, changes, client);
    if (!needsRetry(attempt, changes)) {
        return { ...attempt, fallback: false };
    }

    const reason = (attempt.invalidReason ??
        `The reply missed ${attempt.missing.length} of ${changes.length} files.`).replace(/\.\s*$/, '');
    // Feedback is appended to the already-budgeted prompt, so the retry needs
    // its own budget check.
    const retryPrompt = `${prompt}\n\nYour previous reply could not be used: ${reason}. Reply with ONLY the JSON array.`;
    if (!await client.fits(retryPrompt)) { throw new InputBudgetError(); }
    attempt = await sendAndParse(retryPrompt, changes, client);
    if (needsRetry(attempt, changes)) {
        return { parsed: null, groups: [], missing: changes, fallback: true };
    }
    return { ...attempt, fallback: false };
}

async function sendAndParse(
    prompt: string,
    changes: FileChange[],
    client: ModelClient,
): Promise<ParsedAttempt> {
    const raw = await client.send(prompt);
    return parseGroupingAttempt(raw, changes);
}

function parseGroupingAttempt(raw: string, changes: FileChange[]): ParsedAttempt {
    const parsed = parseGroupingResponse(raw);
    const repaired = parsed ? repairGrouping(parsed, changes) : null;
    const invalidReason = parsed === null
        ? 'The reply was not a valid [{label, files}] JSON array.'
        : repaired && repaired.groups.length > 0
            ? undefined
            : 'No group referenced a staged file.';
    return {
        parsed,
        groups: repaired?.groups ?? [],
        missing: repaired?.missing ?? changes,
        invalidReason,
    };
}

function needsRetry(attempt: ParsedAttempt, changes: FileChange[]): boolean {
    return attempt.invalidReason !== undefined ||
        (attempt.parsed !== null && attempt.missing.length > changes.length / 2);
}

function finalizeGroups(
    attempt: ParsedAttempt,
    changes: FileChange[],
    events?: GroupingEvents,
): ParsedGroup[] {
    const groups = attempt.groups.map(group => ({ ...group, files: [...group.files] }));
    if (attempt.missing.length > 0) {
        groups.push(...parsedFromFileGroups(attempt.missing));
        events?.onNotice?.(
            'info',
            `AI grouping missed ${attempt.missing.length} file(s); grouped them by folder and type.`,
        );
    }
    return groups;
}

/** Deterministic fallback for a group count outside the configured range. */
function adjustToRange(
    groups: ParsedGroup[],
    range: CommitRange,
    events?: GroupingEvents,
): ParsedGroup[] {
    if (inRange(groups.length, range)) { return groups; }

    let adjusted = groups;
    if (Number.isFinite(range.max) && adjusted.length > range.max) {
        adjusted = mergeToMax(adjusted, range.max);
    }
    if (adjusted.length < range.min) {
        adjusted = splitToMin(adjusted, range.min);
    }
    events?.onNotice?.(
        'info',
        `Adjusted to ${adjusted.length} commits by merging or splitting folders to fit the configured range.`,
    );
    return adjusted;
}

function parsedFromFileGroups(changes: FileChange[]): ParsedGroup[] {
    return groupFiles(changes).map(group => ({
        label: group.label,
        files: group.files.map(file => file.path),
    }));
}

function plannedFromParsed(groups: ParsedGroup[], startIndex = 0): PlannedGroup[] {
    return groups.map((group, offset) => ({
        index: startIndex + offset,
        label: group.label,
        files: group.files,
    }));
}

/** Path normalisation plus duplicate/unknown pruning; never throws. */
function repairGrouping(parsed: ParsedGroup[], changes: FileChange[]): { groups: ParsedGroup[]; missing: FileChange[] } {
    const valid = new Map(changes.map(change => [change.path, change]));
    const seen = new Set<string>();
    const groups: ParsedGroup[] = [];

    for (const group of parsed) {
        const files: string[] = [];
        for (const rawPath of group.files) {
            const filePath = normalisePath(rawPath, valid);
            if (!filePath || seen.has(filePath)) { continue; }
            seen.add(filePath);
            files.push(filePath);
        }
        if (files.length > 0) {
            groups.push({ label: group.label, files });
        }
    }

    const missing = changes.filter(change => !seen.has(change.path));
    return { groups, missing };
}

function normalisePath(rawPath: string, valid: Map<string, FileChange>): string | undefined {
    let filePath = rawPath.trim();
    while (filePath.startsWith('./')) { filePath = filePath.slice(2); }
    if ((filePath.startsWith('a/') || filePath.startsWith('b/')) && valid.has(filePath.slice(2))) {
        return filePath.slice(2);
    }
    return valid.has(filePath) ? filePath : undefined;
}

function parseGroupingResponse(raw: string): ParsedGroup[] | null {
    return findJsonValue(stripThinking(raw), '[', ']', value => {
        if (!Array.isArray(value) || value.length === 0) { return null; }
        const groups: ParsedGroup[] = [];
        for (const item of value) {
            if (typeof item !== 'object' || item === null || Array.isArray(item)) { return null; }
            const record = item as Record<string, unknown>;
            if (
                typeof record.label !== 'string' ||
                record.label.trim().length === 0 ||
                !Array.isArray(record.files) ||
                !record.files.every(file => typeof file === 'string')
            ) {
                return null;
            }
            groups.push({
                label: record.label.trim(),
                files: record.files as string[],
            });
        }
        return groups;
    });
}

function parseMergeResponse(raw: string): Array<{ label: string; groups: string[] }> | null {
    return findJsonValue(stripThinking(raw), '[', ']', value => {
        if (!Array.isArray(value) || value.length === 0) { return null; }
        const entries: Array<{ label: string; groups: string[] }> = [];
        for (const item of value) {
            if (typeof item !== 'object' || item === null || Array.isArray(item)) { return null; }
            const record = item as Record<string, unknown>;
            if (
                typeof record.label !== 'string' ||
                record.label.trim().length === 0 ||
                !Array.isArray(record.groups) ||
                record.groups.length === 0 ||
                !record.groups.every(id => typeof id === 'string')
            ) {
                return null;
            }
            entries.push({
                label: record.label.trim(),
                groups: record.groups as string[],
            });
        }
        return entries;
    });
}

function commonDirectory(paths: string[]): string {
    if (paths.length === 0) { return '.'; }
    let prefix = directorySegments(paths[0]);
    for (let index = 1; index < paths.length; index++) {
        const segments = directorySegments(paths[index]);
        let length = 0;
        while (
            length < prefix.length &&
            length < segments.length &&
            prefix[length] === segments[length]
        ) {
            length += 1;
        }
        prefix = prefix.slice(0, length);
        if (prefix.length === 0) { break; }
    }
    return prefix.length > 0 ? prefix.join('/') : '.';
}

function directoryOf(filePath: string): string {
    const segments = directorySegments(filePath);
    return segments.length > 0 ? segments.join('/') : '.';
}

function directorySegments(filePath: string): string[] {
    const parts = filePath.split('/').filter(part => part.length > 0);
    parts.pop();
    return parts;
}

function compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}
