import { beforeAll, describe, expect, it } from "vitest";
import manifestJson from "../manifest.json";

interface NodeFsModule {
    readdirSync: (path: string) => string[];
    readFileSync: (path: string, encoding: "utf-8") => string;
    statSync: (path: string) => { isDirectory: () => boolean };
}

interface SourceFileEntry {
    content: string;
    relativePath: string;
}

const ADD_COMMAND_BLOCK_REGEX: RegExp = /\.addCommand\(\s*\{([\s\S]*?)\}\s*\)/g;
const ADD_COMMAND_ID_REGEX: RegExp = /\bid:\s*["']([^"']+)["']/;
const ADD_COMMAND_NAME_REGEX: RegExp =
    /\.addCommand\(\s*\{[\s\S]*?\bname:\s*["']([^"']+)["']/g;
const ADD_OPTION_LABEL_REGEX: RegExp =
    /\.addOption\(\s*["'][^"']+["']\s*,\s*["']([^"']+)["']\s*\)/g;
const ADD_RIBBON_ICON_REGEX: RegExp =
    /\.addRibbonIcon\(\s*["'][^"']+["']\s*,\s*["']([^"']+)["']/g;
const ALLOWED_CAPITALIZED_WORDS: ReadonlySet<string> = new Set<string>([
    "HTTP",
    "MB",
    "Nextcloud",
    "URL",
    "VaultDAV",
    "WebDAV"
]);
const ASCII_PRINTABLE_REGEX: RegExp = /^[\x20-\x7e]+$/;
const BARE_TIMER_CALL_REGEX: RegExp =
    /(?:^|[^.\w])(?:setTimeout|clearTimeout|setInterval|clearInterval)\s*\(/;
const CONTROL_CHAR_REGEX_LITERAL: RegExp = /\/[^\n/]*\\x00[^\n/]*\//;
const DIRECT_CALL_SET_HEADING_REGEX: RegExp =
    /(?:(?:^|[;={(\n])\s*|\breturn\s+)[A-Za-z_$][A-Za-z0-9_$]*\([^)]*\)\s*\.\s*setHeading\s*\(/;
const EXPLICIT_ANY_REGEX: RegExp = /(:\s*any\b|\bas\s+any\b|<any>)/;
const FORBIDDEN_CONSOLE_REGEX: RegExp = /\bconsole\.(log|info)\s*\(/;
const FORBIDDEN_DOM_HTML_REGEX: RegExp = /\.(innerHTML|outerHTML|insertAdjacentHTML)\b/;
const FORBIDDEN_GLOBAL_NETWORK_REGEX: RegExp = /\b(fetch\s*\(|XMLHttpRequest\b)/;
const FORBIDDEN_INLINE_STYLE_REGEX: RegExp =
    /(\.style\.[a-zA-Z_$][a-zA-Z0-9_$]*\s*=|\.setAttribute\(\s*["']style["']|\.setAttr\(\s*["']style["'])/;
const FORBIDDEN_NODE_IMPORT_REGEX: RegExp =
    /from\s+["'](node:|fs\b|path\b|http\b|https\b|crypto\b)/;
const FORBIDDEN_PLATFORM_REGEX: RegExp = /\bnavigator\.(platform|userAgent)\b/;
const HARDCODED_CONFIG_DIR_REGEX: RegExp = /\.obsidian\b/i;
const HOTKEYS_PROP_REGEX: RegExp = /\bhotkeys\s*:/;
const LOG_NOTIFY_REGEX: RegExp = /\blog\.notify\(\s*["']([^"']+)["']/g;
const LOOKBEHIND_REGEX: RegExp = /\(\?<[=!]/;
const MANUAL_HEADING_REGEX: RegExp = /\.createEl\(\s*["']h[1-6]["']/;
const NON_ALPHA_STRIP_REGEX: RegExp = /^[^A-Za-z]+|[^A-Za-z]+$/g;
const ONUNLOAD_BLOCK_REGEX: RegExp = /onunload\s*\([^)]*\)[^{]*\{([\s\S]*?)\n {4}\}/;
const PLACEHOLDER_SKIP_REGEX: RegExp = /^(https?:\/\/|\d+$|x+-x+)/i;
const PROBLEMATIC_HEADING_REGEX: RegExp = /\b(vaultdav|settings?|general|options?)\b/i;
const SET_BUTTON_TEXT_REGEX: RegExp = /\.setButtonText\(\s*["']([^"']+)["']\s*\)/g;
const SET_DESC_REGEX: RegExp = /\.setDesc\(\s*["']([^"']+)["']\s*\)/g;
const SET_HEADING_REGEX: RegExp = /\.setHeading\(\s*["']([^"']+)["']\s*\)/g;
const SET_NAME_REGEX: RegExp = /\.setName\(\s*["']([^"']+)["']\s*\)/g;
const SET_PLACEHOLDER_REGEX: RegExp = /\.setPlaceholder\(\s*["']([^"']+)["']\s*\)/g;
const TS_IGNORE_REGEX: RegExp = /@ts-ignore\b/;
const WHILE_TRUE_REGEX: RegExp = /\bwhile\s*\(\s*true\s*\)/;
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
        const fs: NodeFsModule = (await import(fsModuleName)) as NodeFsModule;
        sourceFiles = collectSourceFiles(fs, "src");
    });

    it("loads all TypeScript source files from src/", () => {
        expect(sourceFiles.length).toBeGreaterThanOrEqual(8);
    });

    it("validates manifest.json against Obsidian Community Directory rules (validate-manifest)", () => {
        const manifestRecord: Record<string, unknown> = manifestJson;
        expect(typeof manifestRecord.id).toBe("string");
        expect(typeof manifestRecord.name).toBe("string");
        expect(typeof manifestRecord.version).toBe("string");
        expect(typeof manifestRecord.minAppVersion).toBe("string");
        expect(typeof manifestRecord.description).toBe("string");
        expect(typeof manifestRecord.author).toBe("string");
        expect(manifestRecord.isDesktopOnly).toBe(false);
        expect("fundingUrl" in manifestRecord).toBe(false);

        const id: string = String(manifestRecord.id);
        const name: string = String(manifestRecord.name);
        const author: string = String(manifestRecord.author);
        const description: string = String(manifestRecord.description);

        expect(id).not.toMatch(/obsidian|plugin/i);
        expect(name).not.toMatch(/obsidian|plugin/i);
        expect(author.trim().length).toBeGreaterThan(0);

        expect(description.length).toBeGreaterThan(0);
        expect(description.length).toBeLessThanOrEqual(250);
        expect(description.endsWith(".")).toBe(true);
        expect(description[0]).toBe(description[0]?.toUpperCase());
        expect(description).not.toMatch(/^this (is a )?plugin/i);
        expect(description).not.toMatch(/\b(obsidian|plugin)\b/i);
        expect(ASCII_PRINTABLE_REGEX.test(description)).toBe(true);

        if (typeof manifestRecord.authorUrl === "string") {
            const parsedUrl: URL = new URL(manifestRecord.authorUrl);
            expect(parsedUrl.protocol).toBe("https:");
            expect(parsedUrl.hostname).not.toMatch(/(^|\.)obsidian\.md$/i);
        }
    });

    it("prohibits innerHTML, outerHTML, insertAdjacentHTML, and inline style assignments (no-inner-html, no-static-styles-assignment)", () => {
        for (const file of sourceFiles) {
            expect(
                FORBIDDEN_DOM_HTML_REGEX.test(file.content),
                `${file.relativePath} must not use innerHTML, outerHTML, or insertAdjacentHTML`
            ).toBe(false);
            expect(
                FORBIDDEN_INLINE_STYLE_REGEX.test(file.content),
                `${file.relativePath} must not assign inline styles (use CSS classes in styles.css)`
            ).toBe(false);
        }
    });

    it("prohibits manual HTML heading elements and problematic settings headings (settings-tab/*)", () => {
        expect(
            DIRECT_CALL_SET_HEADING_REGEX.test(
                '        createSettingGroup(containerEl)\n            .setHeading("Advanced sync")'
            )
        ).toBe(true);
        expect(
            DIRECT_CALL_SET_HEADING_REGEX.test(
                '        new Setting(containerEl).setName(text).setHeading();'
            )
        ).toBe(false);
        expect(
            DIRECT_CALL_SET_HEADING_REGEX.test(
                '        advancedGroup\n            .setHeading("Advanced sync")'
            )
        ).toBe(false);
        for (const file of sourceFiles) {
            expect(
                MANUAL_HEADING_REGEX.test(file.content),
                `${file.relativePath} must not create manual h1-h6 elements`
            ).toBe(false);
            expect(
                DIRECT_CALL_SET_HEADING_REGEX.test(file.content),
                `${file.relativePath} must not chain .setHeading() directly on a function call`
            ).toBe(false);
            SET_HEADING_REGEX.lastIndex = 0;
            let match: RegExpExecArray | null = SET_HEADING_REGEX.exec(file.content);
            while (match !== null) {
                const heading: string = match[1] ?? "";
                expect(
                    PROBLEMATIC_HEADING_REGEX.test(heading),
                    `${file.relativePath} contains problematic settings heading: "${heading}"`
                ).toBe(false);
                match = SET_HEADING_REGEX.exec(file.content);
            }
        }
    });

    it("enforces window-prefixed timers in src/ (prefer-window-timers)", () => {
        expect(BARE_TIMER_CALL_REGEX.test("setTimeout(resolve, 10);")).toBe(true);
        expect(BARE_TIMER_CALL_REGEX.test("clearTimeout(timerId);")).toBe(true);
        expect(BARE_TIMER_CALL_REGEX.test("window.setTimeout(resolve, 10);")).toBe(false);
        expect(BARE_TIMER_CALL_REGEX.test("window.clearTimeout(timerId);")).toBe(false);
        for (const file of sourceFiles) {
            expect(
                BARE_TIMER_CALL_REGEX.test(file.content),
                `${file.relativePath} must use window.setTimeout/clearTimeout/setInterval/clearInterval`
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

    it("prohibits Node.js builtin imports, global fetch/XMLHttpRequest, and navigator platform sniffing", () => {
        for (const file of sourceFiles) {
            expect(
                FORBIDDEN_NODE_IMPORT_REGEX.test(file.content),
                `${file.relativePath} must not import Node.js builtins`
            ).toBe(false);
            expect(
                FORBIDDEN_GLOBAL_NETWORK_REGEX.test(file.content),
                `${file.relativePath} must not use fetch or XMLHttpRequest`
            ).toBe(false);
            expect(
                FORBIDDEN_PLATFORM_REGEX.test(file.content),
                `${file.relativePath} must not use navigator.platform or navigator.userAgent`
            ).toBe(false);
        }
    });

    it("prohibits hardcoded .obsidian paths, control-char regexes, console.log/info, while(true), and regex lookbehinds", () => {
        for (const file of sourceFiles) {
            expect(
                HARDCODED_CONFIG_DIR_REGEX.test(file.content),
                `${file.relativePath} must not hardcode .obsidian paths (use Vault#configDir)`
            ).toBe(false);
            expect(
                CONTROL_CHAR_REGEX_LITERAL.test(file.content),
                `${file.relativePath} must not use control-char regex literals (no-control-regex)`
            ).toBe(false);
            expect(
                FORBIDDEN_CONSOLE_REGEX.test(file.content),
                `${file.relativePath} must not call console.log or console.info (no-console)`
            ).toBe(false);
            expect(
                WHILE_TRUE_REGEX.test(file.content),
                `${file.relativePath} must not use while (true) (no-constant-condition)`
            ).toBe(false);
            expect(
                LOOKBEHIND_REGEX.test(file.content),
                `${file.relativePath} must not use regex lookbehind (regex-lookbehind)`
            ).toBe(false);
        }
    });

    it("guards SettingGroup, SecretComponent, and SecretStorage usage behind requireApiVersion and stores secrets outside data.json", () => {
        const settingsFile: SourceFileEntry | undefined = sourceFiles.find(
            (file: SourceFileEntry): boolean => file.relativePath === "src/settings.ts"
        );
        const mainFile: SourceFileEntry | undefined = sourceFiles.find(
            (file: SourceFileEntry): boolean => file.relativePath === "src/main.ts"
        );
        const typesFile: SourceFileEntry | undefined = sourceFiles.find(
            (file: SourceFileEntry): boolean => file.relativePath === "src/types.ts"
        );
        expect(settingsFile).toBeDefined();
        expect(mainFile).toBeDefined();
        expect(typesFile).toBeDefined();
        const settingsContent: string = settingsFile?.content ?? "";
        const mainContent: string = mainFile?.content ?? "";
        const typesContent: string = typesFile?.content ?? "";

        expect(manifestJson.minAppVersion).toBe("1.11.4");
        expect(settingsContent).toContain('requireApiVersion("1.11.0")');
        expect(settingsContent).toContain('requireApiVersion("1.11.4")');
        expect(settingsContent).toContain('requireApiVersion("1.13.2")');
        expect(settingsContent).toContain("public display(): void");
        expect(settingsContent).toContain(
            "public getSettingDefinitions(): SettingDefinitionItem[]"
        );
        expect(settingsContent).not.toContain("super.getSettingDefinitions");
        expect(settingsContent).not.toContain("this.display()");
        expect(settingsContent).toContain("new SecretComponent(this.app");
        expect(settingsContent).not.toMatch(/inputEl\.type\s*=\s*["']password["']/);
        expect(settingsContent).not.toMatch(/=\s*SettingGroup\b/);
        expect(settingsContent).not.toMatch(/typeof\s+SettingGroup\s*\|/);
        expect(mainContent).toContain('requireApiVersion("1.11.4")');
        expect(mainContent).toContain("secretStorage");

        const settingsInterfaceMatch: RegExpExecArray | null =
            /export interface VaultDavSettings\s*\{([\s\S]*?)\}/.exec(typesContent);
        expect(settingsInterfaceMatch).not.toBeNull();
        const settingsInterfaceBody: string = settingsInterfaceMatch?.[1] ?? "";
        expect(settingsInterfaceBody).toContain("appPasswordSecret: string;");
        expect(settingsInterfaceBody).not.toMatch(/\bappPassword\s*:/);
    });

    it("enforces command ID, command name, and no-default-hotkeys rules (commands/*)", () => {
        for (const file of sourceFiles) {
            ADD_COMMAND_BLOCK_REGEX.lastIndex = 0;
            let match: RegExpExecArray | null = ADD_COMMAND_BLOCK_REGEX.exec(file.content);
            while (match !== null) {
                const block: string = match[1] ?? "";
                const idMatch: RegExpExecArray | null = ADD_COMMAND_ID_REGEX.exec(block);
                const commandId: string = idMatch?.[1] ?? "";
                expect(
                    commandId.toLowerCase().includes("vaultdav"),
                    `${file.relativePath} command id "${commandId}" must not contain plugin id`
                ).toBe(false);
                expect(
                    HOTKEYS_PROP_REGEX.test(block),
                    `${file.relativePath} command "${commandId}" must not define default hotkeys`
                ).toBe(false);
                match = ADD_COMMAND_BLOCK_REGEX.exec(file.content);
            }
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
        expect(isSentenceCase("Nextcloud app password for HTTP basic authentication.")).toBe(
            true
        );
        expect(isSentenceCase("Configure server URL, username, and app password first.")).toBe(
            true
        );
        expect(isSentenceCase("App Password")).toBe(false);
        expect(isSentenceCase("Remote Base Directory")).toBe(false);
        expect(isSentenceCase("Sync Interval")).toBe(false);
        expect(isSentenceCase("Conflict Strategy")).toBe(false);
        expect(isSentenceCase("Test Connection")).toBe(false);
        expect(isSentenceCase("VaultDAV: Synchronize now")).toBe(false);
        expect(isSentenceCase("Nextcloud app password for HTTP Basic authentication.")).toBe(
            false
        );
        expect(isSentenceCase("Configure Server URL, Username, and App Password first.")).toBe(
            false
        );

        const uiLiteralRegexes: ReadonlyArray<RegExp> = [
            ADD_COMMAND_NAME_REGEX,
            ADD_OPTION_LABEL_REGEX,
            ADD_RIBBON_ICON_REGEX,
            LOG_NOTIFY_REGEX,
            SET_BUTTON_TEXT_REGEX,
            SET_DESC_REGEX,
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
            SET_PLACEHOLDER_REGEX.lastIndex = 0;
            let placeholderMatch: RegExpExecArray | null = SET_PLACEHOLDER_REGEX.exec(
                file.content
            );
            while (placeholderMatch !== null) {
                const placeholder: string = placeholderMatch[1] ?? "";
                if (!PLACEHOLDER_SKIP_REGEX.test(placeholder)) {
                    extractedLiterals.push(placeholder);
                    expect(
                        isSentenceCase(placeholder),
                        `${file.relativePath} contains non-Sentence-case placeholder: "${placeholder}"`
                    ).toBe(true);
                }
                placeholderMatch = SET_PLACEHOLDER_REGEX.exec(file.content);
            }
        }
        expect(extractedLiterals).toContain("Synchronize with Nextcloud");
        expect(extractedLiterals).toContain("Synchronize now");
        expect(extractedLiterals).toContain("Open sync log");
        expect(extractedLiterals).toContain("Sync log retention");
        expect(extractedLiterals).toContain(
            "Days to retain local sync history (1 to 365)."
        );
        expect(extractedLiterals).toContain("Test Nextcloud WebDAV connection");
        expect(extractedLiterals).toContain(
            "Configure server URL, username, and app password first."
        );
        expect(extractedLiterals).toContain(
            "Select or create a secret for your Nextcloud app password."
        );
        expect(extractedLiterals).toContain(
            "Obsidian 1.11.4 or newer is required for secure password storage."
        );
        expect(extractedLiterals).toContain(
            "App password secret was not found in secret storage."
        );
        expect(extractedLiterals).toContain("Enter username");
        expect(extractedLiterals.length).toBeGreaterThanOrEqual(30);
    });
});
