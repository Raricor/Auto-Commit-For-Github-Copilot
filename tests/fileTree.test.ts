import assert from 'node:assert/strict';
import test from 'node:test';
import type { StagedFileInfo } from '../src/types';
import {
    allFolderPaths,
    buildFileTree,
    countDiffStats,
    defaultExpanded,
    flattenVisible,
    mergeExpanded,
} from '../src/webview/fileTree';
import type { TreeNode, TreeFolder } from '../src/webview/fileTree';

function staged(path: string, extra: Partial<StagedFileInfo> = {}): StagedFileInfo {
    return { path, type: 'modified', diff: '', ...extra };
}

function expectFolder(node: TreeNode | undefined): TreeFolder {
    if (node === undefined || node.kind !== 'folder') {
        assert.fail('expected a folder node');
    }
    return node;
}

test('sorts folders before files and uses natural name order', () => {
    const root = buildFileTree([
        staged('f10.ts'),
        staged('f2.ts'),
        staged('z10/x.ts'),
        staged('z2/y.ts'),
        staged('alpha/a.ts'),
    ]);

    assert.deepEqual(root.children.map((child) => child.name), ['alpha', 'z2', 'z10', 'f2.ts', 'f10.ts']);
    assert.deepEqual(root.children.map((child) => child.kind), ['folder', 'folder', 'folder', 'file', 'file']);
});

test('merges a single-child folder chain and stops at direct files or multiple children', () => {
    const chain = buildFileTree([staged('src/webview/components/X.tsx')]);
    const merged = expectFolder(chain.children[0]);
    assert.equal(merged.name, 'src/webview/components');
    assert.equal(merged.path, 'src/webview/components');
    assert.equal(merged.children.length, 1);
    assert.equal(merged.children[0].kind, 'file');
    assert.equal(merged.children[0].name, 'X.tsx');

    const withDirectFile = buildFileTree([
        staged('src/webview/components/X.tsx'),
        staged('src/webview/helper.ts'),
    ]);
    const stopped = expectFolder(withDirectFile.children[0]);
    assert.equal(stopped.name, 'src/webview');
    assert.equal(stopped.path, 'src/webview');
    assert.deepEqual(stopped.children.map((child) => child.name), ['components', 'helper.ts']);

    const withTwoChildren = buildFileTree([
        staged('src/a/x.ts'),
        staged('src/b/y.ts'),
    ]);
    const src = expectFolder(withTwoChildren.children[0]);
    assert.equal(src.name, 'src');
    assert.deepEqual(src.children.map((child) => child.name), ['a', 'b']);
});

test('folder fileCount and stats are the totals of their subtree', () => {
    const root = buildFileTree([
        staged('src/a/one.ts', { additions: 2, deletions: 1 }),
        staged('src/a/two.ts', { diff: '@@ -1 +1 @@\n-old\n+new\n+extra' }),
        staged('src/b/three.ts', { additions: 5, deletions: 0 }),
        staged('root.ts', { additions: 1, deletions: 1 }),
    ]);

    const src = expectFolder(root.children[0]);
    assert.equal(src.name, 'src');
    assert.equal(src.fileCount, 3);
    assert.deepEqual(src.stats, { additions: 9, deletions: 2 });

    const a = expectFolder(src.children[0]);
    assert.equal(a.name, 'a');
    assert.equal(a.fileCount, 2);
    assert.deepEqual(a.stats, { additions: 4, deletions: 2 });

    assert.equal(root.fileCount, 4);
    assert.deepEqual(root.stats, { additions: 10, deletions: 3 });
});

test('keeps root files and paths with spaces, " b/" and Chinese characters intact', () => {
    const root = buildFileTree([
        staged('README.md'),
        staged('docs/my file.txt'),
        staged('odd/x b/y.txt'),
        staged('中文/文件.txt'),
    ]);

    const rootFiles = root.children.filter((child) => child.kind === 'file');
    assert.deepEqual(rootFiles.map((child) => child.path), ['README.md']);
    assert.equal(rootFiles[0].name, 'README.md');

    const docs = expectFolder(root.children.find((child) => child.name === 'docs'));
    const docsFile = docs.children[0];
    assert.equal(docsFile.kind, 'file');
    assert.equal(docsFile.path, 'docs/my file.txt');
    assert.equal(docsFile.name, 'my file.txt');
    assert.equal(docsFile.file.path, 'docs/my file.txt');

    const odd = expectFolder(root.children.find((child) => child.name === 'odd/x b'));
    assert.equal(odd.path, 'odd/x b');
    assert.equal(odd.children[0].path, 'odd/x b/y.txt');

    const chinese = expectFolder(root.children.find((child) => child.name === '中文'));
    assert.equal(chinese.children[0].path, '中文/文件.txt');
    assert.equal(chinese.children[0].name, '文件.txt');
});

test('defaultExpanded opens everything for small changes and only the first level for large ones', () => {
    const small = buildFileTree([staged('a/one.ts'), staged('b/two.ts')]);
    assert.deepEqual(
        [...defaultExpanded(small, 2)].sort(),
        allFolderPaths(small).sort()
    );

    const many = Array.from({ length: 31 }, (_, index) => {
        const folder = index < 16 ? 'a' : 'b';
        return staged(`src/${folder}/f${index}.ts`);
    });
    const large = buildFileTree(many);
    const expanded = defaultExpanded(large, many.length);

    assert.deepEqual([...expanded], ['src']);
    assert.deepEqual(allFolderPaths(large).sort(), ['src', 'src/a', 'src/b']);
});

test('flattenVisible omits collapsed children and reports the correct depth', () => {
    const root = buildFileTree([staged('a/b/c.ts'), staged('a/d/e.ts')]);

    assert.deepEqual(flattenVisible(root, new Set()).map(({ node, depth }) => [node.name, depth]), [
        ['a', 0],
    ]);
    assert.deepEqual(flattenVisible(root, new Set(['a'])).map(({ node, depth }) => [node.name, depth]), [
        ['a', 0],
        ['b', 1],
        ['d', 1],
    ]);
    assert.deepEqual(
        flattenVisible(root, new Set(['a', 'a/d'])).map(({ node, depth }) => [node.name, depth]),
        [
            ['a', 0],
            ['b', 1],
            ['d', 1],
            ['e.ts', 2],
        ]
    );
});

test('a 1300-file tree renders very few rows with the default expansion', () => {
    const files = Array.from({ length: 1300 }, (_, index) =>
        staged(`src/d${index % 20}/sub${Math.floor(index / 20) % 5}/f${index}.ts`)
    );
    const root = buildFileTree(files);
    const expanded = defaultExpanded(root, files.length);
    const rows = flattenVisible(root, expanded);

    assert.ok(rows.length < 100, `expected fewer than 100 visible rows, got ${rows.length}`);
    assert.ok(rows.length < files.length / 2);
});

test('mergeExpanded preserves user choices, applies defaults to new folders, and drops removed ones', () => {
    const previousRoot = buildFileTree([
        staged('a/x.ts'),
        staged('b/y.ts'),
        staged('old/z.ts'),
    ]);
    const nextRoot = buildFileTree([
        staged('a/x.ts'),
        staged('b/y.ts'),
        staged('c/new.ts'),
    ]);

    const merged = mergeExpanded(new Set(['a']), previousRoot, nextRoot, 100);
    assert.deepEqual([...merged].sort(), ['a', 'c']);
});

test('mergeExpanded keeps a newly appearing nested folder collapsed for large changes', () => {
    const previousRoot = buildFileTree([staged('a/x.ts')]);
    const nextRoot = buildFileTree([staged('a/x.ts'), staged('a/new/y.ts')]);

    const merged = mergeExpanded(new Set(['a']), previousRoot, nextRoot, 100);
    assert.deepEqual([...merged], ['a']);
    assert.ok(allFolderPaths(nextRoot).includes('a/new'));
});

test('diff stats ignore file headers and count "-- comment" after the first hunk', () => {
    const diff = [
        'diff --git a/x b/x',
        '--- a/x',
        '+++ b/x',
        '@@ -1,2 +1,3 @@',
        '--- comment',
        '++ added',
        ' context',
        '-old',
        '+new',
    ].join('\n');

    assert.deepEqual(countDiffStats(diff), { additions: 2, deletions: 2 });

    const fromDiff = buildFileTree([staged('x.ts', { diff })]);
    assert.deepEqual(fromDiff.stats, { additions: 2, deletions: 2 });

    const provided = buildFileTree([
        staged('y.ts', {
            additions: 7,
            deletions: 9,
            diff: '@@ -1 +1 @@\n-a\n-b\n+c',
        }),
    ]);
    assert.deepEqual(provided.stats, { additions: 7, deletions: 9 });
});
