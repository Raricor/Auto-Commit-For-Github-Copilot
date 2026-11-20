import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { RefObject } from 'react';

interface PendingFlip {
    keys: string[];
    positions: Map<string, number>;
}

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function prefersReducedMotion(): boolean {
    return typeof window !== 'undefined' && window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

function flipElements(container: HTMLElement): Map<string, HTMLElement> {
    const elements = new Map<string, HTMLElement>();
    for (const element of Array.from(container.querySelectorAll<HTMLElement>('[data-flip-key]'))) {
        const key = element.dataset.flipKey;
        if (key) elements.set(key, element);
    }
    return elements;
}

/**
 * FLIP animation for the commit list. `capture()` must be called before the
 * state update that applies the new order; the layout effect then measures the
 * new positions, inverts the movement with a transform and releases it on the
 * next frame. Reduced-motion users skip the movement entirely.
 */
export function useFlip(keys: string[], containerRef: RefObject<HTMLElement | null>) {
    const pendingRef = useRef<PendingFlip | null>(null);
    const keysRef = useRef(keys);
    const frameRef = useRef<number | null>(null);
    const timersRef = useRef<number[]>([]);
    keysRef.current = keys;

    const clearScheduled = useCallback(() => {
        if (frameRef.current !== null) {
            cancelAnimationFrame(frameRef.current);
            frameRef.current = null;
        }
        for (const timer of timersRef.current) window.clearTimeout(timer);
        timersRef.current = [];
    }, []);

    const resetInlineMotion = useCallback((elements: Iterable<HTMLElement>) => {
        for (const element of elements) {
            element.style.transition = '';
            element.style.transitionDelay = '';
            element.style.transform = '';
            element.style.willChange = '';
        }
    }, []);

    const capture = useCallback(() => {
        const container = containerRef.current;
        if (!container) {
            pendingRef.current = null;
            return;
        }

        // Drop any in-flight transform so the measurement is not offset.
        clearScheduled();
        const elements = flipElements(container);
        resetInlineMotion(elements.values());

        const positions = new Map<string, number>();
        for (const [key, element] of elements) {
            positions.set(key, element.getBoundingClientRect().top);
        }
        pendingRef.current = { keys: keysRef.current.slice(), positions };
    }, [clearScheduled, containerRef, resetInlineMotion]);

    const signature = keys.join('\u0000');

    useLayoutEffect(() => {
        const pending = pendingRef.current;
        pendingRef.current = null;
        if (!pending) return;

        const container = containerRef.current;
        if (!container) return;
        if (prefersReducedMotion()) return;
        if (pending.keys.length === keys.length && pending.keys.every((key, index) => key === keys[index])) {
            return;
        }

        const elements = flipElements(container);
        const changed: Array<{ element: HTMLElement; delta: number; top: number }> = [];
        for (const key of keys) {
            const element = elements.get(key);
            const oldTop = pending.positions.get(key);
            if (!element || oldTop === undefined) continue;
            const newTop = element.getBoundingClientRect().top;
            const delta = oldTop - newTop;
            if (Math.abs(delta) >= 0.5) changed.push({ element, delta, top: newTop });
        }
        if (changed.length === 0) return;

        clearScheduled();
        // Stagger by the card's new position on screen, top to bottom.
        changed.sort((a, b) => a.top - b.top);
        for (const item of changed) {
            item.element.style.transition = 'none';
            item.element.style.transform = `translateY(${item.delta}px)`;
            item.element.style.willChange = 'transform';
        }
        // Flush the inverted styles before starting the transition next frame.
        void container.offsetHeight;

        frameRef.current = requestAnimationFrame(() => {
            frameRef.current = null;
            changed.forEach((item, rank) => {
                item.element.style.transition = 'transform 420ms cubic-bezier(0.2, 0, 0, 1)';
                item.element.style.transitionDelay = `${rank * 25}ms`;
                item.element.style.transform = 'translateY(0)';
            });

            const duration = 420 + changed.length * 25 + 80;
            timersRef.current.push(window.setTimeout(() => {
                resetInlineMotion(changed.map((item) => item.element));
                timersRef.current = [];
            }, duration));
        });
    }, [signature, keys, containerRef, clearScheduled, resetInlineMotion]);

    useEffect(() => clearScheduled, [clearScheduled]);

    return { capture };
}
