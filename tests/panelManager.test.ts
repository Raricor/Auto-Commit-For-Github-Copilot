import assert from 'node:assert/strict';
import test from 'node:test';
import type {
    CommitCandidate,
    ExtensionMessage,
    FileChange,
    GenerateOptions,
    PlannedGroup,
} from '../src/types';

const twoFileDiff = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n' +
    'diff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-old\n+new\n';
const renameDiff = 'diff --git a/old.ts b/new.ts\nsimilarity index 100%\nrename from old.ts\nrename to new.ts\n';
const candidateA: CommitCandidate = { id: 'a', message: 'fix: a', reason: 'Correct behavior', files: ['a.ts'], checked: true };
const candidateB: CommitCandidate = { id: 'b', message: 'fix: b', reason: 'Correct behavior', files: ['b.ts'], checked: true };
const renamed: CommitCandidate = { id: 'r', message: 'refactor: rename', reason: 'Keep names clear', files: ['new.ts'], checked: true };
const groups: PlannedGroup[] = [
    { index: 0, label: 'A', files: ['a.ts'] },
    { index: 1, label: 'B', files: ['b.ts'] },
];

type Events = {
    onProgress?: (progress: unknown) => void;
    onGroupsPlanned?: (planned: PlannedGroup[]) => void;
    onCandidate?: (groupIndex: number, candidate: CommitCandidate) => void;
    onGroupFailed?: (group: PlannedGroup, error: Error) => void;
    onNotice?: (level: 'info' | 'warning', message: string) => void;
    onReorder?: (ids: string[]) => void;
    confirmRequests?: (estimate: { groups: number; requests: number; stage: 'grouping' | 'generation' }) => Promise<boolean>;
};
type GenerationResult = {
    groups: PlannedGroup[];
    candidates: Array<{ groupIndex: number; candidate: CommitCandidate }>;
    failed: Array<{ group: PlannedGroup; error: Error }>;
    declined?: boolean;
};

let generateCommits: (
    changes: FileChange[],
    options: GenerateOptions,
    token: { isCancellationRequested: boolean },
    history: unknown,
    events: Events,
) => Promise<GenerationResult>;
let generateForGroup: (
    group: PlannedGroup,
    changes: FileChange[],
    options: GenerateOptions,
    token: { isCancellationRequested: boolean },
    history: unknown,
) => Promise<CommitCandidate>;
let gitCalls: Array<{ method: string; tree?: string; commits?: Array<{ id: string; paths: string[]; message: string }> }>;
let posts: ExtensionMessage[];
let infoMessages: string[];
let warnings: Array<{ message: string; options: unknown; items: string[] }>;
let warningChoice: string | undefined;
let diffText: string;
let indexTree: string;
let commitResult: { committedIds: string[]; error?: Error };
let configStore: Record<string, unknown>;
let configUpdates: Array<{ key: string; value: unknown; target: unknown }>;

class GitService {
    static async getRepository() { return { rootUri: { fsPath: '/test-repo' } }; }
    repoRoot = '/test-repo';
    async getStagedDiff() { return diffText; }
    async getRecentCommits() { return []; }
    async detectLanguage() { return 'en'; }
    async assertCommitIdentityConfigured() { gitCalls.push({ method: 'identity' }); }
    async writeIndexTree() { gitCalls.push({ method: 'writeTree' }); return indexTree; }
    async commitFromSnapshot(tree: string, commits: Array<{ id: string; paths: string[]; message: string }>) {
        gitCalls.push({ method: 'commit', tree, commits });
        return commitResult;
    }
}
class CancellationTokenSource {
    token = {
        isCancellationRequested: false,
        onCancellationRequested: () => ({ dispose() { } }),
    };
    cancel() { this.token.isCancellationRequested = true; }
}

const nodeModule = require('node:module');
const originalLoad = nodeModule._load;
nodeModule._load = function (id: string, ...args: unknown[]) {
    if (id === 'vscode') {
        return {
            CancellationTokenSource,
            CancellationError: class extends Error { },
            ConfigurationTarget: { Global: 1 },
            workspace: {
                getConfiguration: () => ({
                    get: (key: string, fallback: unknown) =>
                        key in configStore ? configStore[key] : fallback,
                    update: async (key: string, value: unknown, target: unknown) => {
                        configStore[key] = value;
                        configUpdates.push({ key, value, target });
                    },
                }),
            },
            window: {
                showInformationMessage: (message: string) => { infoMessages.push(message); },
                showWarningMessage: (message: string, options: unknown, ...items: string[]) => {
                    warnings.push({ message, options, items });
                    return Promise.resolve(warningChoice);
                },
            },
        };
    }
    if (id === '../git/gitService') { return { GitService }; }
    if (id === '../llm/llmService') {
        return {
            generateCommits: (
                changes: FileChange[],
                options: GenerateOptions,
                token: { isCancellationRequested: boolean },
                history: unknown,
                events: Events,
            ) => generateCommits(changes, options, token, history, events),
            generateForGroup: (
                group: PlannedGroup,
                changes: FileChange[],
                options: GenerateOptions,
                token: { isCancellationRequested: boolean },
                history: unknown,
            ) => generateForGroup(group, changes, options, token, history),
        };
    }
    return originalLoad.call(this, id, ...args);
};
const { PanelManager } = require('../src/ui/panelManager');
const { getSettings, updateSettings } = require('../src/config/settings');
nodeModule._load = originalLoad;

function setup() {
    gitCalls = [];
    posts = [];
    infoMessages = [];
    warnings = [];
    warningChoice = undefined;
    diffText = twoFileDiff;
    indexTree = 'tree-1';
    commitResult = { committedIds: [] };
    configStore = {};
    configUpdates = [];
    generateCommits = async () => ({ groups: [], candidates: [], failed: [] });
    generateForGroup = async () => candidateA;
    const panel = new PanelManager({ subscriptions: [] });
    // PanelManager.post() only needs the webview's message channel in these tests.
    (panel as any).panel = { webview: { postMessage: (message: ExtensionMessage) => posts.push(message) } };
    return panel;
}

function commitsMade() {
    return gitCalls.filter((call) => call.method === 'commit');
}

function stagedFilesMessage(): Extract<ExtensionMessage, { type: 'stagedFiles' }> {
    const message = posts.find(
        (post): post is Extract<ExtensionMessage, { type: 'stagedFiles' }> =>
            post.type === 'stagedFiles'
    );
    assert.ok(message, 'expected a stagedFiles message');
    return message;
}

async function prepareRun(panel: any) {
    generateCommits = async (_changes, _options, _token, _history, events) => {
        events.onGroupsPlanned?.(groups);
        events.onCandidate?.(0, candidateA);
        events.onCandidate?.(1, candidateB);
        return {
            groups,
            candidates: [
                { groupIndex: 0, candidate: candidateA },
                { groupIndex: 1, candidate: candidateB },
            ],
            failed: [],
        };
    };
    await panel.generate({ language: 'en', conventionalCommits: true });
    posts = [];
    gitCalls = [];
}

test('a commit command cannot mutate the index while generation is still running', async () => {
    const panel = setup();
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    generateCommits = async (_changes, _options, _token, _history, events) => {
        events.onCandidate?.(0, candidateA);
        started();
        await pending;
        return { groups: [groups[0]], candidates: [{ groupIndex: 0, candidate: candidateA }], failed: [] };
    };
    const running = panel.generate({ language: 'en', conventionalCommits: true });
    await ready;
    try {
        // Simulate the webview trying to submit an already displayed candidate.
        assert.deepEqual(panel.candidates, [candidateA]);
        gitCalls = [];
        await panel.commitSelected(['a']);
        assert.deepEqual(gitCalls, []);
    } finally {
        release();
        await running;
    }
});

test('refuses to commit when the staged snapshot changed after generation', async () => {
    const panel = setup();
    generateCommits = async (_changes, _options, _token, _history, events) => {
        events.onCandidate?.(0, candidateA);
        return { groups: [groups[0]], candidates: [{ groupIndex: 0, candidate: candidateA }], failed: [] };
    };
    await panel.generate({ language: 'en', conventionalCommits: true });
    posts = [];
    gitCalls = [];
    indexTree = 'tree-2';

    await panel.commitSelected(['a']);

    assert.equal(commitsMade().length, 0);
    assert.equal(gitCalls.filter((call) => call.method === 'identity').length, 1);
    assert.ok(posts.some((message) =>
        message.type === 'error' &&
        message.message === 'The staged changes have changed since generation. Generate again before committing.'
    ));
    assert.deepEqual(panel.candidates, [candidateA]);
});

test('a partial commit reports successful ids first, then the failure', async () => {
    const panel = setup();
    generateCommits = async (_changes, _options, _token, _history, events) => {
        events.onCandidate?.(0, candidateA);
        events.onCandidate?.(1, candidateB);
        return {
            groups,
            candidates: [
                { groupIndex: 0, candidate: candidateA },
                { groupIndex: 1, candidate: candidateB },
            ],
            failed: [],
        };
    };
    await panel.generate({ language: 'en', conventionalCommits: true });
    posts = [];
    gitCalls = [];
    commitResult = { committedIds: ['a'], error: new Error('hook rejected b') };

    await panel.commitSelected(['a', 'b']);

    assert.deepEqual(posts[0], { type: 'committed', count: 1, ids: ['a'] });
    assert.deepEqual(posts[1], { type: 'error', message: 'Commit failed after 1 commit(s): hook rejected b' });
    assert.deepEqual(panel.candidates, [candidateB]);
    assert.deepEqual(infoMessages, []);
    assert.deepEqual(commitsMade()[0].commits?.map((commit) => commit.id), ['a', 'b']);
});

test('a renamed candidate passes both the old and new paths to the snapshot commit', async () => {
    const panel = setup();
    diffText = renameDiff;
    commitResult = { committedIds: ['r'] };
    generateCommits = async (_changes, _options, _token, _history, events) => {
        events.onCandidate?.(0, renamed);
        return { groups: [groups[0]], candidates: [{ groupIndex: 0, candidate: renamed }], failed: [] };
    };
    await panel.generate({ language: 'en', conventionalCommits: true });
    gitCalls = [];

    await panel.commitSelected(['r']);

    assert.deepEqual(commitsMade()[0].commits?.[0].paths, ['old.ts', 'new.ts']);
});

test('generation messages are emitted in order and reorder updates the candidate list', async () => {
    const panel = setup();
    generateCommits = async (_changes, _options, _token, _history, events) => {
        events.onProgress?.({ stage: 'grouping' });
        events.onGroupsPlanned?.(groups);
        events.onCandidate?.(0, candidateA);
        events.onCandidate?.(1, candidateB);
        events.onReorder?.(['b', 'a']);
        return {
            groups,
            candidates: [
                { groupIndex: 0, candidate: candidateA },
                { groupIndex: 1, candidate: candidateB },
            ],
            failed: [],
        };
    };

    await panel.generate({ language: 'en', conventionalCommits: true });

    assert.deepEqual(posts.map((message) => message.type), [
        'loading', 'progress', 'groupsPlanned', 'addCandidate', 'addCandidate', 'reorder', 'done',
    ]);
    assert.deepEqual(posts[1], { type: 'progress', progress: { stage: 'grouping' } });
    assert.deepEqual(posts[2], { type: 'groupsPlanned', groups });
    assert.deepEqual(posts[3], { type: 'addCandidate', candidate: candidateA, groupIndex: 0 });
    assert.deepEqual(posts[4], { type: 'addCandidate', candidate: candidateB, groupIndex: 1 });
    assert.deepEqual(posts[5], { type: 'reorder', ids: ['b', 'a'] });
    assert.deepEqual(panel.candidates, [candidateB, candidateA]);
});

test('group failures and notices are forwarded to the webview', async () => {
    const panel = setup();
    const failure = new Error('model unavailable');
    generateCommits = async (_changes, _options, _token, _history, events) => {
        events.onGroupFailed?.(groups[0], failure);
        events.onNotice?.('warning', 'Grouping fell back to folder rules.');
        return { groups, candidates: [], failed: [{ group: groups[0], error: failure }] };
    };

    await panel.generate({ language: 'en', conventionalCommits: true });

    assert.deepEqual(posts, [
        { type: 'loading' },
        { type: 'groupFailed', group: groups[0], message: 'model unavailable' },
        { type: 'notice', level: 'warning', message: 'Grouping fell back to folder rules.' },
        { type: 'done' },
    ]);
});

test('confirmRequests accepts only the Continue choice and uses the expected copy', async () => {
    const panel = setup();
    await panel.loadStagedFiles();
    posts = [];

    warningChoice = 'Continue';
    assert.equal(
        await panel.confirmRequests({ groups: 2, requests: 80, stage: 'grouping' }),
        true
    );
    assert.equal(warnings[0].message, 'Grouping 2 files needs about 80 model requests.');
    assert.deepEqual(warnings[0].options, {
        modal: true,
        detail: 'Large changes are analyzed in several requests. Each request may count toward your Copilot premium request quota.',
    });
    assert.deepEqual(warnings[0].items, ['Continue']);

    warningChoice = undefined;
    assert.equal(
        await panel.confirmRequests({ groups: 2, requests: 80, stage: 'grouping' }),
        false
    );
    assert.equal(
        await panel.confirmRequests({ groups: 3, requests: 90, stage: 'generation' }),
        false
    );
    assert.equal(warnings[2].message, 'Generating 3 commits needs about 90 model requests.');
});

test('a declined estimate sends an info notice and then done', async () => {
    const panel = setup();
    warningChoice = undefined;
    generateCommits = async (_changes, _options, _token, _history, events) => {
        const accepted = await events.confirmRequests?.({
            groups: 3,
            requests: 90,
            stage: 'generation',
        });
        assert.equal(accepted, false);
        return { groups: [], candidates: [], failed: [], declined: true };
    };

    await panel.generate({ language: 'en', conventionalCommits: true });

    assert.deepEqual(posts.map((message) => message.type), ['loading', 'notice', 'done']);
    assert.deepEqual(posts[1], {
        type: 'notice',
        level: 'info',
        message: 'Stopped before sending generation requests.',
    });
});

test('retryGroup adds the successful candidate with its group index', async () => {
    const panel = setup();
    await prepareRun(panel);
    let retried: PlannedGroup | undefined;
    generateForGroup = async (group) => { retried = group; return candidateB; };

    await panel.retryGroup(1, { language: 'en', conventionalCommits: true });

    assert.equal(retried, groups[1]);
    assert.deepEqual(posts, [
        { type: 'addCandidate', candidate: candidateB, groupIndex: 1 },
    ]);
    assert.deepEqual(panel.candidates, [candidateA, candidateB, candidateB]);
});

test('retryGroup reports a failed retry', async () => {
    const panel = setup();
    await prepareRun(panel);
    generateForGroup = async () => { throw new Error('provider down'); };

    await panel.retryGroup(1, { language: 'en', conventionalCommits: true });

    assert.deepEqual(posts, [
        { type: 'groupFailed', group: groups[1], message: 'provider down' },
    ]);
});

test('a retry in flight blocks commits', async () => {
    const panel = setup();
    await prepareRun(panel);
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    generateForGroup = async () => { started(); await pending; return candidateB; };

    const retrying = panel.retryGroup(1, { language: 'en', conventionalCommits: true });
    await ready;
    try {
        gitCalls = [];
        await panel.commitSelected(['b']);
        assert.deepEqual(gitCalls, []);
    } finally {
        release();
        await retrying;
    }
});

test('retryGroup is ignored while a generation run is active', async () => {
    const panel = setup();
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    generateCommits = async (_changes, _options, _token, _history, events) => {
        events.onGroupsPlanned?.(groups);
        started();
        await pending;
        return { groups, candidates: [], failed: [] };
    };
    let retried = false;
    generateForGroup = async () => { retried = true; return candidateA; };

    const running = panel.generate({ language: 'en', conventionalCommits: true });
    await ready;
    try {
        posts = [];
        await panel.retryGroup(0, { language: 'en', conventionalCommits: true });
        assert.equal(retried, false);
        assert.deepEqual(posts, []);
    } finally {
        release();
        await running;
    }
});

test('retryGroup reports a group that is no longer available', async () => {
    const panel = setup();
    await prepareRun(panel);
    let retried = false;
    generateForGroup = async () => { retried = true; return candidateA; };

    await panel.retryGroup(9, { language: 'en', conventionalCommits: true });

    assert.equal(retried, false);
    assert.deepEqual(posts, [{
        type: 'groupFailed',
        group: { index: 9, label: '', files: [] },
        message: 'This group is no longer available. Generate again.',
    }]);
});

test('settings read the new keys, clamp out-of-range values, and persist updates', async () => {
    configStore = {
        minCommits: -7,
        maxCommits: 500,
        reasoningEffort: 'turbo',
        concurrency: 12.9,
    };
    configUpdates = [];
    const clamped = getSettings();
    assert.equal(clamped.minCommits, 0);
    assert.equal(clamped.maxCommits, 200);
    assert.equal(clamped.reasoningEffort, '');
    assert.equal(clamped.concurrency, 8);

    configStore = {
        minCommits: 3.9,
        maxCommits: 2.2,
        reasoningEffort: 'high',
        concurrency: 4.8,
    };
    const rounded = getSettings();
    assert.equal(rounded.minCommits, 3);
    assert.equal(rounded.maxCommits, 2);
    assert.equal(rounded.reasoningEffort, 'high');
    assert.equal(rounded.concurrency, 4);

    await updateSettings({
        minCommits: 5,
        maxCommits: 9,
        reasoningEffort: 'xhigh',
        concurrency: 2,
    });
    assert.deepEqual(configUpdates.map((update) => [update.key, update.value]), [
        ['minCommits', 5],
        ['maxCommits', 9],
        ['reasoningEffort', 'xhigh'],
        ['concurrency', 2],
    ]);
});

test('large staged diffs are omitted while line counts are still sent', async () => {
    const panel = setup();
    const largeLine = `+${'x'.repeat(600 * 1024)}`;
    diffText =
        `diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n${largeLine}\n` +
        `diff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-old\n${largeLine}\n`;

    await panel.loadStagedFiles();

    const message = stagedFilesMessage();
    assert.equal(message.files.length, 2);
    for (const file of message.files) {
        assert.equal(file.diff, '');
        assert.equal(file.diffOmitted, true);
        assert.equal(file.additions, 1);
        assert.equal(file.deletions, 1);
    }
});

test('staged diffs under the limit are sent with line counts', async () => {
    const panel = setup();

    await panel.loadStagedFiles();

    const message = stagedFilesMessage();
    assert.equal(message.files.length, 2);
    for (const file of message.files) {
        assert.ok(file.diff.includes('+new'));
        assert.equal(file.diffOmitted, undefined);
        assert.equal(file.additions, 1);
        assert.equal(file.deletions, 1);
    }
});

test('callbacks from a cancelled run send no further messages', async () => {
    const panel = setup();
    generateCommits = async (_changes, _options, _token, _history, events) => {
        panel.cancellation.cancel();
        events.onProgress?.({ stage: 'grouping' });
        events.onGroupsPlanned?.(groups);
        events.onCandidate?.(0, candidateA);
        events.onGroupFailed?.(groups[0], new Error('cancelled'));
        events.onNotice?.('info', 'cancelled');
        events.onReorder?.(['a']);
        return { groups, candidates: [], failed: [] };
    };

    await panel.generate({ language: 'en', conventionalCommits: true });

    assert.deepEqual(posts.map((message) => message.type), ['loading']);
});
