import assert from 'node:assert/strict';
import test from 'node:test';
import type { CancellationToken } from 'vscode';
import type {
    FileChange, GenerateOptions, PlannedGroup,
} from '../src/types';

// VS Code is only available inside the extension host. Replace that boundary;
// grouping, budgeting, concurrency and generation all stay real.
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
nodeModule._load = originalLoad;

const options: GenerateOptions = { conventionalCommits: true, language: 'en' };
const reply = (message: string) => JSON.stringify({ message, reason: 'Keep the intended behavior consistent.' });
const change = (path: string, diff = '+new behavior\n'): FileChange => ({ path, type: 'modified', diff });
const grouping = (groups: string[][]) => JSON.stringify(groups.map((files, i) => ({ label: `Intent ${i + 1}`, files })));
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

type HandlerResult = string | Error;
type Handler = (prompt: string, call: number, token: CancellationToken) => HandlerResult | Promise<HandlerResult>;

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

function setup(handler: Handler, maxInputTokens = 64_000, charsPerToken = 3) {
    const prompts: string[] = [];
    const optionsSeen: unknown[] = [];
    const tokens: CancellationToken[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    let calls = 0;

    const model = {
        id: 'test-model', name: 'Test model', maxInputTokens,
        countTokens: async (text: string) => Math.ceil(Buffer.byteLength(text) / charsPerToken),
        sendRequest: async (
            messages: Array<{ content: Array<{ value: string }> }>,
            requestOptions?: unknown,
            token?: CancellationToken,
        ) => {
            const prompt = messages.map(m => m.content.map(part => part.value).join('')).join('');
            prompts.push(prompt);
            optionsSeen.push(requestOptions ?? {});
            tokens.push(token!);
            const call = calls++;
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            return {
                text: (async function* () {
                    try {
                        const result = prompt.startsWith('You are an expert Git commit orderer.')
                            ? orderReply(prompt)
                            : await handler(prompt, call, token!);
                        if (result instanceof Error) { throw result; }
                        const middle = Math.floor(result.length / 2);
                        yield result.slice(0, middle);
                        await Promise.resolve();
                        yield result.slice(middle);
                    } finally {
                        inFlight -= 1;
                    }
                })(),
            };
        },
    };
    activeModel = model;
    service.clearModelCache();
    return {
        model, prompts, optionsSeen, tokens,
        get maxInFlight() { return maxInFlight; },
    };
}

function generationLabel(prompt: string): number {
    const match = prompt.match(/Group: Intent (\d+)/);
    return match ? Number(match[1]) : 0;
}

function orderReply(prompt: string): string {
    const ids = [...new Set(prompt.match(/\bc\d+\b/g) ?? [])];
    return JSON.stringify(ids);
}

function generateReplies(handler?: (label: number, attempt: number) => HandlerResult): Handler {
    const attempts = new Map<number, number>();
    return (prompt) => {
        if (prompt.startsWith('Summarize the supplied')) {
            return 'The supplied changes update the behavior and its regression coverage.';
        }
        if (prompt.startsWith('You are an expert Git commit orderer.')) {
            return orderReply(prompt);
        }
        if (prompt.includes('You are an expert Git commit assistant')) {
            throw new Error('grouping reply was not configured for this test');
        }
        const label = generationLabel(prompt);
        const attempt = (attempts.get(label) ?? 0) + 1;
        attempts.set(label, attempt);
        return handler ? handler(label, attempt) : reply(`feat: group ${label}`);
    };
}

test('a single file needs exactly one model request and uses its path as the label', async () => {
    const env = setup(generateReplies());
    const result = await service.generateCommits(
        [change('src/only.ts')], options, cancellation().token,
    );

    assert.equal(env.prompts.length, 1);
    assert.match(env.prompts[0], /commit message generator/);
    assert.equal(result.groups.length, 1);
    assert.equal(result.groups[0].label, 'src/only.ts');
    assert.deepEqual(result.candidates.map(entry => entry.candidate.files), [['src/only.ts']]);
});

async function runConcurrency(concurrency: number) {
    const files = Array.from({ length: 6 }, (_, i) => change(`src/file-${i + 1}.ts`, `+feature ${i + 1}\n`));
    const env = setup((prompt) => {
        if (prompt.startsWith('Summarize the supplied')) { return 'summary'; }
        if (prompt.includes('You are an expert Git commit assistant')) {
            return grouping(files.map(file => [file.path]));
        }
        const label = generationLabel(prompt);
        // Reverse completion order: group 1 is slowest, group 6 fastest.
        return sleep((7 - label) * 8).then(() => reply(`feat: group ${label}`));
    });
    const result = await service.generateCommits(
        files, { ...options, concurrency }, cancellation().token,
    );
    return { env, result };
}

test('generation respects the concurrency limit and sorts candidates by group order', async () => {
    const three = await runConcurrency(3);
    assert.equal(three.env.maxInFlight, 3);
    assert.deepEqual(three.result.candidates.map(entry => entry.groupIndex), [0, 1, 2, 3, 4, 5]);
    assert.deepEqual(three.result.candidates.map(entry => entry.candidate.message), [
        'feat: group 1', 'feat: group 2', 'feat: group 3',
        'feat: group 4', 'feat: group 5', 'feat: group 6',
    ]);

    const one = await runConcurrency(1);
    assert.equal(one.env.maxInFlight, 1);
    assert.deepEqual(one.result.candidates.map(entry => entry.groupIndex), [0, 1, 2, 3, 4, 5]);
});

test('unusable output only fails its own group; a one-time failure is retried', async () => {
    const files = [change('src/a.ts'), change('src/b.ts'), change('src/c.ts')];
    const failedGroups: PlannedGroup[] = [];
    const isolated = setup((prompt) => {
        if (prompt.startsWith('Summarize the supplied')) { return 'summary'; }
        if (prompt.includes('You are an expert Git commit assistant')) {
            return grouping(files.map(file => [file.path]));
        }
        const label = generationLabel(prompt);
        return label === 2 ? 'not JSON at all' : reply(`feat: group ${label}`);
    });

    const result = await service.generateCommits(files, options, cancellation().token, undefined, {
        onGroupFailed: group => failedGroups.push(group),
    });
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].group.index, 1);
    assert.deepEqual(failedGroups.map(group => group.index), [1]);
    assert.deepEqual(result.candidates.map(entry => entry.groupIndex), [0, 2]);
    // grouping + 3 first attempts + 1 retry for the broken group + ordering
    assert.equal(isolated.prompts.length, 6);

    const retried = setup((prompt) => {
        if (prompt.startsWith('Summarize the supplied')) { return 'summary'; }
        if (prompt.includes('You are an expert Git commit assistant')) {
            return grouping(files.map(file => [file.path]));
        }
        const label = generationLabel(prompt);
        return label === 2 && /previous reply could not be used/.test(prompt)
            ? reply('feat: recovered')
            : label === 2 ? 'garbage' : reply(`feat: group ${label}`);
    });
    const recovered = await service.generateCommits(files, options, cancellation().token);
    assert.equal(recovered.failed.length, 0);
    assert.equal(recovered.candidates.length, 3);
    assert.equal(recovered.candidates[1].candidate.message, 'feat: recovered');
    assert.equal(retried.prompts.length, 6);
});

test('a provider error aborts in-flight requests and rejects with the original error', async () => {
    const files = [change('src/a.ts'), change('src/b.ts'), change('src/c.ts')];
    const error = new Error('provider offline');
    const failed: Array<{ group: PlannedGroup; error: Error }> = [];
    const env = setup((prompt) => {
        if (prompt.startsWith('Summarize the supplied')) { return 'summary'; }
        if (prompt.includes('You are an expert Git commit assistant')) {
            return grouping(files.map(file => [file.path]));
        }
        const label = generationLabel(prompt);
        if (label === 1) { return sleep(120).then(() => reply('feat: too late')); }
        if (label === 2) { return sleep(10).then(() => error); }
        return reply('feat: group 3');
    });

    let rejection: Error | undefined;
    try {
        await service.generateCommits(files, { ...options, concurrency: 2 }, cancellation().token, undefined, {
            onGroupFailed: (group, failure) => failed.push({ group, error: failure }),
        });
    } catch (caught) {
        rejection = caught as Error;
    }

    assert.equal(rejection, error);
    // Group 3 was still queued when the provider failed: no new request.
    assert.equal(env.prompts.length, 3);
    assert.equal(failed.length, 3);
    assert.ok(failed.every(entry => entry.error === error), 'every unfinished group got the provider error');
    const group1Token = env.tokens[env.prompts.findIndex(prompt => /Group: Intent 1/.test(prompt))];
    assert.equal(group1Token.isCancellationRequested, true);
});

test('user cancellation throws CancellationError without any onGroupFailed event', async () => {
    const files = [change('src/a.ts'), change('src/b.ts')];
    const c = cancellation();
    const failed: PlannedGroup[] = [];
    const env = setup((prompt) => {
        if (prompt.startsWith('Summarize the supplied')) { return 'summary'; }
        if (prompt.includes('You are an expert Git commit assistant')) {
            return grouping(files.map(file => [file.path]));
        }
        c.cancel();
        return sleep(10).then(() => reply('feat: late'));
    });

    await assert.rejects(
        service.generateCommits(files, { ...options, concurrency: 1 }, c.token, undefined, {
            onGroupFailed: group => failed.push(group),
        }),
        CancellationError,
    );
    assert.equal(failed.length, 0);
    assert.equal(env.prompts.length, 2);
});

test('grouping repairs path prefixes, duplicates, unknown paths and empty groups', async () => {
    const files = [change('src/a.ts'), change('src/b.ts'), change('tests/a.test.ts')];
    const env = setup((prompt) => {
        if (prompt.startsWith('Summarize the supplied')) { return 'summary'; }
        if (prompt.includes('You are an expert Git commit assistant')) {
            return JSON.stringify([
                { label: 'Feature', files: ['./src/a.ts', 'src/a.ts', 'a/src/b.ts', 'unknown.ts'] },
                { label: 'Tests', files: ['b/tests/a.test.ts'] },
                { label: 'Empty', files: [] },
            ]);
        }
        return reply('feat: grouped');
    });

    const result = await service.generateCommits(files, options, cancellation().token);
    assert.deepEqual(result.groups.map(group => group.label), ['Feature', 'Tests']);
    assert.deepEqual(result.groups.map(group => group.files), [['src/a.ts', 'src/b.ts'], ['tests/a.test.ts']]);
    assert.equal(result.failed.length, 0);
    assert.equal(env.prompts.filter(prompt => prompt.includes('You are an expert Git commit assistant')).length, 1);
});

test('files missed by AI grouping are appended by local rules with an info notice', async () => {
    const files = [change('src/a.ts'), change('tests/a.test.ts'), change('docs/readme.md')];
    const notices: Array<{ level: string; message: string }> = [];
    setup((prompt) => {
        if (prompt.startsWith('Summarize the supplied')) { return 'summary'; }
        if (prompt.includes('You are an expert Git commit assistant')) {
            return grouping([['src/a.ts'], ['tests/a.test.ts']]);
        }
        return reply('feat: grouped');
    });

    const result = await service.generateCommits(files, options, cancellation().token, undefined, {
        onNotice: (level, message) => notices.push({ level, message }),
    });
    assert.equal(result.groups.length, 3);
    assert.deepEqual(result.groups.at(-1)!.files, ['docs/readme.md']);
    assert.deepEqual(notices, [
        { level: 'info', message: 'AI grouping missed 1 file(s); grouped them by folder and type.' },
    ]);
});

test('invalid AI grouping is retried once and then falls back with a warning', async () => {
    const files = [change('src/a.ts'), change('tests/a.test.ts')];
    const notices: Array<{ level: string; message: string }> = [];
    let groupingCalls = 0;
    const env = setup((prompt) => {
        if (prompt.startsWith('Summarize the supplied')) { return 'summary'; }
        if (prompt.includes('You are an expert Git commit assistant')) {
            groupingCalls += 1;
            return 'not JSON';
        }
        return reply('feat: local');
    });

    const result = await service.generateCommits(files, options, cancellation().token, undefined, {
        onNotice: (level, message) => notices.push({ level, message }),
    });
    assert.equal(groupingCalls, 2);
    assert.deepEqual(result.groups.map(group => group.files), [['src/a.ts'], ['tests/a.test.ts']]);
    assert.deepEqual(notices, [
        { level: 'warning', message: 'AI grouping output was invalid twice; fell back to folder and type rules.' },
    ]);
    assert.equal(env.prompts.length, 5);
});

test('an invalid first grouping reply followed by a valid one uses the AI groups', async () => {
    const files = [change('src/a.ts'), change('src/b.ts')];
    let groupingCalls = 0;
    const notices: Array<{ level: string; message: string }> = [];
    setup((prompt) => {
        if (prompt.startsWith('Summarize the supplied')) { return 'summary'; }
        if (prompt.includes('You are an expert Git commit assistant')) {
            groupingCalls += 1;
            return groupingCalls === 1 ? 'not JSON' : grouping([['src/a.ts', 'src/b.ts']]);
        }
        return reply('feat: ai grouped');
    });

    const result = await service.generateCommits(files, options, cancellation().token, undefined, {
        onNotice: (level, message) => notices.push({ level, message }),
    });
    assert.equal(groupingCalls, 2);
    assert.deepEqual(result.groups.map(group => group.label), ['Intent 1']);
    assert.deepEqual(result.groups[0].files, ['src/a.ts', 'src/b.ts']);
    assert.equal(notices.length, 0);
});

test('grouping evidence keeps a large excerpt, drops headers and context, keeps hunk headers', async () => {
    const lines: string[] = [
        'diff --git a/src/big.ts b/src/big.ts',
        'index 1111111..2222222 100644',
        '--- a/src/big.ts',
        '+++ b/src/big.ts',
        '@@ -1,2 +1,200 @@ function bigFeature()',
    ];
    for (let i = 0; i < 500; i++) { lines.push(`+added content line ${i}`); }
    lines.push(' context line that must never be sent');
    lines.push('@@ -300,2 +400,200 @@ function tailFeature()');
    for (let i = 0; i < 100; i++) { lines.push(`+tail content line ${i}`); }
    const bigDiff = lines.join('\n');
    assert.ok(bigDiff.length >= 14_000, `fixture is ${bigDiff.length} characters`);

    const files = [change('src/big.ts', bigDiff), change('src/small.ts', '+small\n')];
    const env = setup((prompt) => {
        if (prompt.startsWith('Summarize the supplied')) { return 'summary'; }
        if (prompt.includes('You are an expert Git commit assistant')) {
            return grouping([files.map(file => file.path)]);
        }
        return reply('feat: big');
    });

    await service.generateCommits(files, options, cancellation().token);
    const prompt = env.prompts[0];
    const retained = prompt.split('\n').filter(line => line.startsWith('+')).join('\n').length;
    assert.ok(retained >= 4_000, `only ${retained} diff characters retained`);
    assert.doesNotMatch(prompt, /^index /m);
    assert.doesNotMatch(prompt, /^--- a\//m);
    assert.doesNotMatch(prompt, /^\+\+\+ b\//m);
    assert.match(prompt, /^@@ /m);
    assert.doesNotMatch(prompt, /^ context line/m);
});

test('stats-only files never send their content, only statistics and the explanation', async () => {
    const marker = 'LOCKFILE_SECRET_MARKER';
    const lockDiff = [
        'diff --git a/package-lock.json b/package-lock.json',
        'index 1111111..2222222 100644',
        '--- a/package-lock.json',
        '+++ b/package-lock.json',
        '@@ -1,3 +1,15 @@',
        `+${marker}`,
        '+lock dependency entry',
        '-old lock line',
        ' context lock line',
    ].join('\n');
    const files = [change('package-lock.json', lockDiff), change('src/app.ts', '+feature\n')];
    const env = setup((prompt) => {
        if (prompt.startsWith('Summarize the supplied')) { return 'summary'; }
        if (prompt.includes('You are an expert Git commit assistant')) {
            return grouping([files.map(file => file.path)]);
        }
        return reply('chore: deps');
    });

    const result = await service.generateCommits(files, options, cancellation().token);
    assert.equal(result.failed.length, 0);
    assert.ok(env.prompts.every(prompt => !prompt.includes(marker)));
    assert.ok(env.prompts.some(prompt => prompt.includes('(lockfile or generated file; content not shown)')));
    assert.ok(env.prompts.some(prompt => /\+\d+ -\d+; \d+ characters\./.test(prompt)));
});

test('diff fences grow when the content contains backticks', async () => {
    const files = [
        change('docs/a.md', 'diff --git a/docs/a.md b/docs/a.md\n+```ts\n+code\n+```\n'),
        change('docs/b.md', '+plain\n'),
    ];
    const env = setup((prompt) => {
        if (prompt.startsWith('Summarize the supplied')) { return 'summary'; }
        if (prompt.includes('You are an expert Git commit assistant')) {
            return grouping([files.map(file => file.path)]);
        }
        return reply('docs: fences');
    });

    await service.generateCommits(files, options, cancellation().token);
    const groupingPrompt = env.prompts[0];
    const generationPrompt = env.prompts.find(prompt => prompt.includes('commit message generator'))!;
    assert.match(groupingPrompt, /\n````diff\n/);
    assert.match(generationPrompt, /\n````diff\n/);
});

test('the history style rule is only added when history exists', async () => {
    const files = [change('src/a.ts'), change('src/b.ts')];
    const env = setup((prompt) => {
        if (prompt.startsWith('Summarize the supplied')) { return 'summary'; }
        if (prompt.includes('You are an expert Git commit assistant')) {
            return grouping([[files[0].path], [files[1].path]]);
        }
        return reply('feat: no history');
    });

    await service.generateCommits(files, options, cancellation().token);
    const generated = env.prompts.filter(prompt => prompt.includes('commit message generator'));
    assert.equal(generated.length, 2);
    assert.ok(generated.every(prompt => !prompt.includes('Recent commit history')));
    assert.ok(generated.every(prompt => !prompt.includes('Match the tone of the recent commit history')));
});

test('reasoning effort is forwarded through configuration, never modelOptions', async () => {
    const files = [change('src/a.ts'), change('src/b.ts')];
    const handler: Handler = (prompt) => {
        if (prompt.startsWith('Summarize the supplied')) { return 'summary'; }
        if (prompt.includes('You are an expert Git commit assistant')) {
            return grouping([[files[0].path], [files[1].path]]);
        }
        return reply('feat: effort');
    };

    const none = setup(handler);
    await service.generateCommits(files, { ...options, reasoningEffort: '' }, cancellation().token);
    assert.ok(none.optionsSeen.length >= 3);
    assert.ok(none.optionsSeen.every(seen => !('configuration' in (seen as object))));

    const low = setup(handler);
    await service.generateCommits(files, { ...options, reasoningEffort: 'low' }, cancellation().token);
    assert.equal(low.optionsSeen.length, low.prompts.length);
    for (const seen of low.optionsSeen) {
        const requestOptions = seen as { configuration?: { reasoningEffort?: string }; modelOptions?: Record<string, unknown> };
        assert.equal(requestOptions.configuration?.reasoningEffort, 'low');
        assert.equal(requestOptions.modelOptions?.reasoningEffort, undefined);
    }
});

test('a large estimate asks for confirmation and declining sends no generation requests', async () => {
    const files = [
        change('src/huge-a.ts', '+x\n'.repeat(125_000)),
        change('src/huge-b.ts', '+y\n'.repeat(125_000)),
    ];
    const env = setup((prompt) => {
        if (prompt.includes('You are an expert Git commit assistant')) {
            return grouping([files.map(file => file.path)]);
        }
        return reply('feat: huge');
    }, 4_000);
    let estimates = 0;
    const result = await service.generateCommits(files, options, cancellation().token, undefined, {
        confirmRequests: async estimate => {
            estimates += 1;
            assert.equal(estimate.groups, 1);
            assert.ok(estimate.requests > service.CONFIRM_REQUEST_THRESHOLD);
            return false;
        },
    });

    assert.equal(estimates, 1);
    assert.equal(result.declined, true);
    assert.deepEqual(result.groups, []);
    assert.deepEqual(result.candidates, []);
    assert.deepEqual(result.failed, []);
    assert.equal(env.prompts.length, 1, 'only the grouping request was sent');
});

test('a small task never asks for confirmation', async () => {
    const files = [change('src/a.ts'), change('src/b.ts')];
    let estimates = 0;
    setup((prompt) => {
        if (prompt.includes('You are an expert Git commit assistant')) {
            return grouping([[files[0].path], [files[1].path]]);
        }
        return reply('feat: small');
    });
    const result = await service.generateCommits(files, options, cancellation().token, undefined, {
        confirmRequests: async () => { estimates += 1; return true; },
    });
    assert.equal(estimates, 0);
    assert.equal(result.candidates.length, 2);
});

test('parseResponse skips thinking blocks and braces inside JSON strings', () => {
    const raw = '<think>{"message":"ignored","reason":"ignored"}</think>\n' +
        'Here is the result: {"message":"feat: handle } brace","reason":"because the input has {braces} and \\"quotes\\""} thanks';
    assert.deepEqual(generation.parseResponse(raw), {
        message: 'feat: handle } brace',
        reason: 'because the input has {braces} and "quotes"',
    });
});

test('direct generation and grouping prompts include their required JSON formats', async () => {
    const files = [change('src/a.ts'), change('src/b.ts')];
    const env = setup((prompt) => {
        if (prompt.startsWith('Summarize the supplied')) { return 'summary'; }
        if (prompt.includes('You are an expert Git commit assistant')) {
            return grouping([[files[0].path], [files[1].path]]);
        }
        return reply('feat: formatted');
    });

    await service.generateCommits(files, options, cancellation().token);
    const generated = env.prompts.filter(prompt => prompt.includes('commit message generator'));
    assert.equal(generated.length, 2);
    for (const prompt of generated) {
        assert.ok(prompt.includes('Required JSON format:'));
        assert.ok(prompt.includes('{"message":"<commit message>","reason":"<why this change was made>"}'));
    }

    const groupingPrompt = env.prompts.find(prompt => prompt.includes('You are an expert Git commit assistant'))!;
    assert.ok(groupingPrompt.includes('Required JSON format:'));
    assert.ok(groupingPrompt.includes('{"label":"<one shared intent>","files":["<path1>","<path2>"]}'));
});

test('the summary-path generation prompt keeps the required JSON format', async () => {
    const files = [change('src/huge.ts', '+x\n'.repeat(20_000))];
    const env = setup((prompt) => {
        if (prompt.startsWith('Summarize the supplied')) { return 'summary of the supplied changes'; }
        return reply('feat: summarized');
    }, 4_000);

    await service.generateCommits(files, options, cancellation().token);
    const generated = env.prompts.filter(prompt => prompt.includes('commit message generator'));
    assert.equal(generated.length, 1);
    assert.ok(env.prompts.length > 1, 'the summary path was used');
    assert.ok(generated[0].includes('Required JSON format:'));
    assert.ok(generated[0].includes('{"message":"<commit message>","reason":"<why this change was made>"}'));
});

test('the output-retry prompt keeps the required JSON format', async () => {
    const env = setup((prompt) => {
        if (prompt.includes('commit message generator')) {
            return /previous reply could not be used/.test(prompt)
                ? reply('feat: retried')
                : 'not valid JSON';
        }
        throw new Error('unexpected request');
    });

    await service.generateCommits([change('src/a.ts')], options, cancellation().token);
    assert.equal(env.prompts.length, 2);
    assert.match(env.prompts[1], /previous reply could not be used/);
    for (const prompt of env.prompts) {
        assert.ok(prompt.includes('Required JSON format:'));
        assert.ok(prompt.includes('{"message":"<commit message>","reason":"<why this change was made>"}'));
    }
});

test('hunk lines that look like headers are kept and counted as changes', async () => {
    const diff = [
        'diff --git a/src/query.sql b/src/query.sql',
        'index 1111111..2222222 100644',
        '--- a/src/query.sql',
        '+++ b/src/query.sql',
        '@@ -1,2 +1,2 @@',
        '--- comment',
        '+++ x',
        ' context line',
    ].join('\n');
    const files = [change('src/query.sql', diff), change('src/other.ts', '+other\n')];
    const env = setup((prompt) => {
        if (prompt.startsWith('Summarize the supplied')) { return 'summary'; }
        if (prompt.includes('You are an expert Git commit assistant')) {
            return grouping([files.map(file => file.path)]);
        }
        return reply('refactor: query');
    });

    await service.generateCommits(files, options, cancellation().token);
    const prompt = env.prompts[0];
    assert.match(prompt, /^--- comment$/m);
    assert.match(prompt, /^\+\+\+ x$/m);
    assert.match(prompt, /^\+1 -1; \d+ characters\.$/m);
});
