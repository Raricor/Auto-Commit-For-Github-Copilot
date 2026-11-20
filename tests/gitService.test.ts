import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test, { type TestContext } from 'node:test';
import { resolveStagingPaths, parseDiff } from '../src/git/diffAnalyzer';

// GitService only needs the repository's fsPath; VS Code itself is not needed.
const nodeModule = require('node:module');
const originalLoad = nodeModule._load;
nodeModule._load = function (id: string, ...args: unknown[]) {
    if (id === 'vscode') {
        return {};
    }
    return originalLoad.call(this, id, ...args);
};
const { GitService } = require('../src/git/gitService') as typeof import('../src/git/gitService');
nodeModule._load = originalLoad;

function git(cwd: string, args: string[], input?: string): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8', input });
}

function gitResult(cwd: string, args: string[]) {
    return spawnSync('git', args, { cwd, encoding: 'utf8' });
}

function makeRepo(t: TestContext): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autocommit-gitservice-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    git(dir, ['init', '-q']);
    git(dir, ['config', 'user.name', 'Test User']);
    git(dir, ['config', 'user.email', 'test@example.com']);
    git(dir, ['config', 'commit.gpgsign', 'false']);
    git(dir, ['config', 'core.filemode', 'true']);
    return dir;
}

function service(dir: string): InstanceType<typeof GitService> {
    return new GitService({ rootUri: { fsPath: dir } } as any);
}

function write(dir: string, file: string, content: string | Buffer): void {
    const target = path.join(dir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
}

function read(dir: string, file: string): string {
    return fs.readFileSync(path.join(dir, file), 'utf8');
}

function commitAll(dir: string, message = 'init'): void {
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', message]);
}

/** Stages only the first hunk of a file with two far-apart changes. */
function stageFirstHunk(dir: string, file: string): void {
    git(dir, ['add', '-p', '--', file], 'y\nn\n');
}

test('commits only the staged hunk and leaves the unstaged hunk in the working tree', async (t) => {
    const dir = makeRepo(t);
    const svc = service(dir);
    write(dir, 'f.txt', Array.from({ length: 20 }, (_, i) => `${i + 1}\n`).join(''));
    commitAll(dir);

    const changed = read(dir, 'f.txt').split('\n');
    changed[1] = 'TWO';
    changed[18] = 'NINETEEN';
    write(dir, 'f.txt', changed.join('\n'));
    stageFirstHunk(dir, 'f.txt');

    const result = await svc.commitFromSnapshot(await svc.writeIndexTree(), [
        { id: 'first', paths: ['f.txt'], message: 'first hunk only' },
    ]);

    assert.deepEqual(result.committedIds, ['first']);
    assert.equal(result.error, undefined);
    const committed = git(dir, ['show', 'HEAD:f.txt']);
    assert.match(committed, /^TWO$/m);
    assert.doesNotMatch(committed, /^NINETEEN$/m);
    assert.match(read(dir, 'f.txt'), /^NINETEEN$/m, 'the second hunk remains in the working tree');
    assert.equal(git(dir, ['diff', '--cached', '--name-only']).trim(), '');
});

test('committing one candidate leaves other staged files byte-for-byte unchanged', async (t) => {
    const dir = makeRepo(t);
    const svc = service(dir);
    write(dir, 'a.txt', Array.from({ length: 20 }, (_, i) => `a${i + 1}\n`).join(''));
    write(dir, 'b.txt', Array.from({ length: 20 }, (_, i) => `b${i + 1}\n`).join(''));
    commitAll(dir);

    const a = read(dir, 'a.txt').split('\n');
    a[1] = 'A-TWO';
    a[18] = 'A-NINETEEN';
    write(dir, 'a.txt', a.join('\n'));
    const b = read(dir, 'b.txt').split('\n');
    b[1] = 'B-TWO';
    b[18] = 'B-NINETEEN';
    write(dir, 'b.txt', b.join('\n'));
    stageFirstHunk(dir, 'a.txt');
    stageFirstHunk(dir, 'b.txt');

    const beforeB = git(dir, ['diff', '--cached', '--', 'b.txt']);
    const beforeBlob = git(dir, ['ls-files', '-s', '--', 'b.txt']);
    const snapshot = await svc.writeIndexTree();

    const result = await svc.commitFromSnapshot(snapshot, [
        { id: 'a', paths: ['a.txt'], message: 'feat: a' },
    ]);

    assert.deepEqual(result.committedIds, ['a']);
    assert.equal(result.error, undefined);
    assert.equal(git(dir, ['diff', '--cached', '--', 'b.txt']), beforeB);
    assert.equal(git(dir, ['ls-files', '-s', '--', 'b.txt']), beforeBlob);
    assert.equal(git(dir, ['diff', '--cached', '--name-only']).trim(), 'b.txt');
    assert.match(read(dir, 'a.txt'), /^A-NINETEEN$/m);
    assert.match(read(dir, 'b.txt'), /^B-NINETEEN$/m);
});

test('commits a rename (both paths), a deletion and a new file from the snapshot', async (t) => {
    const dir = makeRepo(t);
    const svc = service(dir);
    write(dir, 'old.txt', 'rename me\n');
    write(dir, 'deleted.txt', 'delete me\n');
    commitAll(dir);

    git(dir, ['mv', 'old.txt', 'new.txt']);
    git(dir, ['rm', '-q', 'deleted.txt']);
    write(dir, 'added.txt', 'brand new\n');
    git(dir, ['add', 'added.txt']);

    const changes = parseDiff(await svc.getStagedDiff());
    const renamed = changes.find((change) => change.type === 'renamed');
    assert.ok(renamed);
    assert.equal(renamed.path, 'new.txt');
    assert.equal(renamed.originalPath, 'old.txt');

    const paths = changes.flatMap((change) => resolveStagingPaths([change.path], changes));
    const result = await svc.commitFromSnapshot(await svc.writeIndexTree(), [
        { id: 'all', paths, message: 'refactor: rename and clean up' },
    ]);

    assert.deepEqual(result.committedIds, ['all']);
    assert.equal(result.error, undefined);
    const names = git(dir, ['show', '--name-status', '--format=', 'HEAD']);
    assert.match(names, /^R100\told\.txt\tnew\.txt$/m);
    assert.match(names, /^D\tdeleted\.txt$/m);
    assert.match(names, /^A\tadded\.txt$/m);
    assert.equal(git(dir, ['diff', '--cached', '--name-only']).trim(), '');
});

test('commits from a snapshot in a repository without HEAD', async (t) => {
    const dir = makeRepo(t);
    const svc = service(dir);
    write(dir, 'first.txt', 'first commit\n');
    git(dir, ['add', 'first.txt']);

    const result = await svc.commitFromSnapshot(await svc.writeIndexTree(), [
        { id: 'first', paths: ['first.txt'], message: 'feat: first commit' },
    ]);

    assert.deepEqual(result.committedIds, ['first']);
    assert.equal(result.error, undefined);
    assert.equal(git(dir, ['show', 'HEAD:first.txt']), 'first commit\n');
    assert.equal(git(dir, ['diff', '--cached', '--name-only']).trim(), '');
    assert.equal(read(dir, 'first.txt'), 'first commit\n');
});

test('a failing pre-commit hook keeps earlier commits and restores the remaining index', async (t) => {
    const dir = makeRepo(t);
    const svc = service(dir);
    write(dir, 'base.txt', 'base\n');
    commitAll(dir);

    write(dir, 'a.txt', 'a content\n');
    write(dir, 'b.txt', 'b content\n');
    git(dir, ['add', 'a.txt', 'b.txt']);
    const beforeB = git(dir, ['diff', '--cached', '--', 'b.txt']);
    const beforeBlob = git(dir, ['ls-files', '-s', '--', 'b.txt']);
    const beforeWorking = read(dir, 'b.txt');

    const hook = path.join(dir, '.git', 'hooks', 'pre-commit');
    fs.writeFileSync(
        hook,
        '#!/bin/sh\nif git diff --cached --name-only | grep -qx b.txt; then\n  echo "b is blocked" >&2\n  exit 1\nfi\nexit 0\n',
        { mode: 0o755 }
    );

    const result = await svc.commitFromSnapshot(await svc.writeIndexTree(), [
        { id: 'a', paths: ['a.txt'], message: 'feat: a' },
        { id: 'b', paths: ['b.txt'], message: 'feat: b' },
    ]);

    assert.deepEqual(result.committedIds, ['a']);
    assert.ok(result.error);
    assert.match(result.error.message, /b is blocked/);
    assert.equal(git(dir, ['log', '--format=%s']).trim().split('\n').length, 2);
    assert.equal(git(dir, ['diff', '--cached', '--name-only']).trim(), 'b.txt');
    assert.equal(git(dir, ['diff', '--cached', '--', 'b.txt']), beforeB);
    assert.equal(git(dir, ['ls-files', '-s', '--', 'b.txt']), beforeBlob);
    assert.equal(read(dir, 'b.txt'), beforeWorking);
    assert.equal(git(dir, ['diff', '--name-only']).trim(), '');
});

test('writeIndexTree fails while the index has unresolved conflicts', async (t) => {
    const dir = makeRepo(t);
    const svc = service(dir);
    write(dir, 'conflict.txt', 'base\n');
    commitAll(dir);
    const main = git(dir, ['branch', '--show-current']).trim();

    git(dir, ['checkout', '-q', '-b', 'side']);
    write(dir, 'conflict.txt', 'side\n');
    commitAll(dir, 'side');
    git(dir, ['checkout', '-q', main]);
    write(dir, 'conflict.txt', 'main\n');
    commitAll(dir, 'main');

    const merge = gitResult(dir, ['merge', 'side']);
    assert.notEqual(merge.status, 0);
    await assert.rejects(svc.writeIndexTree());
});

test('getStagedDiff overrides mnemonic and no-prefix diff configuration', async (t) => {
    const dir = makeRepo(t);
    const svc = service(dir);
    write(dir, 'src/file.txt', 'before\n');
    commitAll(dir);
    write(dir, 'src/file.txt', 'after\n');
    git(dir, ['add', 'src/file.txt']);

    for (const config of [
        ['diff.mnemonicPrefix', 'true'],
        ['diff.noprefix', 'true'],
    ]) {
        git(dir, ['config', config[0], config[1]]);
        const diff = await svc.getStagedDiff();
        assert.match(diff, /^diff --git a\/src\/file\.txt b\/src\/file\.txt$/m);
        assert.deepEqual(parseDiff(diff).map((change) => change.path), ['src/file.txt']);
        git(dir, ['config', '--unset', config[0]]);
    }

    git(dir, ['config', 'diff.mnemonicPrefix', 'true']);
    git(dir, ['config', 'diff.noprefix', 'true']);
    assert.deepEqual(
        parseDiff(await svc.getStagedDiff()).map((change) => change.path),
        ['src/file.txt']
    );
});

test('parses paths containing " b/", double quotes, Unicode, binary data and mode changes', async (t) => {
    const dir = makeRepo(t);
    const svc = service(dir);
    write(dir, 'x b/y.txt', 'one\n');
    write(dir, 'quote"中文.txt', 'one\n');
    write(dir, '中文.txt', 'one\n');
    write(dir, 'binary.bin', Buffer.from([0, 1, 2, 3]));
    write(dir, 'mode.sh', '#!/bin/sh\necho hi\n');
    commitAll(dir);

    write(dir, 'x b/y.txt', 'two\n');
    write(dir, 'quote"中文.txt', 'two\n');
    write(dir, '中文.txt', 'two\n');
    write(dir, 'binary.bin', Buffer.from([0, 1, 2, 4]));
    write(dir, 'image.bin', Buffer.from([0, 0, 0, 255]));
    fs.chmodSync(path.join(dir, 'mode.sh'), 0o755);
    git(dir, ['add', '-A']);

    const diff = await svc.getStagedDiff();
    const paths = parseDiff(diff).map((change) => change.path).sort();
    assert.deepEqual(paths, [
        'binary.bin',
        'image.bin',
        'mode.sh',
        'quote"中文.txt',
        'x b/y.txt',
        '中文.txt',
    ].sort());
});
