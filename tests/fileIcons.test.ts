import assert from 'node:assert/strict';
import test from 'node:test';
import themeJson from '../media/seti/vs-seti-icon-theme.json';
import languagesJson from '../media/seti/languages.json';
import { resolveSetiIcon } from '../src/webview/fileIcons';
import type { LanguageMap, SetiIcon, SetiTheme } from '../src/webview/fileIcons';

const theme = themeJson as unknown as SetiTheme;
const languages = languagesJson as unknown as LanguageMap;

function char(code: number): string {
    return String.fromCharCode(code);
}

function expectIcon(fileName: string, kind: 'dark' | 'light', expected: SetiIcon): void {
    assert.deepEqual(resolveSetiIcon(fileName, kind, theme, languages), expected);
}

test('resolves dark Seti icons through file names, extensions, and language ids', () => {
    expectIcon('index.ts', 'dark', { character: char(0xE099), color: '#519aba' });
    expectIcon('App.tsx', 'dark', { character: char(0xE07D), color: '#519aba' });
    expectIcon('README.md', 'dark', { character: char(0xE04D), color: '#519aba' });
    expectIcon('notes.md', 'dark', { character: char(0xE060), color: '#519aba' });
    expectIcon('tsconfig.json', 'dark', { character: char(0xE097), color: '#519aba' });
    expectIcon('package.json', 'dark', { character: char(0xE055), color: '#cbcb41' });
    expectIcon('yarn.lock', 'dark', { character: char(0xE0A6), color: '#519aba' });
    expectIcon('Dockerfile', 'dark', { character: char(0xE025), color: '#519aba' });
    expectIcon('.gitignore', 'dark', { character: char(0xE034), color: '#41535b' });
    expectIcon('foo.unknownext', 'dark', { character: char(0xE023), color: '#d4d7d6' });
    expectIcon('README.MD', 'dark', { character: char(0xE04D), color: '#519aba' });
});

test('resolves light Seti icons from the light section', () => {
    expectIcon('index.ts', 'light', { character: char(0xE099), color: '#498ba7' });
    expectIcon('App.tsx', 'light', { character: char(0xE07D), color: '#498ba7' });
    expectIcon('README.md', 'light', { character: char(0xE04D), color: '#498ba7' });
    expectIcon('notes.md', 'light', { character: char(0xE060), color: '#498ba7' });
    expectIcon('tsconfig.json', 'light', { character: char(0xE097), color: '#498ba7' });
    expectIcon('package.json', 'light', { character: char(0xE055), color: '#b7b73b' });
    expectIcon('yarn.lock', 'light', { character: char(0xE0A6), color: '#498ba7' });
    expectIcon('Dockerfile', 'light', { character: char(0xE025), color: '#498ba7' });
    expectIcon('.gitignore', 'light', { character: char(0xE034), color: '#3b4b52' });
    expectIcon('foo.unknownext', 'light', { character: char(0xE023), color: '#bfc2c1' });
    expectIcon('README.MD', 'light', { character: char(0xE04D), color: '#498ba7' });
});

test('prefers exact file names and the longest extension match', () => {
    const syntheticTheme: SetiTheme = {
        iconDefinitions: {
            _file: { fontCharacter: '\\E001', fontColor: '#111111' },
            _extension: { fontCharacter: '\\E002', fontColor: '#222222' },
            _language: { fontCharacter: '\\E003', fontColor: '#333333' },
            _fallback: { fontCharacter: '\\E004', fontColor: '#444444' },
        },
        file: '_fallback',
        fileNames: { 'special.ts': '_file' },
        fileExtensions: { '.ts': '_extension' },
        languageIds: { typescript: '_language' },
    };
    const syntheticLanguages: LanguageMap = {
        extensions: { '.d.ts': 'typescript', '.ts': 'typescript' },
        filenames: {},
    };

    assert.deepEqual(
        resolveSetiIcon('SPECIAL.TS', 'dark', syntheticTheme, syntheticLanguages),
        { character: char(0xE001), color: '#111111' }
    );
    assert.deepEqual(
        resolveSetiIcon('a.d.ts', 'dark', syntheticTheme, syntheticLanguages),
        { character: char(0xE002), color: '#222222' }
    );
    assert.deepEqual(
        resolveSetiIcon('a.unknown', 'dark', syntheticTheme, syntheticLanguages),
        { character: char(0xE004), color: '#444444' }
    );

    const languageOnlyTheme: SetiTheme = {
        iconDefinitions: syntheticTheme.iconDefinitions,
        file: '_fallback',
        fileNames: {},
        fileExtensions: {},
        languageIds: { typescript: '_language', javascript: '_fallback' },
    };
    const languageOnlyLanguages: LanguageMap = {
        extensions: { '.d.ts': 'typescript', '.ts': 'javascript' },
        filenames: {},
    };

    assert.deepEqual(
        resolveSetiIcon('a.d.ts', 'dark', languageOnlyTheme, languageOnlyLanguages),
        { character: char(0xE003), color: '#333333' }
    );
    assert.deepEqual(
        resolveSetiIcon('a.ts', 'dark', languageOnlyTheme, languageOnlyLanguages),
        { character: char(0xE004), color: '#444444' }
    );
});

test('generated language map covers common languages', () => {
    for (const extension of ['.ts', '.tsx', '.js', '.md', '.json', '.css', '.py', '.go', '.rs']) {
        assert.equal(typeof languages.extensions[extension], 'string', extension);
    }
    assert.equal(languages.extensions['.ts'], 'typescript');
    assert.equal(languages.extensions['.tsx'], 'typescriptreact');
    assert.equal(languages.extensions['.gitignore'], 'ignore');
    assert.equal(languages.filenames.dockerfile, 'dockerfile');
    assert.equal(languages.source, 'microsoft/vscode@8a14f0cc1b08d531eb83255ea3764ae22aa932b5');
});
