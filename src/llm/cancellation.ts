import * as vscode from 'vscode';

export interface LinkedToken {
    /** Cancelled either by the user token or by {@link LinkedToken.abort}. */
    token: vscode.CancellationToken;
    /** Abort every in-flight request, e.g. after a provider error. */
    abort(): void;
    dispose(): void;
}

/**
 * Builds an internal cancellation token linked to the caller's token.
 * VS Code's CancellationTokenSource is not available in the test host, so the
 * extension owns this small implementation instead.
 */
export function createLinkedToken(userToken: vscode.CancellationToken): LinkedToken {
    let cancelled = false;
    const listeners = new Set<() => void>();

    const cancel = (): void => {
        if (cancelled) { return; }
        cancelled = true;
        for (const listener of [...listeners]) {
            try { listener(); } catch { /* A listener must not break cancellation. */ }
        }
        listeners.clear();
    };

    const token: vscode.CancellationToken = {
        get isCancellationRequested(): boolean {
            return cancelled || userToken.isCancellationRequested;
        },
        onCancellationRequested(listener: (event: unknown) => unknown): vscode.Disposable {
            const callback = (): void => { listener(undefined); };
            if (token.isCancellationRequested) {
                callback();
                return { dispose() { /* Already cancelled. */ } };
            }
            listeners.add(callback);
            return {
                dispose() { listeners.delete(callback); },
            };
        },
    };

    const subscription = userToken.onCancellationRequested(cancel);

    return {
        token,
        abort: cancel,
        dispose(): void {
            subscription.dispose();
            listeners.clear();
        },
    };
}

export function checkCancellation(token: vscode.CancellationToken): void {
    if (token.isCancellationRequested) {
        throw new vscode.CancellationError();
    }
}
