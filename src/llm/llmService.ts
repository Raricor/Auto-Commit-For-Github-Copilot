import * as vscode from 'vscode';
import { groupFiles } from '../git/diffAnalyzer';
import type { CommitCandidate, FileChange, FileGroup, GenerateOptions, GitLogEntry } from '../types';
import { buildGroupingPrompt, buildPrompt, buildSummaryPrompt, type EvidencePart } from './promptBuilder';
import { fitsPrompt, inputBudget, InputBudgetError, prepareGroupingPrompt } from './promptBudget';

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

/**
 * Calls the Copilot LM API for a single FileGroup and returns a CommitCandidate.
 * Throws if the model is unavailable or the response cannot be parsed.
 */
export async function generateForGroup(
    group: FileGroup,
    options: GenerateOptions,
    token: vscode.CancellationToken,
    recentCommits?: GitLogEntry[]
): Promise<CommitCandidate> {
    checkCancellation(token);
    const model = await getModel(options.model);
    return generateGroupWithModel(group, options, model, token, recentCommits);
}

/**
 * Generate independently for each group. Never combine their full diffs in one request.
 */
export async function generateForAllGroups(
    groups: FileGroup[],
    options: GenerateOptions,
    token: vscode.CancellationToken,
    recentCommits?: GitLogEntry[],
    onCandidate?: (candidate: CommitCandidate) => void,
): Promise<CommitCandidate[]> {
    if (groups.length === 0) {
        return [];
    }

    checkCancellation(token);
    const model = await getModel(options.model);
    return generateGroupsWithModel(groups, options, model, token, recentCommits, onCandidate);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseResponse(raw: string): { message: string; reason: string } {
    // Strip markdown code fences if the model added them anyway
    const cleaned = raw
        .replace(/^```(?:json)?\s*/m, '')
        .replace(/\s*```\s*$/m, '')
        .trim();

    const tryParse = (text: string) => {
        const obj = JSON.parse(text) as unknown;
        if (
            obj &&
            typeof obj === 'object' &&
            'message' in obj &&
            'reason' in obj &&
            typeof (obj as Record<string, unknown>).message === 'string' &&
            typeof (obj as Record<string, unknown>).reason === 'string'
        ) {
            return obj as { message: string; reason: string };
        }
        return null;
    };

    // Direct parse
    try {
        const result = tryParse(cleaned);
        if (result) {
            return result;
        }
    } catch {
        // fall through
    }

    // Try to extract a JSON object from somewhere in the response
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
        try {
            const result = tryParse(jsonMatch[0]);
            if (result) {
                return result;
            }
        } catch {
            // fall through
        }
    }

    throw new Error(`Could not parse LLM response: ${raw.slice(0, 300)}`);
}

function generateId(): string {
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

// ─── AI-driven grouping, followed by per-group generation ────────────────────

/**
 * First group bounded file evidence by intent, then generate for each group.
 * Only invalid grouping output triggers local rules. Provider errors propagate.
 */
export async function generateGroupedCommits(
    changes: FileChange[],
    options: GenerateOptions,
    token: vscode.CancellationToken,
    recentCommits?: GitLogEntry[],
    onCandidate?: (candidate: CommitCandidate) => void,
): Promise<CommitCandidate[]> {
    if (changes.length === 0) {
        return [];
    }

    checkCancellation(token);
    const model = await getModel(options.model);
    const prompt = await prepareGroupingPrompt(
        changes, evidence => buildGroupingPrompt(evidence, options), model, token,
        () => checkCancellation(token),
    );
    const raw = await sendPrompt(model, prompt, token);
    let groups: FileGroup[];
    try {
        const validated = validateGrouping(parseGroupingResponse(raw), changes);
        const byPath = new Map(changes.map(file => [file.path, file]));
        groups = validated.map(group => ({
            groupType: 'misc', label: group.label,
            files: group.files.map(path => byPath.get(path)!),
        }));
    } catch {
        console.warn('[AutoCommit] Invalid AI grouping output; using local grouping rules.');
        groups = groupFiles(changes);
    }
    return generateGroupsWithModel(groups, options, model, token, recentCommits, onCandidate);
}

interface ParsedGroup { label: string; files: string[]; }

function parseGroupingResponse(raw: string): ParsedGroup[] {
    const cleaned = raw
        .replace(/^```(?:json)?\s*/m, '')
        .replace(/\s*```\s*$/m, '')
        .trim();

    const tryParse = (text: string): ParsedGroup[] | null => {
        const arr = JSON.parse(text) as unknown;
        if (!Array.isArray(arr) || arr.length === 0) {
            return null;
        }
        const out: ParsedGroup[] = [];
        for (const item of arr) {
            if (!item || typeof item !== 'object') { return null; }
            const rec = item as Record<string, unknown>;
            if (
                typeof rec.label !== 'string' ||
                rec.label.trim().length === 0 ||
                !Array.isArray(rec.files) ||
                rec.files.length === 0 ||
                !rec.files.every((f) => typeof f === 'string')
            ) {
                return null;
            }
            out.push({
                label: rec.label.trim(),
                files: rec.files as string[],
            });
        }
        return out;
    };

    try {
        const result = tryParse(cleaned);
        if (result) { return result; }
    } catch { /* fall through */ }

    const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
        try {
            const result = tryParse(arrayMatch[0]);
            if (result) { return result; }
        } catch { /* fall through */ }
    }

    throw new Error(`Could not parse grouping LLM response: ${raw.slice(0, 300)}`);
}

/**
 * Ensures every input file is referenced exactly once across all groups.
 * Returns the groups with file paths normalised to the original input casing/order.
 */
function validateGrouping(groups: ParsedGroup[], changes: FileChange[]): ParsedGroup[] {
    const validPaths = new Set(changes.map((c) => c.path));
    const seen = new Set<string>();

    for (const g of groups) {
        const normalised: string[] = [];
        for (const f of g.files) {
            if (!validPaths.has(f)) {
                throw new Error(`LLM returned unknown file path in group: ${f}`);
            }
            if (seen.has(f)) {
                throw new Error(`LLM assigned the same file to multiple groups: ${f}`);
            }
            seen.add(f);
            normalised.push(f);
        }
        g.files = normalised;
    }

    if (seen.size !== validPaths.size) {
        const missing: string[] = [];
        for (const p of validPaths) {
            if (!seen.has(p)) { missing.push(p); }
        }
        throw new Error(`LLM did not assign every file to a group. Missing: ${missing.join(', ')}`);
    }

    return groups;
}

// Re-export for callers that still need the rule-based FileGroup shape.
export type { FileGroup };

function checkCancellation(token: vscode.CancellationToken): void {
    if (token.isCancellationRequested) { throw new vscode.CancellationError(); }
}

/** Caller has already fitted and counted this prompt. */
async function sendPrompt(model: vscode.LanguageModelChat, prompt: string, token: vscode.CancellationToken): Promise<string> {
    checkCancellation(token);
    const response = await model.sendRequest([vscode.LanguageModelChatMessage.User(prompt)], {}, token);
    checkCancellation(token);
    let raw = '';
    for await (const chunk of response.text) {
        checkCancellation(token);
        raw += chunk;
    }
    checkCancellation(token);
    return raw;
}

async function generateGroupsWithModel(
    groups: FileGroup[], options: GenerateOptions, model: vscode.LanguageModelChat,
    token: vscode.CancellationToken, history?: GitLogEntry[],
    onCandidate?: (candidate: CommitCandidate) => void,
): Promise<CommitCandidate[]> {
    const candidates: CommitCandidate[] = [];
    for (const group of groups) {
        checkCancellation(token);
        const candidate = await generateGroupWithModel(group, options, model, token, history);
        checkCancellation(token);
        candidates.push(candidate);
        onCandidate?.(candidate);
    }
    checkCancellation(token);
    return candidates;
}

async function generateGroupWithModel(
    group: FileGroup, options: GenerateOptions, model: vscode.LanguageModelChat,
    token: vscode.CancellationToken, history?: GitLogEntry[],
): Promise<CommitCandidate> {
    const budget = inputBudget(model);
    const fits = (prompt: string) => fitsPrompt(prompt, model, budget, token, () => checkCancellation(token));
    let prompt = buildPrompt(group, options, history);
    if (!await fits(prompt)) {
        // Check irreducible instructions and file manifest before spending calls
        // summarizing diffs. These must fit even with no evidence attached.
        if (!await fits(buildPrompt(group, options, history, ''))) { throw new InputBudgetError(); }
        const parts = group.files.map(file => ({ path: file.path, type: file.type, offset: 0, text: file.diff }));
        let evidence = (await summarizeParts(parts, 'diffs', group.label, model, token, budget)).join('\n\n');
        prompt = buildPrompt(group, options, history, evidence);
        let rounds = 0;
        while (!await fits(prompt)) {
            if (rounds++ >= 3) { throw new InputBudgetError(); }
            const reduced = (await summarizeParts([{ text: evidence }], 'summaries', group.label, model, token, budget)).join('\n\n');
            if (reduced.length >= evidence.length) {
                throw new Error('The model did not shorten its summaries enough. Stage fewer files and generate again.');
            }
            evidence = reduced;
            prompt = buildPrompt(group, options, history, evidence);
        }
    }
    const parsed = parseResponse(await sendPrompt(model, prompt, token));
    if (!parsed.message.trim() || !parsed.reason.trim()) {
        throw new Error('The model returned an empty commit message or reason. Generate again.');
    }
    return {
        id: generateId(), message: parsed.message.trim(), reason: parsed.reason.trim(),
        files: group.files.map(file => file.path), checked: true,
    };
}

/** Split requests, never discard input. Even a single oversized file can be analyzed. */
async function summarizeParts(
    parts: EvidencePart[], source: 'diffs' | 'summaries', label: string,
    model: vscode.LanguageModelChat, token: vscode.CancellationToken, budget: number,
): Promise<string[]> {
    checkCancellation(token);
    const prompt = buildSummaryPrompt(label, parts, source);
    if (await fitsPrompt(prompt, model, budget, token, () => checkCancellation(token))) {
        const summary = (await sendPrompt(model, prompt, token)).trim();
        if (!summary) { throw new Error('The model returned an empty diff summary. Generate again.'); }
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
    const first = await summarizeParts(left, source, label, model, token, budget);
    const second = await summarizeParts(right, source, label, model, token, budget);
    return [...first, ...second];
}
