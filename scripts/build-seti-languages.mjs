// Builds the file-name/extension -> VS Code language id map used to resolve Seti icons.
//
// The input directory must contain the `package.json` files of VS Code's built-in
// extensions for a single commit. To refresh them, list the directories under
// `extensions/` through the GitHub API at the pinned commit, then download each
// directory's `package.json` (and only that file) into one local directory:
//
//   https://api.github.com/repos/microsoft/vscode/contents/extensions?ref=<commit>
//
// `filenamePatterns` are intentionally ignored: the webview only needs exact
// file names and extensions, and patterns would require VS Code's glob engine.
// Regenerate this map whenever the bundled Seti theme is upgraded to a new
// VS Code commit.
//
// Usage: node scripts/build-seti-languages.mjs <directory-with-package-json-files> <output-file>

import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const SOURCE = 'microsoft/vscode@8a14f0cc1b08d531eb83255ea3764ae22aa932b5';

const [inputDirectory, outputFile] = process.argv.slice(2);
if (!inputDirectory || !outputFile) {
    console.error('Usage: node scripts/build-seti-languages.mjs <directory> <output-file>');
    process.exit(1);
}

const entries = (await readdir(inputDirectory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .map(entry => entry.name)
    .sort();

if (entries.length === 0) {
    console.error(`No JSON files found in ${inputDirectory}`);
    process.exit(1);
}

const extensions = new Map();
const filenames = new Map();
let conflicts = 0;

function register(target, kind, value, languageId, sourceFile) {
    const key = value.toLowerCase();
    const existing = target.get(key);
    if (existing !== undefined) {
        conflicts += 1;
        console.error(
            `Conflict: ${kind} "${key}" from ${sourceFile} (${languageId}) ` +
            `already mapped to ${existing}; keeping the first one`
        );
        return;
    }
    target.set(key, languageId);
}

for (const entry of entries) {
    const file = path.join(inputDirectory, entry);
    const text = await readFile(file, 'utf8');
    let data;
    try {
        data = JSON.parse(text);
    } catch (error) {
        console.error(`Failed to parse ${file}: ${error.message}`);
        process.exit(1);
    }

    const languages = data?.contributes?.languages;
    if (!Array.isArray(languages)) {
        continue;
    }

    for (const language of languages) {
        const languageId = language?.id;
        if (typeof languageId !== 'string' || languageId.length === 0) {
            continue;
        }
        for (const extension of language.extensions ?? []) {
            if (typeof extension === 'string') {
                register(extensions, 'extension', extension, languageId, entry);
            }
        }
        for (const filename of language.filenames ?? []) {
            if (typeof filename === 'string') {
                register(filenames, 'filename', filename, languageId, entry);
            }
        }
    }
}

function sortedObject(map) {
    return Object.fromEntries(
        [...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    );
}

const output = {
    source: SOURCE,
    extensions: sortedObject(extensions),
    filenames: sortedObject(filenames),
};

await writeFile(outputFile, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
console.error(
    `Wrote ${extensions.size} extensions and ${filenames.size} filenames ` +
    `from ${entries.length} files (${conflicts} conflicts) to ${outputFile}`
);
