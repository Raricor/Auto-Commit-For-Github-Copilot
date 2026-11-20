import type * as vscode from 'vscode';
import type { FileChange } from '../types';
import { isStatsOnly } from './fileKinds';

type BudgetModel = Pick<vscode.LanguageModelChat, 'maxInputTokens' | 'countTokens'>;

export class InputBudgetError extends Error {
    constructor() {
        super('The request cannot fit the model input budget. Stage fewer files or shorten custom instructions/commit history, then generate again.');
        this.name = 'InputBudgetError';
    }
}

/** Leave room for imperfect provider token estimates and request overhead. */
export function inputBudget(model: BudgetModel, cap = Infinity): number {
    if (!Number.isFinite(model.maxInputTokens) || model.maxInputTokens <= 0) {
        throw new Error('The selected model did not provide a valid input token limit.');
    }
    return Math.min(cap, Math.floor(model.maxInputTokens * 0.8));
}

export async function fitsPrompt(
    prompt: string,
    model: BudgetModel,
    budget: number,
    token: vscode.CancellationToken,
    checkCancellation: () => void,
): Promise<boolean> {
    checkCancellation();
    // A conservative second guard for providers that only estimate tokens from
    // character counts. Avoid expensive tokenization of obviously huge inputs.
    if (prompt.length > budget * 2) { return false; }
    const count = await model.countTokens(prompt, token);
    checkCancellation();
    if (!Number.isFinite(count) || count < 0) {
        throw new Error('The selected model returned an invalid token count.');
    }
    return count <= budget;
}

/**
 * Counts changed lines from the first hunk onward. Before the first @@ only
 * headers can start with +/-, while inside a hunk `--- comment` and `++ x`
 * are real deleted/added lines.
 */
export function statisticsLine(file: FileChange): string {
    let inHunk = false;
    let additions = 0;
    let deletions = 0;
    for (const line of file.diff.split('\n')) {
        if (!inHunk && line.startsWith('@@')) { inHunk = true; }
        // Before the first hunk only the +++/--- file headers start with +/-
        // and must not be counted; after it every such line is a change.
        if (!inHunk && (line.startsWith('+++ ') || line.startsWith('--- '))) { continue; }
        if (line.startsWith('+')) {
            additions += 1;
        } else if (line.startsWith('-')) {
            deletions += 1;
        }
    }
    return `+${additions} -${deletions}; ${file.diff.length} characters.`;
}

/** The only evidence sent for lockfiles and generated artifacts. */
export function statsOnlyEvidence(file: FileChange): string {
    return `${statisticsLine(file)}\n(lockfile or generated file; content not shown)`;
}

const HEADER_LINE = /^(?:diff --git |index |--- |\+\+\+ |similarity index |dissimilarity index |old mode |new mode |new file mode |deleted file mode |rename from |rename to |copy from |copy to )/;

/**
 * Strips diff metadata and context lines. Hunk headers keep their function
 * name (truncated) because that is often the strongest intent signal.
 */
export function compressDiff(diff: string): string {
    const out: string[] = [];
    let inHunk = false;
    for (const line of diff.split('\n')) {
        if (line.startsWith('@@')) {
            inHunk = true;
            out.push(truncateSafe(line, 160));
            continue;
        }
        if (!inHunk) {
            // Only lines before the first hunk may be metadata. Applying the
            // header rule later would drop real `-- comment` deletions.
            if (line.startsWith('Binary files ') && line.endsWith(' differ')) {
                out.push('binary file');
            } else if (!HEADER_LINE.test(line) && (line.startsWith('+') || line.startsWith('-'))) {
                // Diffs without hunk headers still carry useful evidence.
                out.push(line);
            }
            continue;
        }
        if (line.startsWith('+') || line.startsWith('-')) {
            out.push(line);
        } else if (line.startsWith('\\ No newline')) {
            continue;
        }
        // Context lines (leading space) intentionally carry no intent signal.
    }
    return out.join('\n');
}

/**
 * Bounded diff evidence: keep whole leading and trailing hunks, announce the
 * omitted middle, and line-truncate when even individual hunks are too large.
 */
export function groupingExcerpt(compressed: string, limit: number): string {
    const safeLimit = Math.max(0, Math.floor(limit));
    if (safeLimit === 0 || compressed.length === 0) { return ''; }
    if (compressed.length <= safeLimit) { return compressed; }

    const hunks = splitHunks(compressed);
    if (hunks.length === 1) {
        return truncateHunk(hunks[0], safeLimit);
    }

    for (let keep = Math.floor(hunks.length / 2); keep >= 1; keep--) {
        const omitted = hunks.length - keep * 2;
        const body = hunks.slice(0, keep).join('\n') +
            `\n[… ${omitted} hunks omitted …]\n` +
            hunks.slice(hunks.length - keep).join('\n');
        if (body.length <= safeLimit) { return body; }
    }

    const marker = `\n[… ${Math.max(0, hunks.length - 2)} hunks omitted …]\n`;
    if (safeLimit > marker.length + 80) {
        const contentBudget = safeLimit - marker.length;
        const body = truncateHunk(hunks[0], Math.ceil(contentBudget / 2)) + marker +
            truncateHunk(hunks[hunks.length - 1], Math.floor(contentBudget / 2));
        if (body.length <= safeLimit) { return body; }
        return truncateSafe(body, safeLimit);
    }
    return truncateSafe(compressed, safeLimit);
}

function splitHunks(compressed: string): string[] {
    const hunks: string[] = [];
    const prefix: string[] = [];
    let current: string[] | undefined;

    for (const line of compressed.split('\n')) {
        if (line.startsWith('@@')) {
            if (current) { hunks.push(current.join('\n')); }
            current = [line];
        } else if (current) {
            current.push(line);
        } else {
            prefix.push(line);
        }
    }
    if (current) { hunks.push(current.join('\n')); }

    if (hunks.length === 0) { return [compressed]; }
    if (prefix.length > 0) { hunks[0] = `${prefix.join('\n')}\n${hunks[0]}`; }
    return hunks;
}

function truncateHunk(hunk: string, limit: number): string {
    if (hunk.length <= limit) { return hunk; }
    const marker = '\n[… lines omitted …]\n';
    if (limit <= marker.length + 1) { return truncateSafe(hunk, limit); }

    const lines = hunk.split('\n');
    const contentBudget = limit - marker.length;
    const head = takeLines(lines, Math.ceil(contentBudget / 2), false);
    const tail = takeLines(lines, Math.floor(contentBudget / 2), true);
    if (!head || !tail) { return truncateSafe(hunk, limit); }

    const body = `${head}${marker}${tail}`;
    return body.length <= limit ? body : truncateSafe(body, limit);
}

function takeLines(lines: string[], budget: number, fromEnd: boolean): string {
    const selected: string[] = [];
    let used = 0;
    const source = fromEnd ? [...lines].reverse() : lines;
    for (const line of source) {
        const cost = line.length + 1;
        if (used + cost > budget) { break; }
        selected.push(line);
        used += cost;
    }
    if (fromEnd) { selected.reverse(); }
    return selected.join('\n');
}

/** Never split a UTF-16 surrogate pair when cutting text. */
function truncateSafe(text: string, limit: number): string {
    if (limit >= text.length) { return text; }
    let end = Math.max(0, Math.floor(limit));
    if (end > 0) {
        const code = text.charCodeAt(end - 1);
        if (code >= 0xD800 && code <= 0xDBFF) { end -= 1; }
    }
    return text.slice(0, end);
}

/**
 * Builds bounded evidence for one grouping request. Stats-only files always
 * use their statistics; every other file gets at most `limit` characters of
 * compressed diff after its statistics line.
 */
export function groupingEvidence(changes: FileChange[], limit: number): FileChange[] {
    return changes.map(file => {
        const base = isStatsOnly(file.path) ? statsOnlyEvidence(file) : statisticsLine(file);
        if (isStatsOnly(file.path)) {
            return { ...file, diff: base };
        }
        const excerpt = groupingExcerpt(compressDiff(file.diff), limit);
        return { ...file, diff: excerpt ? `${base}\n${excerpt}` : base };
    });
}

/**
 * Bounded evidence for deciding intent; generation still analyzes full diffs.
 * The per-file limit starts from the available character budget and halves
 * until the counted prompt fits.
 */
export async function prepareGroupingPrompt(
    changes: FileChange[],
    build: (evidence: FileChange[]) => string,
    model: BudgetModel,
    token: vscode.CancellationToken,
    checkCancellation: () => void,
): Promise<string> {
    const budget = inputBudget(model, 64_000);
    const baseEvidence = changes.map(file => ({
        ...file,
        diff: isStatsOnly(file.path) ? statsOnlyEvidence(file) : statisticsLine(file),
    }));
    const baseLength = build(baseEvidence).length;
    const available = budget * 2 - baseLength;
    let limit = Math.max(0, Math.min(6_000, Math.floor(available / Math.max(changes.length, 1))));

    for (;;) {
        checkCancellation();
        const evidence = groupingEvidence(changes, limit);
        const prompt = build(evidence);
        if (await fitsPrompt(prompt, model, budget, token, checkCancellation)) { return prompt; }
        if (limit === 0) { throw new InputBudgetError(); }
        limit = Math.floor(limit / 2);
    }
}
