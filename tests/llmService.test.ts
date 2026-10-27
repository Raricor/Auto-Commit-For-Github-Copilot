import assert from 'node:assert/strict';
import test from 'node:test';
import type { CancellationToken } from 'vscode';
import type { CommitCandidate, FileChange, GenerateOptions, GitLogEntry } from '../src/types';

// VS Code is only available inside the extension host. Replace that boundary;
// all prompt construction, budgeting, parsing, grouping and generation stay real.
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
const service = require('../src/llm/llmService') as {
    clearModelCache(): void;
    generateGroupedCommits(
        changes: FileChange[], options: GenerateOptions, token: CancellationToken,
        history?: GitLogEntry[], onCandidate?: (candidate: CommitCandidate) => void,
    ): Promise<CommitCandidate[]>;
};
nodeModule._load = originalLoad;

const options = { conventionalCommits: true, language: 'en' };
const reply = (message: string) => JSON.stringify({ message, reason: 'Keep the intended behavior consistent.' });
const change = (path: string, diff = '+new behavior\n'): FileChange => ({ path, type: 'modified', diff });
const grouping = (groups: string[][]) => JSON.stringify(groups.map((files, i) => ({ label: `Intent ${i + 1}`, files })));

function cancellation() {
    const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
    return { token: token as CancellationToken, cancel: () => { token.isCancellationRequested = true; } };
}

function setup(responses: Array<string | Error>, maxInputTokens = 64_000, charsPerToken = 3) {
    const prompts: string[] = [];
    const counted: string[] = [];
    const hooks: { onCount?: () => void; onRequest?: () => void; afterFirstChunk?: () => void; summarize?: (prompt: string) => string } = {};
    const model = {
        id: 'test-model', name: 'Test model', maxInputTokens,
        countTokens: async (text: string) => {
            counted.push(text);
            hooks.onCount?.();
            return Math.ceil(Buffer.byteLength(text) / charsPerToken);
        },
        sendRequest: async (messages: Array<{ content: Array<{ value: string }> }>) => {
            prompts.push(messages.map(m => m.content.map(p => p.value).join('')).join(''));
            hooks.onRequest?.();
            const response = prompts.at(-1)!.startsWith('Summarize the supplied')
                ? (hooks.summarize?.(prompts.at(-1)!) ?? 'The supplied changes update the behavior and its regression coverage.')
                : responses.shift();
            if (response instanceof Error) { throw response; }
            assert.equal(typeof response, 'string', 'unexpected extra model request');
            return { text: (async function* () {
                const middle = Math.floor(response!.length / 2);
                yield response!.slice(0, middle);
                hooks.afterFirstChunk?.();
                yield response!.slice(middle);
            })() };
        },
    };
    activeModel = model;
    service.clearModelCache();
    return { model, prompts, counted, hooks };
}

test('groups by intent first, then generates one message per group and publishes incrementally', async () => {
    const changes = [change('src/feature.ts'), change('tests/feature.test.ts'), change('docs/guide.md')];
    const env = setup([grouping([['src/feature.ts', 'tests/feature.test.ts'], ['docs/guide.md']]), reply('feat: feature'), reply('docs: guide')]);
    const published: number[] = [];
    const result = await service.generateGroupedCommits(changes, options, cancellation().token, [], () => published.push(env.prompts.length));

    assert.equal(env.prompts.length, 3);
    assert.doesNotMatch(env.prompts[0], /"message"|PART B/);
    assert.match(env.prompts[1], /src\/feature\.ts/);
    assert.match(env.prompts[1], /tests\/feature\.test\.ts/);
    assert.doesNotMatch(env.prompts[1], /docs\/guide\.md/);
    assert.match(env.prompts[2], /docs\/guide\.md/);
    assert.doesNotMatch(env.prompts[2], /src\/feature\.ts/);
    assert.deepEqual(result.map(c => c.files), [['src/feature.ts', 'tests/feature.test.ts'], ['docs/guide.md']]);
    assert.deepEqual(result.map(c => c.message), ['feat: feature', 'docs: guide']);
    assert.deepEqual(published, [2, 3]);
    assert.ok(env.prompts.every(p => env.counted.includes(p)), 'every sent prompt was budgeted');
});

test('large fixture groups are fully analyzed in bounded requests without losing files or diff content', async () => {
    const changes = Array.from({ length: 4 }, (_, i) => change(`test/fixtures/${i}.json`, '+数据记录\n'.repeat(5_000)));
    const original = changes.map(c => c.diff);
    const env = setup([grouping([changes.map(c => c.path)]), reply('test: add fixtures')], 12_000);
    const result = await service.generateGroupedCommits(changes, options, cancellation().token);

    assert.ok(env.prompts.length > 2, 'large groups need DeepSeek summary requests before generation');
    for (const prompt of env.prompts) {
        assert.ok(Math.ceil(Buffer.byteLength(prompt) / 3) <= 9_600, 'request exceeds the model input budget');
    }
    assert.match(env.prompts[0], /omitted/i);
    const fragments = env.prompts.filter(p => p.includes('DIFF FRAGMENTS (JSON):\n'))
        .flatMap(p => JSON.parse(p.split('DIFF FRAGMENTS (JSON):\n')[1]) as Array<{ path: string; offset: number; text: string }>);
    for (const file of changes) {
        const reconstructed = fragments.filter(p => p.path === file.path).sort((a, b) => a.offset - b.offset).map(p => p.text).join('');
        assert.equal(reconstructed, file.diff, 'every original diff character must reach the model');
    }
    assert.deepEqual(result[0].files, changes.map(c => c.path));
    assert.deepEqual(changes.map(c => c.diff), original);
});

test('token counter can force further reduction for dense text', async () => {
    const changes = [change('data.txt', '+密集数据\n'.repeat(10_000))];
    const env = setup([grouping([['data.txt']]), reply('chore: data')], 6_000, 1);
    await service.generateGroupedCommits(changes, options, cancellation().token);
    assert.ok(env.prompts.every(p => Buffer.byteLength(p) <= 4_800));
    assert.ok(env.counted.length > env.prompts.length, 'oversized prompts should be reduced and recounted');
});

test('a synthetic 311-file import can be grouped and analyzed by the selected model', async () => {
    const changes = Array.from({ length: 311 }, (_, i) => change(
        `dsh/test/fixtures/scenario-${i}/recorded-events.json`, '+sample record with game state and expected behavior\n'.repeat(260),
    ));
    const env = setup([grouping([changes.map(c => c.path)]), reply('feat: import project')], 655_360);
    const result = await service.generateGroupedCommits(changes, options, cancellation().token);
    assert.deepEqual(result[0].files, changes.map(c => c.path));
    assert.ok(env.prompts[0].length < 128_000);
    assert.ok(env.prompts.every(p => Math.ceil(Buffer.byteLength(p) / 3) <= 524_288));
    const parts = env.prompts.filter(p => p.includes('DIFF FRAGMENTS (JSON):\n'))
        .flatMap(p => JSON.parse(p.split('DIFF FRAGMENTS (JSON):\n')[1]) as Array<{ path: string; offset: number; text: string }>);
    assert.equal(parts.reduce((n, p) => n + p.text.length, 0), changes.reduce((n, f) => n + f.diff.length, 0));
    for (const file of changes) {
        assert.equal(parts.filter(p => p.path === file.path).sort((a, b) => a.offset - b.offset).map(p => p.text).join(''), file.diff);
    }
});

test('one oversized renamed file is split without corrupting Unicode or losing its destination path', async () => {
    const file = { ...change('新文件.ts', '+🎮内容\n'.repeat(8_000)), type: 'renamed' as const, originalPath: '旧文件.ts' };
    const env = setup([grouping([[file.path]]), reply('refactor: rename')], 8_000);
    const result = await service.generateGroupedCommits([file], options, cancellation().token);
    const parts = env.prompts.filter(p => p.includes('DIFF FRAGMENTS (JSON):\n'))
        .flatMap(p => JSON.parse(p.split('DIFF FRAGMENTS (JSON):\n')[1]) as Array<{ path: string; offset: number; text: string }>);
    assert.ok(parts.length > 1);
    assert.equal(parts.sort((a, b) => a.offset - b.offset).map(p => p.text).join(''), file.diff);
    assert.ok(parts.every(p => Buffer.from(p.text).toString('utf8') === p.text));
    assert.deepEqual(result[0].files, ['新文件.ts']);
    assert.equal(file.originalPath, '旧文件.ts');
});

test('summaries that collectively exceed the budget are reduced by the same model', async () => {
    const files = [change('large.json', '+entry\n'.repeat(40_000))];
    const env = setup([grouping([['large.json']]), reply('test: fixtures')], 6_000);
    env.hooks.summarize = prompt => prompt.includes('DIFF FRAGMENTS') ? 'summary detail '.repeat(200) : 'Combined fixture changes.';
    const result = await service.generateGroupedCommits(files, options, cancellation().token);
    assert.equal(result[0].message, 'test: fixtures');
    assert.ok(env.prompts.some(p => p.includes('PRIOR SUMMARIES (JSON)')));
    assert.ok(env.prompts.every(p => Math.ceil(Buffer.byteLength(p) / 3) <= 4_800));
});

test('HTTP failure while summarizing stops the pipeline without retrying the entire diff', async () => {
    const error = new Error('summary endpoint failed');
    const env = setup([grouping([['large.json']])], 6_000);
    env.hooks.summarize = () => { throw error; };
    await assert.rejects(service.generateGroupedCommits([change('large.json', '+entry\n'.repeat(20_000))], options, cancellation().token), e => e === error);
    assert.equal(env.prompts.length, 2);
});

test('cancellation while the provider is responding prevents further requests', async () => {
    const env = setup([grouping([['a.ts']])]);
    const c = cancellation();
    env.hooks.onRequest = c.cancel;
    await assert.rejects(service.generateGroupedCommits([change('a.ts')], options, c.token), CancellationError);
    assert.equal(env.prompts.length, 1);
});

test('cancellation after a streamed chunk prevents parsing and subsequent requests', async () => {
    const env = setup([grouping([['a.ts']])]);
    const c = cancellation();
    env.hooks.afterFirstChunk = c.cancel;
    await assert.rejects(service.generateGroupedCommits([change('a.ts')], options, c.token), CancellationError);
    assert.equal(env.prompts.length, 1);
});

for (const [name, response] of [
    ['missing files', grouping([['src/a.ts']])],
    ['duplicate files', grouping([['src/a.ts', 'src/a.ts', 'tests/a.test.ts']])],
    ['unknown files', grouping([['src/a.ts', 'tests/a.test.ts', 'unknown.ts']])],
    ['empty groups', grouping([[], ['src/a.ts', 'tests/a.test.ts']])],
    ['invalid JSON', 'not JSON'],
] as const) {
    test(`invalid grouping (${name}) falls back to local groups and generates separately`, async () => {
        const changes = [change('src/a.ts'), change('tests/a.test.ts')];
        const env = setup([response, reply('feat: a'), reply('test: a')]);
        const result = await service.generateGroupedCommits(changes, options, cancellation().token);
        assert.deepEqual(result.map(c => c.files), [['src/a.ts'], ['tests/a.test.ts']]);
        assert.equal(env.prompts.length, 3);
        assert.doesNotMatch(env.prompts[1], /tests\/a\.test\.ts/);
        assert.doesNotMatch(env.prompts[2], /src\/a\.ts/);
    });
}

test('HTTP failure during grouping propagates without a second full request', async () => {
    const error = new Error('[400] Invalid request body format');
    const env = setup([error]);
    await assert.rejects(service.generateGroupedCommits([change('a.ts')], options, cancellation().token), e => e === error);
    assert.equal(env.prompts.length, 1);
});

test('token-counting failures propagate without sending a request', async () => {
    const env = setup([]);
    const error = new Error('token counter unavailable');
    env.model.countTokens = async () => { throw error; };
    await assert.rejects(service.generateGroupedCommits([change('a.ts')], options, cancellation().token), e => e === error);
    assert.equal(env.prompts.length, 0);
});

test('oversized file manifest is rejected before model invocation', async () => {
    const env = setup([], 2_000);
    const files = Array.from({ length: 100 }, (_, i) => change(`${'long-directory/'.repeat(10)}${i}.ts`));
    await assert.rejects(service.generateGroupedCommits(files, options, cancellation().token), /input budget|too large/i);
    assert.equal(env.prompts.length, 0);
});

test('oversized custom instructions are rejected before model invocation', async () => {
    const env = setup([], 4_000);
    await assert.rejects(service.generateGroupedCommits([change('a.ts')], { ...options, prompt: 'instruction '.repeat(10_000) }, cancellation().token), /input budget|too large/i);
    assert.equal(env.prompts.length, 0);
});

test('cancelled generation does not begin a request', async () => {
    const env = setup([]);
    const c = cancellation();
    c.cancel();
    await assert.rejects(service.generateGroupedCommits([change('a.ts')], options, c.token), CancellationError);
    assert.equal(env.prompts.length, 0);
});

test('cancellation during token counting prevents the network request', async () => {
    const env = setup([]);
    const c = cancellation();
    env.hooks.onCount = c.cancel;
    await assert.rejects(service.generateGroupedCommits([change('a.ts')], options, c.token), CancellationError);
    assert.equal(env.prompts.length, 0);
});

test('cancellation after a candidate stops remaining groups', async () => {
    const env = setup([grouping([['a.ts'], ['b.ts']]), reply('feat: a')]);
    const c = cancellation();
    const published: CommitCandidate[] = [];
    await assert.rejects(service.generateGroupedCommits([change('a.ts'), change('b.ts')], options, c.token, [], candidate => { published.push(candidate); c.cancel(); }), CancellationError);
    assert.equal(published.length, 1);
    assert.equal(env.prompts.length, 2);
});

test('generation failure preserves completed candidates and never restarts grouping', async () => {
    const error = new Error('provider offline');
    const env = setup([grouping([['a.ts'], ['b.ts']]), reply('feat: a'), error]);
    const published: CommitCandidate[] = [];
    await assert.rejects(service.generateGroupedCommits([change('a.ts'), change('b.ts')], options, cancellation().token, [], c => published.push(c)), e => e === error);
    assert.deepEqual(published.map(c => c.files), [['a.ts']]);
    assert.equal(env.prompts.length, 3);
});

test('empty changes require no model requests', async () => {
    const env = setup([]);
    assert.deepEqual(await service.generateGroupedCommits([], options, cancellation().token), []);
    assert.equal(env.prompts.length, 0);
});
