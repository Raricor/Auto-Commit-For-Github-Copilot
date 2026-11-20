import setiThemeJson from '../../media/seti/vs-seti-icon-theme.json';
import languagesJson from '../../media/seti/languages.json';

export type ThemeKind = 'light' | 'dark';

export interface SetiIcon {
    character: string;
    color?: string;
}

interface SetiIconDefinition {
    fontCharacter: string;
    fontColor?: string;
}

interface SetiLightMappings {
    fileNames?: Record<string, string>;
    fileExtensions?: Record<string, string>;
    languageIds?: Record<string, string>;
    file?: string;
}

export interface SetiTheme {
    iconDefinitions: Record<string, SetiIconDefinition>;
    file?: string;
    fileNames: Record<string, string>;
    fileExtensions: Record<string, string>;
    languageIds: Record<string, string>;
    light?: SetiLightMappings;
}

export interface LanguageMap {
    source?: string;
    extensions: Record<string, string>;
    filenames: Record<string, string>;
}

const defaultTheme = setiThemeJson as unknown as SetiTheme;
const defaultLanguages = languagesJson as unknown as LanguageMap;

function isExtensionMatch(fileName: string, key: string): boolean {
    if (!fileName.endsWith(key)) {
        return false;
    }

    // Some Seti keys omit the leading dot ("s", "bsl"). Those must still start
    // after a dot; otherwise "index.ts" would match the assembly key "s".
    if (key.startsWith('.') || fileName.length === key.length) {
        return true;
    }
    return fileName.charAt(fileName.length - key.length - 1) === '.';
}

function longestExtensionMatch(
    fileName: string,
    primary: Record<string, string> | undefined,
    fallback: Record<string, string> | undefined,
): string | undefined {
    let match: string | undefined;
    const keys = new Set([
        ...Object.keys(fallback ?? {}),
        ...Object.keys(primary ?? {}),
    ]);

    for (const key of keys) {
        if (isExtensionMatch(fileName, key) && (match === undefined || key.length > match.length)) {
            match = key;
        }
    }

    return match;
}

/** Resolves a file name to the icon ID used by the Seti theme. */
function resolveIconId(
    fileName: string,
    kind: ThemeKind,
    theme: SetiTheme,
    languages: LanguageMap,
): string | undefined {
    const light = kind === 'light' ? theme.light : undefined;

    // VS Code checks exact file names first.
    const exact = light?.fileNames?.[fileName] ?? theme.fileNames?.[fileName];
    if (exact !== undefined) {
        return exact;
    }

    // Then it checks file extensions, preferring the longest compound extension.
    const setiExtension = longestExtensionMatch(fileName, light?.fileExtensions, theme.fileExtensions);
    if (setiExtension !== undefined) {
        const icon = light?.fileExtensions?.[setiExtension] ?? theme.fileExtensions[setiExtension];
        if (icon !== undefined) {
            return icon;
        }
    }

    // Finally it resolves the VS Code language ID and looks that up in Seti.
    let languageId = languages.filenames[fileName];
    if (languageId === undefined) {
        const languageExtension = longestExtensionMatch(fileName, languages.extensions, undefined);
        if (languageExtension !== undefined) {
            languageId = languages.extensions[languageExtension];
        }
    }
    // A language without a Seti icon still falls back to the theme-aware default.
    const languageIcon = languageId === undefined
        ? undefined
        : light?.languageIds?.[languageId] ?? theme.languageIds[languageId];
    if (languageIcon !== undefined) {
        return languageIcon;
    }

    return light?.file ?? theme.file;
}

function decodeFontCharacter(value: string): string {
    const hex = value.replace(/^\\/, '');
    const codePoint = Number.parseInt(hex, 16);
    return Number.isNaN(codePoint) ? '' : String.fromCharCode(codePoint);
}

export function resolveSetiIcon(
    fileName: string,
    kind: ThemeKind,
    theme: SetiTheme = defaultTheme,
    languages: LanguageMap = defaultLanguages,
): SetiIcon {
    const lowerName = fileName.toLowerCase();
    const iconId = resolveIconId(lowerName, kind, theme, languages) ?? '_default';
    const definition = theme.iconDefinitions[iconId] ?? theme.iconDefinitions['_default'];
    if (definition === undefined) {
        return { character: '' };
    }

    return {
        character: decodeFontCharacter(definition.fontCharacter),
        color: definition.fontColor,
    };
}
