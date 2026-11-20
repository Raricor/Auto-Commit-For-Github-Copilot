/**
 * Removes model "thinking" blocks. Some providers expose them in the normal
 * text stream even though the JSON answer follows afterwards.
 */
export function stripThinking(raw: string): string {
    return raw.replace(/<think(?:ing)?\b[^>]*>[\s\S]*?<\/think(?:ing)?>/gi, '');
}

/**
 * Finds the first balanced JSON value accepted by `validate`.
 * A regex cannot do this safely: braces and brackets may appear inside JSON
 * strings, and escaped quotes must not end the string early.
 */
export function findJsonValue<T>(
    raw: string,
    open: '{' | '[',
    close: '}' | ']',
    validate: (value: unknown) => T | null,
): T | null {
    for (let start = raw.indexOf(open); start !== -1; start = raw.indexOf(open, start + 1)) {
        let depth = 0;
        let inString = false;
        let escaped = false;

        for (let index = start; index < raw.length; index++) {
            const char = raw[index];
            if (inString) {
                if (escaped) {
                    escaped = false;
                } else if (char === '\\') {
                    escaped = true;
                } else if (char === '"') {
                    inString = false;
                }
                continue;
            }
            if (char === '"') {
                inString = true;
            } else if (char === open) {
                depth += 1;
            } else if (char === close) {
                depth -= 1;
                if (depth === 0) {
                    try {
                        const parsed = validate(JSON.parse(raw.slice(start, index + 1)));
                        if (parsed !== null) { return parsed; }
                    } catch {
                        // Not valid JSON at this position; try the next opener.
                    }
                    break;
                }
            }
        }
    }
    return null;
}
