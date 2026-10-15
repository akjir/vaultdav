import { beforeAll, describe, expect, it } from "vitest";

interface NodeFsModule {
    readdirSync: (path: string) => string[];
    readFileSync: (path: string, encoding: "utf-8") => string;
    statSync: (path: string) => { isDirectory: () => boolean };
}

interface SourceFileEntry {
    content: string;
    relativePath: string;
}

const ADD_COMMAND_NAME_REGEX: RegExp =
    /\.addCommand\(\s*\{[\s\S]*?\bname:\s*["']([^"']+)["']/g;
const ADD_RIBBON_ICON_REGEX: RegExp =
    /\.addRibbonIcon\(\s*["'][^"']+["']\s*,\s*["']([^"']+)["']/g;
const ALLOWED_CAPITALIZED_WORDS: ReadonlySet<string> = new Set<string>([
    "Basic",
    "HTTP",
    "Nextcloud",
    "URL",
    "VaultDAV",
    "WebDAV"
]);
const EXPLICIT_ANY_REGEX: RegExp = /(:\s*any\b|\bas\s+any\b|<any>)/;
const FORBIDDEN_DOM_HTML_REGEX: RegExp = /\.(innerHTML|outerHTML|insertAdjacentHTML)\b/;
const FORBIDDEN_GLOBAL_NETWORK_REGEX: RegExp = /\b(fetch\s*\(|XMLHttpRequest\b)/;
const FORBIDDEN_NODE_IMPORT_REGEX: RegExp =
    /from\s+["'](node:|fs\b|path\b|http\b|https\b|crypto\b)/;
const LOG_NOTIFY_REGEX: RegExp = /\blog\.notify\(\s*["']([^"']+)["']/g;
const MANUAL_HEADING_REGEX: RegExp = /\.createEl\(\s*["']h[1-6]["']/;
const NON_ALPHA_STRIP_REGEX: RegExp = /^[^A-Za-z]+|[^A-Za-z]+$/g;
const ONUNLOAD_BLOCK_REGEX: RegExp = /onunload\s*\([^)]*\)[^{]*\{([\s\S]*?)\n    \}/;
const SET_BUTTON_TEXT_REGEX: RegExp = /\.setButtonText\(\s*["']([^"']+)["']\s*\)/g;
const SET_HEADING_REGEX: RegExp = /\.setHeading\(\s*["']([^"']+)["']\s*\)/g;
const SET_NAME_REGEX: RegExp = /\.setName\(\s*["']([^"']+)["']\s*\)/g;
const TS_IGNORE_REGEX: RegExp = /@ts-ignore\b/;
const WHITESPACE_SPLIT_REGEX: RegExp = /\s+/;

function collectSourceFiles(
    fs: NodeFsModule,
    dirPath: string,
    prefix: string = ""
): SourceFileEntry[] {
    const entries: string[] = fs.readdirSync(dirPath).sort();
    const collected: SourceFileEntry[] = [];

    for (const entry of entries) {
        const fullPath: string = `${dirPath}/${entry}`;
        const relPath: string = prefix === "" ? entry : `${prefix}/${entry}`;
        if (fs.statSync(fullPath).isDirectory()) {
            collected.push(...collectSourceFiles(fs, fullPath, relPath));
        } else if (entry.endsWith(".ts")) {
            collected.push({
                content: fs.readFileSync(fullPath, "utf-8"),
                relativePath: `src/${relPath}`
            });
        }
    }
    return collected;
}

function isSentenceCase(label: string): boolean {
    const trimmed: string = label.trim();
    if (trimmed === "") {
        return false;
    }
    const words: string[] = trimmed.split(WHITESPACE_SPLIT_REGEX);
    const firstWord: string = (words[0] ?? "").replace(NON_ALPHA_STRIP_REGEX, "");
    const firstChar: string = firstWord[0] ?? "";
    if (firstChar === "" || firstChar !== firstChar.toUpperCase()) {
        return false;
    }

    for (let i: number = 1; i < words.length; i += 1) {
        const rawWord: string = words[i] ?? "";
        const cleaned: string = rawWord.replace(NON_ALPHA_STRIP_REGEX, "");
        if (cleaned === "") {
            continue;
        }
        if (ALLOWED_CAPITALIZED_WORDS.has(cleaned)) {
            continue;
        }
        const initial: string = cleaned[0] ?? "";
        if (initial !== initial.toLowerCase()) {
            return false;
        }
    }
    return true;
}

describe("Obsidian Plugin Linter static guard (eslint-plugin-obsidianmd)", () => {
    let sourceFiles: SourceFileEntry[] = [];

    beforeAll(async () => {
        const fsModuleName: string = "node:fs";
        const fs: NodeFsModule = (await import(fsModuleName)) as unknown as NodeFsModule;
        sourceFiles = collectSourceFiles(fs, "src");
    });

    it("loads all TypeScript source files from src/", () => {
        expect(sourceFiles.length).toBeGreaterThanOrEqual(8);
    });

    it("prohibits innerHTML, outerHTML, and insertAdjacentHTML (no-inner-html)", () => {
        for (const file of sourceFiles) {
            expect(
                FORBIDDEN_DOM_HTML_REGEX.test(file.content),
                `${file.relativePath} must not use innerHTML, outerHTML, or insertAdjacentHTML`
            ).toBe(false);
        }
    });

    it("prohibits manual HTML heading elements via createEl('h1'..'h6') (settings-tab/no-manual-html-headings)", () => {
        for (const file of sourceFiles) {
            expect(
                MANUAL_HEADING_REGEX.test(file.content),
                `${file.relativePath} must not create manual h1-h6 elements`
            ).toBe(false);
        }
    });

    it("prohibits detachLeavesOfType inside onunload (detach-leaves)", () => {
        for (const file of sourceFiles) {
            const match: RegExpExecArray | null = ONUNLOAD_BLOCK_REGEX.exec(file.content);
            if (match !== null) {
                const body: string = match[1] ?? "";
                expect(
                    body.includes("detachLeavesOfType"),
                    `${file.relativePath} must not call detachLeavesOfType in onunload`
                ).toBe(false);
            }
        }
    });

    it("prohibits Node.js builtin imports and global fetch/XMLHttpRequest in src/", () => {
        for (const file of sourceFiles) {
            expect(
                FORBIDDEN_NODE_IMPORT_REGEX.test(file.content),
                `${file.relativePath} must not import Node.js builtins`
            ).toBe(false);
            expect(
                FORBIDDEN_GLOBAL_NETWORK_REGEX.test(file.content),
                `${file.relativePath} must not use fetch or XMLHttpRequest`
            ).toBe(false);
        }
    });

    it("prohibits explicit any types and @ts-ignore directives in src/", () => {
        for (const file of sourceFiles) {
            expect(
                EXPLICIT_ANY_REGEX.test(file.content),
                `${file.relativePath} must not use explicit any`
            ).toBe(false);
            expect(
                TS_IGNORE_REGEX.test(file.content),
                `${file.relativePath} must not use @ts-ignore`
            ).toBe(false);
        }
    });

    it("enforces strict Obsidian Sentence case on UI literals (ui/sentence-case)", () => {
        expect(isSentenceCase("Server URL")).toBe(true);
        expect(isSentenceCase("App password")).toBe(true);
        expect(isSentenceCase("Remote base directory")).toBe(true);
        expect(isSentenceCase("Test connection")).toBe(true);
        expect(isSentenceCase("Testing...")).toBe(true);
        expect(isSentenceCase("Synchronize with Nextcloud")).toBe(true);
        expect(isSentenceCase("Configure server URL, username, and app password first.")).toBe(
            true
        );
        expect(isSentenceCase("App Password")).toBe(false);
        expect(isSentenceCase("Remote Base Directory")).toBe(false);
        expect(isSentenceCase("Sync Interval")).toBe(false);
        expect(isSentenceCase("Conflict Strategy")).toBe(false);
        expect(isSentenceCase("Test Connection")).toBe(false);
        expect(isSentenceCase("VaultDAV: Synchronize now")).toBe(false);
        expect(isSentenceCase("Configure Server URL, Username, and App Password first.")).toBe(
            false
        );

        const uiLiteralRegexes: ReadonlyArray<RegExp> = [
            ADD_COMMAND_NAME_REGEX,
            ADD_RIBBON_ICON_REGEX,
            LOG_NOTIFY_REGEX,
            SET_BUTTON_TEXT_REGEX,
            SET_HEADING_REGEX,
            SET_NAME_REGEX
        ];
        const extractedLiterals: string[] = [];
        for (const file of sourceFiles) {
            for (const regex of uiLiteralRegexes) {
                regex.lastIndex = 0;
                let match: RegExpExecArray | null = regex.exec(file.content);
                while (match !== null) {
                    const literal: string = match[1] ?? "";
                    extractedLiterals.push(literal);
                    expect(
                        isSentenceCase(literal),
                        `${file.relativePath} contains non-Sentence-case UI literal: "${literal}"`
                    ).toBe(true);
                    match = regex.exec(file.content);
                }
            }
        }
        expect(extractedLiterals).toContain("Synchronize with Nextcloud");
        expect(extractedLiterals).toContain("Synchronize now");
        expect(extractedLiterals).toContain("Test Nextcloud WebDAV connection");
        expect(extractedLiterals).toContain(
            "Configure server URL, username, and app password first."
        );
        expect(extractedLiterals.length).toBeGreaterThanOrEqual(19);
    });
});
