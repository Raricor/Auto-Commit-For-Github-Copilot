import assert from 'node:assert/strict';
import test from 'node:test';
import type { CancellationToken } from 'vscode';
import type {
    CommitCandidate, FileChange, GenerateOptions, GenerationProgress, NoticeLevel,
} from '../src/types';

// VS Code is only available inside the extension host. Replace that boundary;
// grouping, budgeting, concurrency, ordering and generation all stay real.
const nodeModule = require('node:module');
const originalLoad = nodeModule._load;
class CancellationError extends Error {}
let activeModel: ReturnType<typeof setup>['model'];
nodeModule._load = function (id: string, ...args: unknown[]) {
    if (id === 'vscode') {
        return {
            lm: { selectChatModels: async () => [activeModel] },
            LanguageModelChatMessage: { User: (text: string) => ({ content: [{ value: text }] }) },
            CancellationError,
        };
    }
    return originalLoad.call(this, id, ...args);
};
const service = require('../src/llm/llmService') as typeof import('../src/llm/llmService');
const generation = require('../src/llm/generation') as typeof import('../src/llm/generation');
const preGroupModule = require('../src/llm/preGroup') as typeof import('../src/llm/preGroup');
const rangeModule = require('../src/llm/commitRange') as typeof import('../src/llm/commitRange');
const promptBuilderModule = require('../src/llm/promptBuilder') as typeof import('../src/llm/promptBuilder');
nodeModule._load = originalLoad;

const options: GenerateOptions = { conventionalCommits: true, language: 'en' };
const reply = (message: string) => JSON.stringify({ message, reason: 'Keep the intended behavior consistent.' });
const change = (path: string, diff = '+new behavior\n'): FileChange => ({ path, type: 'modified', diff });

function cancellation() {
    let cancelled = false;
    const listeners = new Set<(event?: unknown) => unknown>();
    const token = {
        get isCancellationRequested() { return cancelled; },
        onCancellationRequested(listener: (event?: unknown) => unknown) {
            if (cancelled) {
                listener();
                return { dispose() { /* Already cancelled. */ } };
            }
            listeners.add(listener);
            return { dispose() { listeners.delete(listener); } };
        },
    };
    return {
        token: token as CancellationToken,
        cancel: () => {
            if (cancelled) { return; }
            cancelled = true;
            for (const listener of [...listeners]) { listener(); }
            listeners.clear();
        },
    };
}

type HandlerResult = string | Error;
type Handler = (prompt: string, call: number, token: CancellationToken) => HandlerResult | Promise<HandlerResult>;

function setup(handler: Handler, maxInputTokens = 128_000, charsPerToken = 3) {
    const prompts: string[] = [];
    const counted: string[] = [];
    const requestOptions: unknown[] = [];
    let calls = 0;

    const model = {
        id: 'test-model', name: 'Test model', maxInputTokens,
        countTokens: async (text: string) => {
            counted.push(text);
            return Math.ceil(Buffer.byteLength(text) / charsPerToken);
        },
        sendRequest: async (
            messages: Array<{ content: Array<{ value: string }> }>,
            requestOptionsSeen?: unknown,
            token?: CancellationToken,
        ) => {
            const prompt = messages.map(message => message.content.map(part => part.value).join('')).join('');
            prompts.push(prompt);
            requestOptions.push(requestOptionsSeen ?? {});
            const call = calls++;
            return {
                text: (async function* () {
                    const result = await handler(prompt, call, token!);
                    if (result instanceof Error) { throw result; }
                    const middle = Math.floor(result.length / 2);
                    yield result.slice(0, middle);
                    await Promise.resolve();
                    yield result.slice(middle);
                })(),
            };
        },
    };
    activeModel = model;
    service.clearModelCache();
    return { model, prompts, counted, requestOptions };
}

interface Sink {
    notices: Array<{ level: NoticeLevel; message: string }>;
    progress: GenerationProgress[];
    reorders: string[][];
    confirmations: Array<{ groups: number; requests: number; stage: string }>;
    events: Parameters<typeof service.generateCommits>[4];
}

function sink(acceptConfirmation = true): Sink {
    const notices: Sink['notices'] = [];
    const progress: GenerationProgress[] = [];
    const reorders: string[][] = [];
    const confirmations: Sink['confirmations'] = [];
    return {
        notices, progress, reorders, confirmations,
        events: {
            onNotice: (level, message) => notices.push({ level, message }),
            onProgress: value => progress.push(value),
            onReorder: ids => reorders.push(ids),
            confirmRequests: async estimate => {
                confirmations.push({ ...estimate });
                return acceptConfirmation;
            },
        },
    };
}

const isGrouping = (prompt: string) => prompt.startsWith('You are an expert Git commit assistant.');
const isMerge = (prompt: string) => prompt.startsWith('You are an expert Git commit merger.');
const isOrdering = (prompt: string) => prompt.startsWith('You are an expert Git commit orderer.');
const isGeneration = (prompt: string) => prompt.includes('commit message generator');
const isSummary = (prompt: string) => prompt.startsWith('Summarize the supplied');

function groupingFiles(prompt: string): string[] {
    return [...prompt.matchAll(/^--- FILE: (.+?) \([^)]*\) ---$/gm)].map(match => match[1]);
}

function mergeIds(prompt: string): string[] {
    return [...prompt.matchAll(/^- (g\d+): label:/gm)].map(match => match[1]);
}

function orderIds(prompt: string): string[] {
    return [...prompt.matchAll(/^- (c\d+)$/gm)].map(match => match[1]);
}

function groupingReply(prompt: string, chunkSize = Number.MAX_SAFE_INTEGER): string {
    const files = groupingFiles(prompt);
    const groups: Array<{ label: string; files: string[] }> = [];
    for (let index = 0; index < files.length; index += chunkSize) {
        groups.push({
            label: `Intent ${groups.length + 1}`,
            files: files.slice(index, index + chunkSize),
        });
    }
    return JSON.stringify(groups);
}

function mergeSingletonReply(prompt: string): string {
    return JSON.stringify(mergeIds(prompt).map(id => ({ label: `Merged ${id}`, groups: [id] })));
}

function orderOriginalReply(prompt: string): string {
    return JSON.stringify(orderIds(prompt));
}

function groupLabel(prompt: string): string {
    const match = prompt.match(/\nGroup: (.*)\n/);
    return match ? match[1] : 'group';
}

function defaultHandler(chunkSize = Number.MAX_SAFE_INTEGER): Handler {
    return (prompt) => {
        if (isSummary(prompt)) { return 'Summary of the supplied changes.'; }
        if (isGrouping(prompt)) { return groupingReply(prompt, chunkSize); }
        if (isMerge(prompt)) { return mergeSingletonReply(prompt); }
        if (isGeneration(prompt)) { return reply(`feat: ${groupLabel(prompt)}`); }
        if (isOrdering(prompt)) { return orderOriginalReply(prompt); }
        throw new Error(`unexpected prompt: ${prompt.slice(0, 80)}`);
    };
}

function scaleChanges(): FileChange[] {
    const files: FileChange[] = [];
    const add = (path: string, lines: number): void => {
        files.push(change(path, '+updated behavior in this file\n'.repeat(lines)));
    };
    for (let moduleIndex = 0; moduleIndex < 10; moduleIndex++) {
        for (let fileIndex = 0; fileIndex < 80; fileIndex++) {
            const sub = Math.floor(fileIndex / 20);
            add(`src/module-${moduleIndex}/sub-${sub}/file-${fileIndex}.ts`, 70);
        }
    }
    for (let fileIndex = 0; fileIndex < 300; fileIndex++) {
        add(`tests/module-${fileIndex % 10}/spec-${fileIndex}.test.ts`, 70);
    }
    for (let fileIndex = 0; fileIndex < 195; fileIndex++) {
        add(`docs/guide-${fileIndex}.md`, 50);
    }
    add('package-lock.json', 10_000);
    add('yarn.lock', 3000);
    add('pnpm-lock.yaml', 3000);
    add('src/app.ts', 70);
    add('src/index.ts', 70);
    return files;
}

function totalLines(changes: FileChange[]): number {
    return changes.reduce((sum, file) => sum + file.diff.split('\n').length, 0);
}

function assertEveryPromptFits(env: ReturnType<typeof setup>, maxInputTokens: number, charsPerToken = 3): void {
    const budget = Math.floor(maxInputTokens * 0.8);
    for (const prompt of env.prompts) {
        const tokens = Math.ceil(Buffer.byteLength(prompt) / charsPerToken);
        assert.ok(tokens <= budget, `prompt needs ${tokens} tokens, budget is ${budget}`);
    }
}

function assertAllFilesOnce(groups: Array<{ files: string[] }>, changes: FileChange[]): void {
    const actual = groups.flatMap(group => group.files);
    assert.equal(actual.length, changes.length, 'every file appears exactly once');
    assert.equal(new Set(actual).size, changes.length, 'no duplicate file');
    assert.deepEqual([...actual].sort(), changes.map(file => file.path).sort());
}

// ─── preGroup ────────────────────────────────────────────────────────────────

test('preGroup is deterministic, partitions every path once and respects maxFiles', () => {
    const paths = [
        'src/a/one.ts', 'src/a/two.ts',
        'src/b/one.ts', 'src/b/two.ts',
        'src/big/1.ts', 'src/big/2.ts', 'src/big/3.ts', 'src/big/4.ts',
        'src/big/5.ts', 'src/big/6.ts', 'src/big/7.ts', 'src/big/8.ts',
        'docs/readme.md', 'docs/guide.md',
    ];
    const first = preGroupModule.preGroup(paths, 5);
    const second = preGroupModule.preGroup(paths, 5);
    assert.deepEqual(first, second, 'same input produces the same buckets');

    const flattened = first.flat();
    assert.equal(flattened.length, paths.length);
    assert.deepEqual([...flattened].sort(), [...paths].sort());
    for (const bucket of first) {
        assert.ok(bucket.length <= 5, `bucket has ${bucket.length} files`);
        assert.deepEqual(bucket, [...bucket].sort(), 'bucket paths are sorted');
    }
});

test('preGroup packs small sibling directories together and keeps same-stem files adjacent', () => {
    const paths = [
        'src/a/1.ts', 'src/a/2.ts',
        'src/b/1.ts', 'src/b/2.ts',
        'src/big/1.ts', 'src/big/2.ts', 'src/big/3.ts', 'src/big/4.ts',
        'src/big/5.ts', 'src/big/6.ts', 'src/big/7.ts', 'src/big/8.ts',
    ];
    const buckets = preGroupModule.preGroup(paths, 5);
    const siblings = buckets.find(bucket => bucket.includes('src/a/1.ts'));
    assert.ok(siblings, 'a bucket contains src/a');
    assert.ok(siblings!.includes('src/b/1.ts'), 'small sibling directories share a bucket');
    assert.ok(siblings!.includes('src/b/2.ts'));

    const trio = ['src/foo.ts', 'src/foo.test.ts', 'src/foo.css'];
    const withBig = [...trio, ...Array.from({ length: 8 }, (_, i) => `src/huge/file-${i}.ts`)];
    const trioBuckets = preGroupModule.preGroup(withBig, 4);
    const trioBucket = trioBuckets.find(bucket => bucket.includes('src/foo.ts'));
    assert.ok(trioBucket);
    assert.ok(trioBucket!.includes('src/foo.test.ts'));
    assert.ok(trioBucket!.includes('src/foo.css'));
});

test('preGroup recursively splits deep directories larger than maxFiles', () => {
    const paths = Array.from({ length: 40 }, (_, i) => `src/deep/module-${i % 2}/sub/file-${i}.ts`);
    const buckets = preGroupModule.preGroup(paths, 5);
    assert.ok(buckets.length > 1);
    for (const bucket of buckets) {
        assert.ok(bucket.length <= 5);
    }
    assert.equal(buckets.flat().length, paths.length);
});

// ─── commit range pure functions ─────────────────────────────────────────────

test('mergeToMax merges the longest shared directory prefix and joins labels', () => {
    const groups = [
        { label: 'Feature A', files: ['src/a/one.ts', 'src/a/two.ts'] },
        { label: 'Feature B', files: ['src/b/three.ts'] },
        { label: 'Docs', files: ['docs/readme.md'] },
    ];
    const merged = rangeModule.mergeToMax(groups, 2);
    assert.equal(merged.length, 2);
    assert.equal(merged[0].label, 'Feature A; Feature B');
    assert.deepEqual(merged[0].files, ['src/a/one.ts', 'src/a/two.ts', 'src/b/three.ts']);
    assert.deepEqual(merged[1].files, ['docs/readme.md']);
});

test('mergeToMax breaks prefix ties by the smallest merged file count', () => {
    const groups = [
        { label: 'Large', files: ['a.ts', 'b.ts'] },
        { label: 'Small 1', files: ['c.ts'] },
        { label: 'Small 2', files: ['d.ts'] },
    ];
    const merged = rangeModule.mergeToMax(groups, 2);
    assert.equal(merged.length, 2);
    assert.deepEqual(merged[0].files, ['a.ts', 'b.ts']);
    assert.equal(merged[1].label, 'Small 1; Small 2');
    assert.deepEqual(merged[1].files, ['c.ts', 'd.ts']);
});

test('mergeToMax merges 400 groups down to 10 quickly', () => {
    const groups = Array.from({ length: 400 }, (_, groupIndex) => ({
        label: `Group ${groupIndex}`,
        files: Array.from({ length: 3 }, (_, fileIndex) =>
            `src/module-${groupIndex % 20}/sub-${Math.floor(groupIndex / 20) % 20}` +
            `/file-${groupIndex}-${fileIndex}.ts`),
    }));

    const started = Date.now();
    const merged = rangeModule.mergeToMax(groups, 10);
    const elapsed = Date.now() - started;

    assert.equal(merged.length, 10);
    const files = merged.flatMap(group => group.files);
    assert.equal(files.length, 1200);
    assert.equal(new Set(files).size, 1200);
    assert.ok(elapsed < 2_000, `mergeToMax took ${elapsed}ms for 400 groups`);
});

test('splitToMin splits by subdirectory, then by sorted halves, and never splits single files', () => {
    const byDirectory = rangeModule.splitToMin([
        { label: 'Feature', files: ['src/a/one.ts', 'src/a/two.ts', 'src/b/three.ts'] },
    ], 2);
    assert.deepEqual(byDirectory.map(group => group.label), ['Feature (a)', 'Feature (b)']);
    assert.deepEqual(byDirectory.map(group => group.files), [
        ['src/a/one.ts', 'src/a/two.ts'],
        ['src/b/three.ts'],
    ]);

    const byHalf = rangeModule.splitToMin([
        { label: 'Feature', files: ['d.ts', 'c.ts', 'b.ts', 'a.ts'] },
    ], 2);
    assert.deepEqual(byHalf.map(group => group.label), ['Feature (part 1)', 'Feature (part 2)']);
    assert.deepEqual(byHalf.map(group => group.files), [['a.ts', 'b.ts'], ['c.ts', 'd.ts']]);

    const single = rangeModule.splitToMin([{ label: 'One', files: ['only.ts'] }], 3);
    assert.deepEqual(single, [{ label: 'One', files: ['only.ts'] }]);
});

test('resolveCommitRange truncates the minimum, ignores it when above the maximum, and notices both', () => {
    const truncated = rangeModule.resolveCommitRange(5, 0, 3);
    assert.equal(truncated.min, 3);
    assert.equal(truncated.max, Number.POSITIVE_INFINITY);
    assert.deepEqual(truncated.notices, [{
        level: 'info',
        message: 'Only 3 files are staged; using at least 3 commits instead of 5.',
    }]);

    const contradictory = rangeModule.resolveCommitRange(5, 2, 10);
    assert.equal(contradictory.min, 0);
    assert.equal(contradictory.max, 2);
    assert.equal(contradictory.notices.some(notice => notice.level === 'warning'), true);
});

// ─── 1300-file scale runs ────────────────────────────────────────────────────

async function runScale(maxInputTokens: number) {
    const changes = scaleChanges();
    const env = setup(defaultHandler(20), maxInputTokens);
    const events = sink(true);
    const result = await service.generateCommits(
        changes, options, cancellation().token, undefined, events.events,
    );
    return { changes, env, events, result };
}

test('1300 files and ~100k diff lines complete with every request inside a 128k-token budget', async () => {
    const { changes, env, events, result } = await runScale(128_000);

    assert.equal(changes.length, 1300);
    assert.ok(totalLines(changes) >= 100_000, `fixture has ${totalLines(changes)} diff lines`);
    assert.equal(result.failed.length, 0);
    assert.equal(result.declined, undefined);
    assertAllFilesOnce(result.groups, changes);

    const buckets = preGroupModule.preGroup(changes.map(file => file.path));
    const groupingPrompts = env.prompts.filter(isGrouping);
    const mergePrompts = env.prompts.filter(isMerge);
    assert.equal(groupingPrompts.length, buckets.length, 'one grouping request per bucket');
    assert.equal(mergePrompts.length, 1, 'exactly one cross-batch merge request');
    assertEveryPromptFits(env, 128_000);
    assert.ok(events.confirmations.some(estimate =>
        estimate.stage === 'generation' && estimate.requests > service.CONFIRM_REQUEST_THRESHOLD));
    assert.ok(events.progress.some(progress =>
        progress.stage === 'grouping' && /pre-grouped into \d+ folders/.test(progress.detail ?? '')));
    assert.equal(result.order?.length, result.candidates.length);
});

test('the same 1300-file repository also completes on a 32k-token model', async () => {
    const { changes, env, result } = await runScale(32_000);

    assert.equal(result.failed.length, 0);
    assertAllFilesOnce(result.groups, changes);
    assertEveryPromptFits(env, 32_000);
    assert.equal(env.prompts.filter(isMerge).length, 1);
});

// ─── bucket fallback ─────────────────────────────────────────────────────────

test('a bucket with two invalid replies falls back alone and reports one aggregated notice', async () => {
    const changes = [
        ...Array.from({ length: 80 }, (_, i) => change(`src/aaa/file-${i}.ts`)),
        ...Array.from({ length: 30 }, (_, i) => change(`src/bbb/file-${i}.ts`)),
        ...Array.from({ length: 20 }, (_, i) => change(`tests/ccc/file-${i}.test.ts`)),
    ];
    const bucketCount = preGroupModule.preGroup(changes.map(file => file.path)).length;
    const env = setup((prompt) => {
        if (isSummary(prompt)) { return 'summary'; }
        if (isGrouping(prompt)) {
            return groupingFiles(prompt).includes('src/aaa/file-0.ts')
                ? 'not JSON at all'
                : groupingReply(prompt);
        }
        if (isMerge(prompt)) {
            return JSON.stringify([...prompt.matchAll(/^- (g\d+): label: (.*?); \d+ file/gm)]
                .map(match => ({ label: match[2], groups: [match[1]] })));
        }
        if (isGeneration(prompt)) { return reply(`feat: ${groupLabel(prompt)}`); }
        if (isOrdering(prompt)) { return orderOriginalReply(prompt); }
        throw new Error('unexpected prompt');
    }, 128_000);
    const events = sink(true);

    const result = await service.generateCommits(
        changes, options, cancellation().token, undefined, events.events,
    );

    assert.equal(result.failed.length, 0);
    assertAllFilesOnce(result.groups, changes);
    assert.equal(events.notices.length, 1, 'only the aggregated fallback notice is emitted');
    assert.equal(events.notices[0].level, 'warning');
    assert.equal(
        events.notices[0].message,
        `AI grouping fell back to folder rules in 1 of ${bucketCount} batches.`,
    );
    // The broken batch fell back to local rules, the other batches kept AI labels.
    assert.ok(result.groups.some(group => group.label.startsWith('Intent ')), 'other buckets still use AI groups');
    assert.ok(env.prompts.filter(isGrouping).length >= bucketCount, 'every batch was attempted once');
});

// ─── cross-bucket merge ─────────────────────────────────────────────────────

function mergeFixture(): FileChange[] {
    return [
        ...Array.from({ length: 60 }, (_, i) => change(`src/feature/f-${i}.ts`)),
        ...Array.from({ length: 60 }, (_, i) => change(`tests/feature/f-${i}.test.ts`)),
        ...Array.from({ length: 10 }, (_, i) => change(`docs/feature-${i}.md`)),
    ];
}

function labeledGroupingReply(prompt: string): string {
    const files = groupingFiles(prompt);
    const label = files.some(file => file.startsWith('docs/'))
        ? 'Docs'
        : files.some(file => file.startsWith('tests/')) ? 'Tests' : 'Feature';
    return JSON.stringify([{ label, files }]);
}

test('the merge reply can join groups from different buckets', async () => {
    const changes = mergeFixture();
    const env = setup((prompt) => {
        if (isSummary(prompt)) { return 'summary'; }
        if (isGrouping(prompt)) { return labeledGroupingReply(prompt); }
        if (isMerge(prompt)) {
            const entries = [...prompt.matchAll(/^- (g\d+): label: (.*?); \d+ file/gm)]
                .map(match => ({ id: match[1], label: match[2] }));
            const docs = entries.filter(entry => entry.label === 'Docs');
            const feature = entries.filter(entry => entry.label !== 'Docs');
            return JSON.stringify([
                { label: 'Feature docs', groups: docs.map(entry => entry.id) },
                { label: 'Feature and tests', groups: feature.map(entry => entry.id) },
            ]);
        }
        if (isGeneration(prompt)) { return reply(`feat: ${groupLabel(prompt)}`); }
        if (isOrdering(prompt)) { return orderOriginalReply(prompt); }
        throw new Error('unexpected prompt');
    }, 128_000);

    const result = await service.generateCommits(
        changes, options, cancellation().token, undefined, sink(true).events,
    );

    assert.equal(result.groups.length, 2);
    const docs = result.groups.find(group => group.label === 'Feature docs');
    const feature = result.groups.find(group => group.label === 'Feature and tests');
    assert.ok(docs, 'the docs group survived the merge');
    assert.ok(feature, 'the feature and test groups were merged');
    assert.equal(feature!.files.length, 120);
    assert.equal(docs!.files.length, 10);
    assertAllFilesOnce(result.groups, changes);
    assert.equal(env.prompts.filter(isMerge).length, 1);
});

test('invalid merge output twice keeps the batches separate with a warning', async () => {
    const changes = mergeFixture();
    setup((prompt) => {
        if (isSummary(prompt)) { return 'summary'; }
        if (isGrouping(prompt)) { return groupingReply(prompt); }
        if (isMerge(prompt)) { return 'not JSON'; }
        if (isGeneration(prompt)) { return reply(`feat: ${groupLabel(prompt)}`); }
        if (isOrdering(prompt)) { return orderOriginalReply(prompt); }
        throw new Error('unexpected prompt');
    }, 128_000);
    const events = sink(true);

    const result = await service.generateCommits(
        changes, options, cancellation().token, undefined, events.events,
    );

    assert.equal(result.groups.length, 3, 'the three batch groups stay separate');
    assertAfterMergeWarning(events.notices);
    assertAllFilesOnce(result.groups, changes);
});

function assertAfterMergeWarning(notices: Sink['notices']): void {
    assert.ok(notices.some(notice =>
        notice.level === 'warning' && notice.message === 'AI merge output was invalid twice; kept folder batches separate.'),
    'the merge failure is reported once');
}

// ─── commit-count range ──────────────────────────────────────────────────────

function groupingFromPrompt(prompt: string, chunkSize: number): string {
    const files = groupingFiles(prompt);
    return JSON.stringify(Array.from({ length: Math.ceil(files.length / chunkSize) }, (_, index) => ({
        label: `Intent ${index + 1}`,
        files: files.slice(index * chunkSize, (index + 1) * chunkSize),
    })));
}

test('too many groups asks once with feedback, then deterministically merges to the maximum', async () => {
    const changes = Array.from({ length: 12 }, (_, i) => change(`src/f-${i}.ts`));
    const env = setup((prompt) => {
        if (isSummary(prompt)) { return 'summary'; }
        if (isGrouping(prompt)) { return groupingFromPrompt(prompt, 2); }
        if (isGeneration(prompt)) { return reply(`feat: ${groupLabel(prompt)}`); }
        if (isOrdering(prompt)) { return orderOriginalReply(prompt); }
        throw new Error('unexpected prompt');
    }, 128_000);
    const events = sink(true);

    const result = await service.generateCommits(
        changes, { ...options, maxCommits: 3 }, cancellation().token, undefined, events.events,
    );

    const groupingPrompts = env.prompts.filter(isGrouping);
    assert.equal(groupingPrompts.length, 2, 'the grouping request is retried exactly once');
    assert.match(groupingPrompts[1], /You returned 6 groups; the user requires between 1 and 3\./);
    assert.doesNotMatch(groupingPrompts[0], /STRONGLY preferred/);
    assert.equal(result.groups.length, 3);
    assert.ok(events.notices.some(notice =>
        notice.message === 'Adjusted to 3 commits by merging or splitting folders to fit the configured range.'));
    assertAllFilesOnce(result.groups, changes);
});

test('too few groups is split deterministically to the minimum', async () => {
    const changes = Array.from({ length: 8 }, (_, i) => change(`src/f-${i}.ts`));
    const env = setup((prompt) => {
        if (isSummary(prompt)) { return 'summary'; }
        if (isGrouping(prompt)) { return groupingReply(prompt); }
        if (isGeneration(prompt)) { return reply(`feat: ${groupLabel(prompt)}`); }
        if (isOrdering(prompt)) { return orderOriginalReply(prompt); }
        throw new Error('unexpected prompt');
    }, 128_000);
    const events = sink(true);

    const result = await service.generateCommits(
        changes, { ...options, minCommits: 4 }, cancellation().token, undefined, events.events,
    );

    assert.equal(env.prompts.filter(isGrouping).length, 2);
    assert.match(env.prompts.filter(isGrouping)[1], /You returned 1 groups; the user requires at least 4\./);
    assert.equal(result.groups.length, 4);
    assert.ok(events.notices.some(notice =>
        notice.message === 'Adjusted to 4 commits by merging or splitting folders to fit the configured range.'));
    assertAllFilesOnce(result.groups, changes);
});

test('a minimum above the file count is truncated with an info notice', async () => {
    const changes = Array.from({ length: 3 }, (_, i) => change(`src/f-${i}.ts`));
    const env = setup((prompt) => {
        if (isSummary(prompt)) { return 'summary'; }
        if (isGrouping(prompt)) { return groupingFromPrompt(prompt, 1); }
        if (isGeneration(prompt)) { return reply(`feat: ${groupLabel(prompt)}`); }
        if (isOrdering(prompt)) { return orderOriginalReply(prompt); }
        throw new Error('unexpected prompt');
    }, 128_000);
    const events = sink(true);

    const result = await service.generateCommits(
        changes, { ...options, minCommits: 5 }, cancellation().token, undefined, events.events,
    );

    assert.equal(result.groups.length, 3);
    assert.equal(env.prompts.filter(isGrouping).length, 1, 'no retry when the truncated range matches');
    assert.ok(events.notices.some(notice =>
        notice.level === 'info' &&
        notice.message === 'Only 3 files are staged; using at least 3 commits instead of 5.'));
});

test('a group count already inside the range is not retried', async () => {
    const changes = Array.from({ length: 6 }, (_, i) => change(`src/f-${i}.ts`));
    const env = setup((prompt) => {
        if (isSummary(prompt)) { return 'summary'; }
        if (isGrouping(prompt)) { return groupingFromPrompt(prompt, 3); }
        if (isGeneration(prompt)) { return reply(`feat: ${groupLabel(prompt)}`); }
        if (isOrdering(prompt)) { return orderOriginalReply(prompt); }
        throw new Error('unexpected prompt');
    }, 128_000);
    const events = sink(true);

    const result = await service.generateCommits(
        changes, { ...options, minCommits: 2, maxCommits: 4 }, cancellation().token, undefined, events.events,
    );

    assert.equal(env.prompts.filter(isGrouping).length, 1);
    assert.equal(result.groups.length, 2);
    assert.equal(events.notices.length, 0);
});

// ─── AI ordering ────────────────────────────────────────────────────────────

function orderingFixture(ordering: (prompt: string) => HandlerResult): {
    changes: FileChange[];
    env: ReturnType<typeof setup>;
} {
    const changes = [change('src/a.ts'), change('src/b.ts'), change('src/c.ts')];
    const env = setup((prompt) => {
        if (isSummary(prompt)) { return 'summary'; }
        if (isGrouping(prompt)) {
            return JSON.stringify(changes.map(file => ({ label: file.path, files: [file.path] })));
        }
        if (isGeneration(prompt)) { return reply(`feat: ${groupLabel(prompt)}`); }
        if (isOrdering(prompt)) { return ordering(prompt); }
        throw new Error('unexpected prompt');
    }, 128_000);
    return { changes, env };
}

test('a valid ordering permutation is adopted and published', async () => {
    const { changes, env } = orderingFixture(() => JSON.stringify(['c3', 'c1', 'c2']));
    const events = sink(true);

    const result = await service.generateCommits(
        changes, options, cancellation().token, undefined, events.events,
    );

    assert.equal(env.prompts.filter(isOrdering).length, 1);
    const expected = [
        result.candidates[2].candidate.id,
        result.candidates[0].candidate.id,
        result.candidates[1].candidate.id,
    ];
    assert.deepEqual(result.order, expected);
    assert.deepEqual(events.reorders, [expected]);
});

test('unknown, duplicate and missing ordering ids are repaired', async () => {
    const { changes } = orderingFixture(() => JSON.stringify(['c2', 'c2', 'cX', 'c1']));

    const result = await service.generateCommits(
        changes, options, cancellation().token, undefined, sink(true).events,
    );

    const expected = [
        result.candidates[1].candidate.id,
        result.candidates[0].candidate.id,
        result.candidates[2].candidate.id,
    ];
    assert.deepEqual(result.order, expected);
});

test('two invalid ordering replies keep the generated order with an info notice', async () => {
    const { changes, env } = orderingFixture(() => 'not JSON');
    const events = sink(true);

    const result = await service.generateCommits(
        changes, options, cancellation().token, undefined, events.events,
    );

    assert.equal(env.prompts.filter(isOrdering).length, 2);
    assert.equal(result.order, undefined);
    assert.deepEqual(events.reorders, []);
    assert.deepEqual(result.candidates.map(entry => entry.groupIndex), [0, 1, 2]);
    assert.ok(events.notices.some(notice =>
        notice.level === 'info' && notice.message === 'Could not determine a commit order; kept the generated order.'));
});

test('an ordering provider error keeps the generated order and does not reject the run', async () => {
    const { changes } = orderingFixture(() => new Error('ordering provider offline'));
    const events = sink(true);

    const result = await service.generateCommits(
        changes, options, cancellation().token, undefined, events.events,
    );

    assert.equal(result.candidates.length, 3);
    assert.equal(result.order, undefined);
    assert.deepEqual(result.candidates.map(entry => entry.groupIndex), [0, 1, 2]);
    assert.ok(events.notices.some(notice =>
        notice.level === 'warning' && /AI commit ordering failed/.test(notice.message)));
});

test('cancellation during ordering rejects the run', async () => {
    const c = cancellation();
    const { changes } = orderingFixture(() => {
        c.cancel();
        return JSON.stringify(['c1', 'c2', 'c3']);
    });

    await assert.rejects(
        service.generateCommits(changes, options, c.token, undefined, sink(true).events),
        CancellationError,
    );
});

test('only one successful candidate skips the ordering request', async () => {
    const env = setup((prompt) => {
        if (isSummary(prompt)) { return 'summary'; }
        if (isGeneration(prompt)) { return reply('feat: only'); }
        throw new Error('unexpected prompt');
    });
    const events = sink(true);

    const result = await service.generateCommits(
        [change('src/only.ts')], options, cancellation().token, undefined, events.events,
    );

    assert.equal(env.prompts.length, 1);
    assert.equal(env.prompts.filter(isOrdering).length, 0);
    assert.equal(result.order, undefined);
    assert.deepEqual(events.reorders, []);
});

test('a failed group does not participate in the order', async () => {
    const changes = [change('src/a.ts'), change('src/b.ts'), change('src/c.ts')];
    const env = setup((prompt) => {
        if (isSummary(prompt)) { return 'summary'; }
        if (isGrouping(prompt)) {
            return JSON.stringify(changes.map(file => ({ label: file.path, files: [file.path] })));
        }
        if (isGeneration(prompt)) {
            return groupLabel(prompt) === 'src/b.ts' ? 'not JSON' : reply(`feat: ${groupLabel(prompt)}`);
        }
        if (isOrdering(prompt)) { return JSON.stringify(['c2', 'c1']); }
        throw new Error('unexpected prompt');
    }, 128_000);
    const events = sink(true);

    const result = await service.generateCommits(
        changes, options, cancellation().token, undefined, events.events,
    );

    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].group.files[0], 'src/b.ts');
    assert.equal(result.order?.length, 2);
    const successfulIds = result.candidates.map(entry => entry.candidate.id);
    assert.deepEqual([...result.order!].sort(), [...successfulIds].sort());
    assert.equal(env.prompts.filter(isOrdering).length, 1);
});

// ─── estimates and confirmations ────────────────────────────────────────────

test('generation estimates include the single ordering request', () => {
    const changes = [change('src/a.ts'), change('src/b.ts')];
    const twoGroups = [
        { index: 0, label: 'a', files: ['src/a.ts'] },
        { index: 1, label: 'b', files: ['src/b.ts'] },
    ];
    const oneGroup = [{ index: 0, label: 'both', files: ['src/a.ts', 'src/b.ts'] }];

    const generationEstimate = generation.estimateRequests(twoGroups, changes, 100_000, 'generation');
    assert.equal(generationEstimate.groups, 2);
    assert.equal(generationEstimate.requests, 3);
    assert.equal(generationEstimate.stage, 'generation');
    assert.equal(generation.estimateRequests(oneGroup, changes, 100_000, 'generation').requests, 1);
    assert.equal(generation.estimateRequests(twoGroups, changes, 100_000, 'grouping').requests, 2);
});

test('declining the pre-grouping confirmation sends no model requests', async () => {
    const changes = Array.from({ length: 2400 }, (_, i) => change(
        `src/dir-${Math.floor(i / 60)}/file-${i}.ts`,
    ));
    const env = setup(() => { throw new Error('no model request expected'); }, 128_000);
    const events = sink(false);

    const result = await service.generateCommits(
        changes, options, cancellation().token, undefined, events.events,
    );

    assert.equal(result.declined, true);
    assert.deepEqual(result.groups, []);
    assert.equal(env.prompts.length, 0, 'no request is sent after declining');
    assert.equal(events.confirmations.length, 1);
    assert.equal(events.confirmations[0].stage, 'grouping');
    assert.equal(events.confirmations[0].groups, 40);
    assert.equal(events.confirmations[0].requests, 41);
});

// ─── prompt contracts ───────────────────────────────────────────────────────

test('the merge prompt swaps its merge policy when an upper limit is set', () => {
    const groups = [
        { id: 'g1', label: 'Feature', fileCount: 2, directories: ['src'], examples: ['src/a.ts'] },
        { id: 'g2', label: 'Tests', fileCount: 1, directories: ['tests'], examples: ['tests/a.test.ts'] },
    ];
    const bounded = promptBuilderModule.buildMergePrompt(groups, { min: 1, max: 10 });
    const unbounded = promptBuilderModule.buildMergePrompt(groups, { min: 1, max: Number.POSITIVE_INFINITY });
    const noRange = promptBuilderModule.buildMergePrompt(groups);

    assert.ok(bounded.includes('Merge further only as needed to meet the group limit below, choosing the most closely related intents first.'));
    assert.ok(!bounded.includes('Do not merge unrelated changes just to reduce the number of groups.'));
    assert.ok(unbounded.includes('Do not merge unrelated changes just to reduce the number of groups.'));
    assert.ok(!unbounded.includes('Merge further only as needed'));
    assert.ok(noRange.includes('Do not merge unrelated changes just to reduce the number of groups.'));
});

test('bucket grouping, merge and ordering prompts each state their required JSON format', async () => {
    const changes = mergeFixture();
    const env = setup((prompt) => {
        if (isSummary(prompt)) { return 'summary'; }
        if (isGrouping(prompt)) { return groupingReply(prompt); }
        if (isMerge(prompt)) {
            return JSON.stringify([
                { label: 'Feature and tests', groups: ['g1', 'g2'] },
                { label: 'Feature docs', groups: ['g3'] },
            ]);
        }
        if (isGeneration(prompt)) { return reply(`feat: ${groupLabel(prompt)}`); }
        if (isOrdering(prompt)) { return orderOriginalReply(prompt); }
        throw new Error('unexpected prompt');
    }, 128_000);

    await service.generateCommits(
        changes, options, cancellation().token, undefined, sink(true).events,
    );

    const bucketPrompt = env.prompts.find(prompt =>
        isGrouping(prompt) && prompt.includes('one folder-based batch'));
    assert.ok(bucketPrompt, 'a bucket prompt was sent');
    assert.match(bucketPrompt!, /These \d+ files are one folder-based batch \(.+\) out of 130 staged files/);
    assert.ok(bucketPrompt!.includes('Required JSON format:'));
    assert.ok(bucketPrompt!.includes('{"label":"<one shared intent>","files":["<path1>","<path2>"]}'));

    const mergePrompt = env.prompts.find(isMerge);
    assert.ok(mergePrompt, 'a merge prompt was sent');
    assert.ok(mergePrompt!.includes('Required JSON format:'));
    assert.ok(mergePrompt!.includes('{"label":"<merged intent>","groups":["g1","g7"]}'));

    const orderingPrompt = env.prompts.find(isOrdering);
    assert.ok(orderingPrompt, 'an ordering prompt was sent');
    assert.ok(orderingPrompt!.includes('Required JSON format:'));
    assert.ok(orderingPrompt!.includes('["c3","c1","c2"]'));
});
