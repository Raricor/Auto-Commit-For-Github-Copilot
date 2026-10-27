import type * as vscode from 'vscode';
import type { FileChange } from '../types';

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

/** Bounded evidence for deciding intent; generation still analyzes full diffs. */
export async function prepareGroupingPrompt(
    changes: FileChange[],
    build: (evidence: FileChange[]) => string,
    model: BudgetModel,
    token: vscode.CancellationToken,
    checkCancellation: () => void,
): Promise<string> {
    const budget = inputBudget(model, 64_000);
    const stats = changes.map(file =>
        `+${(file.diff.match(/^\+(?!\+\+ )/gm) ?? []).length}` +
        ` -${(file.diff.match(/^-(?!-- )/gm) ?? []).length}; ${file.diff.length} characters.`
    );
    let limit = Math.min(1_200, Math.floor(budget * 2 / Math.max(changes.length, 1)));
    for (;;) {
        checkCancellation();
        const evidence = changes.map((file, i) => ({
            ...file,
            diff: `${stats[i]}\n${groupingExcerpt(file.diff, limit)}`,
        }));
        const prompt = build(evidence);
        if (await fitsPrompt(prompt, model, budget, token, checkCancellation)) { return prompt; }
        if (limit === 0) { throw new InputBudgetError(); }
        limit = Math.floor(limit / 2);
    }
}

function groupingExcerpt(diff: string, limit: number): string {
    if (diff.length <= limit) { return diff; }
    const size = Math.floor(limit / 3);
    if (size === 0) { return '[diff omitted]'; }
    const middle = Math.floor((diff.length - size) / 2);
    return diff.slice(0, size) + '\n[... omitted ...]\n' +
        diff.slice(middle, middle + size) + '\n[... omitted ...]\n' + diff.slice(-size);
}
