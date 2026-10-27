import assert from 'node:assert/strict';
import test from 'node:test';
import type { CommitCandidate } from '../src/types';

const diff = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n' +
    'diff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-old\n+new\n';
const candidate: CommitCandidate = { id: 'a', message: 'fix: a', reason: 'Correct behavior', files: ['a.ts'], checked: true };
let generate: (publish: (c: CommitCandidate) => void) => Promise<void>;
let gitCalls: Array<{ method: string; paths?: string[] }>;
class GitService {
    static async getRepository() { return { rootUri: { fsPath: '/test-repo' } }; }
    repoRoot = '/test-repo';
    async getStagedDiff() { return diff; }
    async getRecentCommits() { return []; }
    async assertCommitIdentityConfigured() { gitCalls.push({ method: 'identity' }); }
    async unstageAll() { gitCalls.push({ method: 'unstage' }); }
    async stageAndCommit(paths: string[]) { gitCalls.push({ method: 'commit', paths }); }
    async restoreStaged(paths: string[]) { gitCalls.push({ method: 'restore', paths }); }
}
class CancellationTokenSource {
    token = { isCancellationRequested: false };
    cancel() { this.token.isCancellationRequested = true; }
}
const nodeModule = require('node:module');
const originalLoad = nodeModule._load;
nodeModule._load = function (id: string, ...args: unknown[]) {
    if (id === 'vscode') {
        return { CancellationTokenSource, CancellationError: class extends Error {}, window: { showInformationMessage() {} } };
    }
    if (id === '../git/gitService') { return { GitService }; }
    if (id === '../llm/llmService') {
        return { generateGroupedCommits: async (_c: unknown, _o: unknown, _t: unknown, _h: unknown, publish: (c: CommitCandidate) => void) => { await generate(publish); return [candidate]; } };
    }
    return originalLoad.call(this, id, ...args);
};
const { PanelManager } = require('../src/ui/panelManager');
nodeModule._load = originalLoad;

function setup() {
    gitCalls = [];
    return new PanelManager({ subscriptions: [] });
}

test('a commit command cannot mutate the index while generation is still running', async () => {
    const panel = setup();
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    generate = async publish => { publish?.(candidate); started(); await pending; };
    const running = panel.generate({ language: 'en', conventionalCommits: true });
    await ready;
    try {
        // Simulate the webview trying to submit an already displayed candidate.
        assert.deepEqual(panel.candidates, [candidate]);
        await panel.commitSelected(['a']);
        assert.deepEqual(gitCalls, []);
    } finally {
        release();
        await running;
    }
});

test('committing a completed candidate after partial generation preserves ungenerated staged files', async () => {
    const panel = setup();
    generate = async publish => { publish?.(candidate); throw new Error('later group failed'); };
    await panel.generate({ language: 'en', conventionalCommits: true });
    assert.deepEqual(panel.candidates, [candidate]);
    await panel.commitSelected(['a']);
    assert.deepEqual(gitCalls.find(call => call.method === 'restore')?.paths, ['b.ts']);
});
