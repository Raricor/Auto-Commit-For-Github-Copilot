import type { NoticeLevel } from '../types';

/**
 * Commit-count limits after clamping the requested minimum to the number of
 * staged files. `max` is Infinity when the user set no upper limit.
 */
export interface CommitRange {
    min: number;
    max: number;
}

export interface RangeNotice {
    level: NoticeLevel;
    message: string;
}

export interface RangeGroup {
    label: string;
    files: string[];
}

export interface ResolvedRange extends CommitRange {
    notices: RangeNotice[];
}

/**
 * Turns the optional user settings into an effective range and the notices
 * the user must see before any model request is made.
 */
export function resolveCommitRange(
    requestedMin: number | undefined,
    requestedMax: number | undefined,
    fileCount: number,
): ResolvedRange {
    const minSetting = positiveInteger(requestedMin);
    const maxSetting = positiveInteger(requestedMax);
    const notices: RangeNotice[] = [];

    let min = minSetting > 0 ? Math.min(minSetting, Math.max(0, fileCount)) : 0;
    let max = maxSetting > 0 ? maxSetting : Infinity;

    if (minSetting > fileCount) {
        notices.push({
            level: 'info',
            message: `Only ${fileCount} files are staged; using at least ${fileCount} commits instead of ${minSetting}.`,
        });
    }

    if (min > max) {
        notices.push({
            level: 'warning',
            message: `The minimum of ${min} commit(s) exceeds the maximum of ${max}; ignoring the minimum.`,
        });
        min = 0;
    }

    return { min, max, notices };
}

/** True when the group count satisfies both effective limits. */
export function inRange(count: number, range: CommitRange): boolean {
    return count >= range.min && count <= range.max;
}

/** The exact feedback appended to a grouping/merge retry request. */
export function rangeFeedback(count: number, range: CommitRange): string {
    if (Number.isFinite(range.max)) {
        return `You returned ${count} groups; the user requires between ${Math.max(1, range.min)} and ${range.max}.`;
    }
    return `You returned ${count} groups; the user requires at least ${Math.max(1, range.min)}.`;
}

/**
 * Deterministically reaches an upper bound by repeatedly merging the pair
 * with the longest shared directory prefix. Pair order is stable so the same
 * input always produces the same groups.
 */
export function mergeToMax(groups: RangeGroup[], max: number): RangeGroup[] {
    if (!Number.isFinite(max)) { return copyGroups(groups); }
    const limit = Math.max(1, Math.floor(max));
    // The shared prefix of two groups equals the shared prefix of their own
    // cached prefixes. Caching makes each pair comparison independent of the
    // number of files, which keeps this loop fast for hundreds of groups.
    let entries: Array<{ group: RangeGroup; prefix: string[] }> = copyGroups(groups).map(group => ({
        group,
        prefix: commonDirectorySegments(group.files),
    }));

    while (entries.length > limit && entries.length >= 2) {
        let bestI = 0;
        let bestJ = 1;
        let bestPrefixLength = -1;
        let bestSize = Number.POSITIVE_INFINITY;

        for (let i = 0; i < entries.length; i++) {
            for (let j = i + 1; j < entries.length; j++) {
                const prefixLength = sharedPrefixLength(entries[i].prefix, entries[j].prefix);
                const size = entries[i].group.files.length + entries[j].group.files.length;
                if (
                    prefixLength > bestPrefixLength ||
                    (prefixLength === bestPrefixLength && size < bestSize)
                ) {
                    bestI = i;
                    bestJ = j;
                    bestPrefixLength = prefixLength;
                    bestSize = size;
                }
            }
        }

        const first = entries[bestI];
        const second = entries[bestJ];
        const merged: RangeGroup = {
            label: `${first.group.label}; ${second.group.label}`,
            files: [...first.group.files, ...second.group.files].sort(compareText),
        };
        const mergedPrefix = sharedPrefix(first.prefix, second.prefix);
        entries = entries.filter((_entry, index) => index !== bestI && index !== bestJ);
        entries.splice(bestI, 0, { group: merged, prefix: mergedPrefix });
    }

    return entries.map(entry => entry.group);
}

/**
 * Deterministically reaches a lower bound by splitting the largest group.
 * A group is never split below one file, so this can only fail when the
 * effective minimum already exceeds the number of staged files.
 */
export function splitToMin(groups: RangeGroup[], min: number): RangeGroup[] {
    const target = Math.max(1, Math.floor(min));
    let result = copyGroups(groups);

    while (result.length < target) {
        let bestIndex = -1;
        for (let i = 0; i < result.length; i++) {
            if (result[i].files.length <= 1) { continue; }
            if (bestIndex === -1 || result[i].files.length > result[bestIndex].files.length) {
                bestIndex = i;
            }
        }
        if (bestIndex === -1) { break; }

        const group = result[bestIndex];
        const parts = splitGroup(group);
        if (parts.length < 2) { break; }
        result = result.filter((_group, index) => index !== bestIndex);
        result.splice(bestIndex, 0, ...parts);
    }

    return result;
}

function splitGroup(group: RangeGroup): RangeGroup[] {
    const files = [...group.files].sort(compareText);
    if (files.length <= 1) { return [{ ...group, files }]; }

    const prefix = commonDirectorySegments(files);
    const bySubdirectory = new Map<string, string[]>();
    const direct: string[] = [];

    for (const file of files) {
        const directories = directorySegments(file);
        if (directories.length > prefix.length) {
            const key = directories[prefix.length];
            const list = bySubdirectory.get(key) ?? [];
            list.push(file);
            bySubdirectory.set(key, list);
        } else {
            direct.push(file);
        }
    }

    if (bySubdirectory.size >= 2) {
        const parts: RangeGroup[] = [];
        for (const key of [...bySubdirectory.keys()].sort(compareText)) {
            parts.push({
                label: `${group.label} (${key})`,
                files: bySubdirectory.get(key)!.sort(compareText),
            });
        }
        if (direct.length > 0) {
            parts.push({ label: `${group.label} (root)`, files: direct.sort(compareText) });
        }
        return parts;
    }

    const mid = Math.floor(files.length / 2);
    return [
        { label: `${group.label} (part 1)`, files: files.slice(0, mid) },
        { label: `${group.label} (part 2)`, files: files.slice(mid) },
    ];
}

/** Shared directory segments of every path; the filename is never included. */
function commonDirectorySegments(files: string[]): string[] {
    if (files.length === 0) { return []; }
    let prefix = directorySegments(files[0]);
    for (let i = 1; i < files.length; i++) {
        const directories = directorySegments(files[i]);
        let length = 0;
        while (
            length < prefix.length &&
            length < directories.length &&
            prefix[length] === directories[length]
        ) {
            length += 1;
        }
        prefix = prefix.slice(0, length);
        if (prefix.length === 0) { break; }
    }
    return prefix;
}

function sharedPrefixLength(left: string[], right: string[]): number {
    const limit = Math.min(left.length, right.length);
    let length = 0;
    while (length < limit && left[length] === right[length]) {
        length += 1;
    }
    return length;
}

function sharedPrefix(left: string[], right: string[]): string[] {
    return left.slice(0, sharedPrefixLength(left, right));
}

function directorySegments(filePath: string): string[] {
    const parts = filePath.split('/').filter(part => part.length > 0);
    parts.pop();
    return parts;
}

function copyGroups(groups: RangeGroup[]): RangeGroup[] {
    return groups.map(group => ({ label: group.label, files: [...group.files] }));
}

function positiveInteger(value: number | undefined): number {
    if (!Number.isFinite(value) || value === undefined || value <= 0) { return 0; }
    return Math.floor(value);
}

function compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}
