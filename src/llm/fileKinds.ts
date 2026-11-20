import * as path from 'path';

/**
 * Files whose content is never useful for intent detection: dependency
 * lockfiles and generated/minified artifacts. Sending them costs requests and
 * often dwarfs every hand-written file in the same change.
 */
const STATS_ONLY_NAMES = new Set([
    'package-lock.json',
    'yarn.lock',
    'pnpm-lock.yaml',
    'npm-shrinkwrap.json',
    'cargo.lock',
    'poetry.lock',
    'pipfile.lock',
    'composer.lock',
    'gemfile.lock',
    'go.sum',
]);

const STATS_ONLY_SUFFIXES = ['.min.js', '.min.css', '.map', '.snap'];

/** True when only statistics should be sent for this path, never its diff text. */
export function isStatsOnly(filePath: string): boolean {
    const normalized = filePath.replace(/\\/g, '/');
    const fileName = path.posix.basename(normalized).toLowerCase();

    if (STATS_ONLY_NAMES.has(fileName)) {
        return true;
    }
    if (STATS_ONLY_SUFFIXES.some(suffix => fileName.endsWith(suffix))) {
        return true;
    }
    return normalized.split('/').includes('__snapshots__');
}
