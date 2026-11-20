import * as vscode from 'vscode';
import type { GenerateOptions, ReasoningEffort } from '../types';

const MIN_COMMITS_LIMIT = 200;
const MAX_COMMITS_LIMIT = 200;
const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 8;

const REASONING_EFFORTS: ReadonlyArray<ReasoningEffort | ''> = [
    '', 'none', 'low', 'medium', 'high', 'xhigh', 'max',
];

export function getSettings(): GenerateOptions {
    const config = vscode.workspace.getConfiguration('autocommit-for-github-copilot');
    return {
        conventionalCommits: config.get<boolean>('conventionalCommits', true),
        language: config.get<string>('language', 'en'),
        model: config.get<string>('model', ''),
        minCommits: clampInteger(config.get<number>('minCommits', 0), 0, MIN_COMMITS_LIMIT, 0),
        maxCommits: clampInteger(config.get<number>('maxCommits', 0), 0, MAX_COMMITS_LIMIT, 0),
        reasoningEffort: normalizeReasoningEffort(
            config.get<string>('reasoningEffort', '')
        ),
        concurrency: clampInteger(
            config.get<number>('concurrency', 4),
            MIN_CONCURRENCY,
            MAX_CONCURRENCY,
            4
        ),
    };
}

export async function updateSettings(partial: Partial<GenerateOptions>): Promise<void> {
    const config = vscode.workspace.getConfiguration('autocommit-for-github-copilot');
    if (partial.conventionalCommits !== undefined) {
        await config.update(
            'conventionalCommits',
            partial.conventionalCommits,
            vscode.ConfigurationTarget.Global
        );
    }
    if (partial.language !== undefined) {
        await config.update('language', partial.language, vscode.ConfigurationTarget.Global);
    }
    if (partial.model !== undefined) {
        await config.update('model', partial.model || '', vscode.ConfigurationTarget.Global);
    }
    if (partial.minCommits !== undefined) {
        await config.update(
            'minCommits',
            clampInteger(partial.minCommits, 0, MIN_COMMITS_LIMIT, 0),
            vscode.ConfigurationTarget.Global
        );
    }
    if (partial.maxCommits !== undefined) {
        await config.update(
            'maxCommits',
            clampInteger(partial.maxCommits, 0, MAX_COMMITS_LIMIT, 0),
            vscode.ConfigurationTarget.Global
        );
    }
    if (partial.reasoningEffort !== undefined) {
        await config.update(
            'reasoningEffort',
            normalizeReasoningEffort(partial.reasoningEffort),
            vscode.ConfigurationTarget.Global
        );
    }
    if (partial.concurrency !== undefined) {
        await config.update(
            'concurrency',
            clampInteger(partial.concurrency, MIN_CONCURRENCY, MAX_CONCURRENCY, 4),
            vscode.ConfigurationTarget.Global
        );
    }
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
    const numeric = typeof value === 'number' ? value : Number(value);
    if (Number.isNaN(numeric)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, Math.floor(numeric)));
}

function normalizeReasoningEffort(value: unknown): ReasoningEffort | '' {
    if (typeof value !== 'string') {
        return '';
    }
    return REASONING_EFFORTS.includes(value as ReasoningEffort | '')
        ? value as ReasoningEffort | ''
        : '';
}
