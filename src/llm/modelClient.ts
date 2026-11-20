import * as vscode from 'vscode';
import type { GenerateOptions } from '../types';
import type { Limiter } from './concurrency';
import { checkCancellation } from './cancellation';
import { fitsPrompt, inputBudget } from './promptBudget';

export interface ModelClient {
    readonly model: vscode.LanguageModelChat;
    readonly budget: number;
    /** A budgeted request; countTokens is intentionally not rate-limited. */
    fits(prompt: string): Promise<boolean>;
    /** Sends one budgeted prompt through the shared FIFO limiter. */
    send(prompt: string): Promise<string>;
}

/**
 * Errors thrown by the provider layer. Keeping the original object preserves
 * its identity for callers while letting the pipeline tell provider failures
 * apart from per-group parse/budget failures.
 */
const providerErrors = new WeakSet<object>();

export function isProviderError(error: unknown): boolean {
    return (typeof error === 'object' && error !== null) && providerErrors.has(error);
}

function markProviderError(error: unknown): void {
    if ((typeof error === 'object' && error !== null) || typeof error === 'function') {
        providerErrors.add(error as object);
    }
}

export function createModelClient(
    model: vscode.LanguageModelChat,
    options: GenerateOptions,
    token: vscode.CancellationToken,
    limiter: Limiter,
    onCancelled: () => void = () => checkCancellation(token),
    onProviderError?: (error: unknown) => void,
): ModelClient {
    const budget = inputBudget(model);
    const reportProviderError = (error: unknown): void => {
        markProviderError(error);
        onProviderError?.(error);
    };

    return {
        model,
        budget,
        async fits(prompt: string): Promise<boolean> {
            try {
                return await fitsPrompt(prompt, model, budget, token, onCancelled);
            } catch (error) {
                // countTokens is a provider round-trip too.
                reportProviderError(error);
                throw error;
            }
        },
        async send(prompt: string): Promise<string> {
            onCancelled();
            const requestOptions = requestOptionsFor(options);
            // Hold the slot for the whole request (send + streamed body), but
            // not for the surrounding group task: nested summary requests are
            // made only after this promise settles, so they cannot deadlock.
            return limiter.run(async () => {
                onCancelled();
                let response: vscode.LanguageModelChatResponse;
                try {
                    response = await model.sendRequest(
                        [vscode.LanguageModelChatMessage.User(prompt)],
                        requestOptions,
                        token,
                    );
                } catch (error) {
                    reportProviderError(error);
                    throw error;
                }
                onCancelled();

                let raw = '';
                try {
                    for await (const chunk of response.text) {
                        onCancelled();
                        raw += chunk;
                    }
                } catch (error) {
                    reportProviderError(error);
                    throw error;
                }
                onCancelled();
                return raw;
            });
        },
    };
}

/**
 * VS Code merges this `configuration` with the user's model-picker settings
 * and exposes the result to providers as `modelConfiguration`. Copilot (0.75)
 * and the DeepSeek provider both read `reasoningEffort` from there; levels a
 * model does not support are ignored. Do NOT put it in `modelOptions`:
 * Copilot forwards those as request-body parameters, which can cause a 400.
 */
function requestOptionsFor(options: GenerateOptions): vscode.LanguageModelChatRequestOptions {
    if (options.reasoningEffort) {
        return {
            configuration: { reasoningEffort: options.reasoningEffort },
        } as vscode.LanguageModelChatRequestOptions;
    }
    return {};
}
