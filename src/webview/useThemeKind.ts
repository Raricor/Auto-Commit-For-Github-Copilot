import { useSyncExternalStore } from 'react';
import type { ThemeKind } from './fileIcons';

let currentKind: ThemeKind | undefined;
const listeners = new Set<() => void>();
let observer: MutationObserver | undefined;

function readThemeKind(): ThemeKind {
    const classes = document.body.classList;
    return classes.contains('vscode-light') || classes.contains('vscode-high-contrast-light')
        ? 'light'
        : 'dark';
}

function getSnapshot(): ThemeKind {
    if (currentKind === undefined) {
        currentKind = readThemeKind();
    }
    return currentKind;
}

function notify(): void {
    const next = readThemeKind();
    if (next === currentKind) {
        return;
    }
    currentKind = next;
    for (const listener of listeners) {
        listener();
    }
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    if (observer === undefined) {
        observer = new MutationObserver(notify);
        observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    }

    // Catch a class change that happened between render and subscription.
    notify();

    return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && observer !== undefined) {
            observer.disconnect();
            observer = undefined;
        }
    };
}

/** Tracks the webview theme class set by VS Code on document.body. */
export function useThemeKind(): ThemeKind {
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
