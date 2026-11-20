import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDiff, resolveStagingPaths } from '../src/git/diffAnalyzer';

test('rename changes retain both paths needed to stage the deletion and addition', () => {
    const diff = `diff --git a/旧 file.txt b/新 file.txt
similarity index 100%
rename from 旧 file.txt
rename to 新 file.txt
`;

    const changes = parseDiff(diff);

    assert.equal(changes.length, 1);
    assert.equal(changes[0].type, 'renamed');
    assert.equal(changes[0].path, '新 file.txt');
    assert.equal(changes[0].originalPath, '旧 file.txt');
    assert.deepEqual(
        resolveStagingPaths(['新 file.txt'], changes),
        ['旧 file.txt', '新 file.txt']
    );
});

test('non-rename changes keep their existing staging paths', () => {
    const changes = parseDiff(`diff --git a/kept.txt b/kept.txt
index 257cc56..5716ca5 100644
--- a/kept.txt
+++ b/kept.txt
@@ -1 +1 @@
-before
+after
`);

    assert.deepEqual(resolveStagingPaths(['kept.txt'], changes), ['kept.txt']);
});

test('splits an unquoted header by length when the path itself contains " b/"', () => {
    const changes = parseDiff(`diff --git a/x b/y.txt b/x b/y.txt
index 257cc56..5716ca5 100644
--- a/x b/y.txt
+++ b/x b/y.txt
@@ -1 +1 @@
-before
+after
`);

    assert.equal(changes.length, 1);
    assert.equal(changes[0].path, 'x b/y.txt');
    assert.equal(changes[0].type, 'modified');
});

test('decodes quoted headers containing escaped quotes and literal UTF-8', () => {
    const changes = parseDiff(`diff --git "a/quote\\"中文.txt" "b/quote\\"中文.txt"
index 257cc56..5716ca5 100644
--- "a/quote\\"中文.txt"
+++ "b/quote\\"中文.txt"
@@ -1 +1 @@
-before
+after
`);

    assert.equal(changes.length, 1);
    assert.equal(changes[0].path, 'quote"中文.txt');
});

test('decodes octal-escaped non-ASCII paths in quoted headers', () => {
    const changes = parseDiff(`diff --git "a/\\344\\270\\255.txt" "b/\\344\\270\\255.txt"
index 257cc56..5716ca5 100644
--- "a/\\344\\270\\255.txt"
+++ "b/\\344\\270\\255.txt"
@@ -1 +1 @@
-before
+after
`);

    assert.equal(changes.length, 1);
    assert.equal(changes[0].path, '中.txt');
});

test('parses binary file and mode-only diffs', () => {
    const binary = `diff --git a/image.bin b/image.bin
index 1111111..2222222 100644
Binary files a/image.bin and b/image.bin differ
`;
    const mode = `diff --git a/run.sh b/run.sh
old mode 100644
new mode 100755
`;

    const changes = parseDiff(binary + mode);

    assert.deepEqual(changes.map((change) => change.path), ['image.bin', 'run.sh']);
    assert.deepEqual(changes.map((change) => change.type), ['modified', 'modified']);
    assert.equal(changes[0].diff, binary);
});

test('treats a copy as an addition using only the destination path', () => {
    const changes = parseDiff(`diff --git a/source.txt b/copied.txt
similarity index 100%
copy from source.txt
copy to copied.txt
`);

    assert.equal(changes.length, 1);
    assert.equal(changes[0].type, 'added');
    assert.equal(changes[0].path, 'copied.txt');
    assert.equal(changes[0].originalPath, undefined);
});

test('decodes quoted paths on rename lines', () => {
    const changes = parseDiff(`diff --git "a/old\\"name.txt" "b/new\\"name.txt"
similarity index 100%
rename from "old\\"name.txt"
rename to "new\\"name.txt"
`);

    assert.equal(changes.length, 1);
    assert.equal(changes[0].type, 'renamed');
    assert.equal(changes[0].originalPath, 'old"name.txt');
    assert.equal(changes[0].path, 'new"name.txt');
});
