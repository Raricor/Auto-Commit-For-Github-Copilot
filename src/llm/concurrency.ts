/**
 * A FIFO limiter for provider requests. Callers hold a slot only while a
 * request is actually in flight, so a generation task may wait for nested
 * summary requests without deadlocking the queue.
 */
export interface Limiter {
    run<T>(fn: () => Promise<T>): Promise<T>;
}

export function createLimiter(limit: number): Limiter {
    const max = Math.max(1, Math.floor(limit));
    let active = 0;
    const waiting: Array<() => void> = [];

    const drain = (): void => {
        while (active < max && waiting.length > 0) {
            waiting.shift()!();
        }
    };

    return {
        run<T>(fn: () => Promise<T>): Promise<T> {
            return new Promise<T>((resolve, reject) => {
                const start = (): void => {
                    active += 1;
                    fn().then(resolve, reject).finally(() => {
                        active -= 1;
                        drain();
                    });
                };
                if (active < max) {
                    start();
                } else {
                    waiting.push(start);
                }
            });
        },
    };
}
