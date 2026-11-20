import type { ExtensionMessage } from '../types';

/** Typed wrapper around the VS Code webview API. */
interface VSCodeAPI {
    postMessage(msg: unknown): void;
    getState(): unknown;
    setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VSCodeAPI;

const vscode = acquireVsCodeApi();

export function postMessage(msg: import('../types').WebviewMessage): void {
    vscode.postMessage(msg);
}

export function getState(): unknown {
    return vscode.getState();
}

export function setState(state: unknown): void {
    vscode.setState(state);
}

export type MessageHandler = (msg: ExtensionMessage) => void;

let handler: MessageHandler | undefined;

window.addEventListener('message', (ev: MessageEvent<ExtensionMessage>) => {
    handler?.(ev.data);
});

export function onMessage(fn: MessageHandler): () => void {
    handler = fn;
    return () => { handler = undefined; };
}
