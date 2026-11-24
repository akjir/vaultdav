import { describe, expect, it, vi } from "vitest";
import { log } from "../src/log";
import {
    MAX_FILE_SIZE_BYTES,
    MAX_WALK_DEPTH,
    PLUGIN_DATA_RELATIVE_PATH,
    SYNC_STATE_RELATIVE_PATH,
    util
} from "../src/utilities";

describe("utilities and logging", () => {
    it("exports top-level file path helpers and size constants", () => {
        expect(MAX_FILE_SIZE_BYTES).toBe(50 * 1024 * 1024);
        expect(MAX_WALK_DEPTH).toBe(64);
        expect(PLUGIN_DATA_RELATIVE_PATH).toBe("plugins/vaultdav/data.json");
        expect(SYNC_STATE_RELATIVE_PATH).toBe("plugins/vaultdav/sync-state.json");
        expect(util.MAX_FILE_SIZE_BYTES).toBe(MAX_FILE_SIZE_BYTES);
        expect(util.MAX_WALK_DEPTH).toBe(MAX_WALK_DEPTH);
        expect(util.getPluginDataFilePath(".obsidian")).toBe(
            ".obsidian/plugins/vaultdav/data.json"
        );
        expect(util.getSyncStateFilePath(".obsidian")).toBe(
            ".obsidian/plugins/vaultdav/sync-state.json"
        );
        expect(util.getSyncStateFilePath("custom-config")).toBe(
            "custom-config/plugins/vaultdav/sync-state.json"
        );
        expect(() => util.getSyncStateFilePath("")).toThrow(/configDir/i);
        expect(() => util.getPluginDataFilePath("../escape")).toThrow(/configDir/i);
        expect(util.hasControlChars("normal text")).toBe(false);
        expect(util.hasControlChars("bad\x00text")).toBe(true);
        expect(util.hasControlChars("bad\ntext")).toBe(true);
        expect(util.hasControlChars("bad\x7ftext")).toBe(true);
    });

    it("encodes ASCII and UTF-8 credentials for HTTP Basic Auth", () => {
        expect(util.encodeBasicAuth("alice", "secret123")).toBe("Basic YWxpY2U6c2VjcmV0MTIz");
        expect(util.encodeBasicAuth("müller", "pässwörd-你好")).toBe(
            "Basic bcO8bGxlcjpww6Rzc3fDtnJkLeS9oOWlvQ=="
        );
    });

    it("normalizes vault paths and rejects traversal, control characters, drive prefixes, and prototype keys", () => {
        expect(util.normalizeVaultPath("/notes//daily/2026-10-14.md/")).toBe(
            "notes/daily/2026-10-14.md"
        );
        expect(util.normalizeVaultPath("/")).toBe("");
        expect(util.normalizeVaultPath("")).toBe("");
        expect(util.normalizeVaultPath(".")).toBe("");
        expect(util.normalizeVaultPath("..")).toBe("");
        expect(util.normalizeVaultPath("../secret.md")).toBe("");
        expect(util.normalizeVaultPath("a/../../b")).toBe("");
        expect(util.normalizeVaultPath("a/../b")).toBe("");
        expect(util.normalizeVaultPath("..\\secret.md")).toBe("");
        expect(util.normalizeVaultPath("note\0.md")).toBe("");
        expect(util.normalizeVaultPath("note\n.md")).toBe("");
        expect(util.normalizeVaultPath("C:/Windows/System32")).toBe("");
        expect(util.normalizeVaultPath("__proto__")).toBe("");
        expect(util.normalizeVaultPath("Notes/__proto__/file.md")).toBe("");
        expect(util.normalizeVaultPath("constructor")).toBe("");
        expect(util.normalizeVaultPath("prototype")).toBe("");

        expect(util.encodeWebDavPath("Notes/C# Programming & Q?.md")).toBe(
            "Notes/C%23%20Programming%20%26%20Q%3F.md"
        );
        expect(util.encodeWebDavPath("..")).toBe("");
        expect(util.encodeWebDavPath("../OtherFolder")).toBe("");
    });

    it("builds Nextcloud WebDAV base URLs and rejects non-HTTPS, embedded credentials, and empty usernames", () => {
        expect(
            util.buildNextcloudWebDavBaseUrl(
                "https://cloud.example.com/",
                "alice",
                "/Obsidian Vault/"
            )
        ).toBe("https://cloud.example.com/remote.php/dav/files/alice/Obsidian%20Vault");

        expect(
            util.buildNextcloudWebDavBaseUrl(
                "https://cloud.example.com/nextcloud/remote.php/dav/files/alice/",
                "alice",
                "Notes"
            )
        ).toBe("https://cloud.example.com/nextcloud/remote.php/dav/files/alice/Notes");

        expect(
            util.buildNextcloudWebDavBaseUrl(
                "https://cloud.example.com/remote.php/dav/files",
                "alice",
                "Notes"
            )
        ).toBe("https://cloud.example.com/remote.php/dav/files/alice/Notes");

        expect(
            util.buildNextcloudWebDavBaseUrl(
                "https://cloud.example.com/remote.php/dav/files/",
                "alice",
                "Notes"
            )
        ).toBe("https://cloud.example.com/remote.php/dav/files/alice/Notes");

        expect(
            util.buildNextcloudWebDavBaseUrl(
                "https://cloud.example.com/remote.php/dav/files/m%C3%BCller/IgnoredBase",
                "müller",
                "Notes"
            )
        ).toBe("https://cloud.example.com/remote.php/dav/files/m%C3%BCller/Notes");

        expect(
            util.buildNextcloudWebDavBaseUrl(
                "https://cloud.example.com/remote.php/dav",
                "alice",
                "Notes"
            )
        ).toBe("https://cloud.example.com/remote.php/dav/files/alice/Notes");

        expect(
            util.buildNextcloudWebDavBaseUrl(
                "https://cloud.example.com/nextcloud/remote.php/dav/",
                "alice",
                "Notes"
            )
        ).toBe("https://cloud.example.com/nextcloud/remote.php/dav/files/alice/Notes");

        expect(
            util.buildNextcloudWebDavBaseUrl(
                "https://cloud.example.com/remote.php/webdav/",
                "alice",
                "Notes"
            )
        ).toBe("https://cloud.example.com/remote.php/dav/files/alice/Notes");

        expect(
            util.buildNextcloudWebDavBaseUrl(
                "https://cloud.example.com/nextcloud/remote.php/webdav/OldDir",
                "alice",
                "Notes"
            )
        ).toBe("https://cloud.example.com/nextcloud/remote.php/dav/files/alice/Notes");

        expect(() =>
            util.buildNextcloudWebDavBaseUrl(
                "http://cloud.example.com",
                "alice",
                "Notes"
            )
        ).toThrow(/HTTPS/i);

        expect(() =>
            util.buildNextcloudWebDavBaseUrl(
                "https://alice:secret@cloud.example.com",
                "alice",
                "Notes"
            )
        ).toThrow(/credentials/i);

        expect(() =>
            util.buildNextcloudWebDavBaseUrl(
                "https://cloud.example.com",
                "   ",
                "Notes"
            )
        ).toThrow(/username/i);

        expect(() =>
            util.buildNextcloudWebDavBaseUrl(
                "not-a-valid-url",
                "alice",
                "Notes"
            )
        ).toThrow(/Invalid/i);
    });

    it("decodes WebDAV href values and enforces username boundaries, traversal, null-byte, and URIError safety", () => {
        expect(
            util.decodeWebDavHref(
                "/remote.php/dav/files/alice/Obsidian%20Vault/",
                "alice",
                "Obsidian Vault"
            )
        ).toBe("");

        expect(
            util.decodeWebDavHref(
                "/nextcloud/remote.php/dav/files/alice/Obsidian%20Vault/Folder/C%23%20Note%3F.md",
                "alice",
                "Obsidian Vault"
            )
        ).toBe("Folder/C# Note?.md");

        expect(
            util.decodeWebDavHref(
                "HTTPS://cloud.example.com/remote.php/dav/files/Alice/Obsidian%20Vault/Note.md",
                "alice",
                "Obsidian Vault"
            )
        ).toBe("Note.md");

        expect(
            util.decodeWebDavHref(
                "https://cloud.example.com/remote.php/dav/files/alice/OtherFolder/file.md",
                "alice",
                "Obsidian Vault"
            )
        ).toBeNull();

        expect(
            util.decodeWebDavHref(
                "/remote.php/dav/files/maximilian/Obsidian%20Vault/Note.md",
                "max",
                "Obsidian Vault"
            )
        ).toBeNull();

        expect(
            util.decodeWebDavHref(
                "/remote.php/dav/files/alice/Obsidian%20Vault/../secret.md",
                "alice",
                "Obsidian Vault"
            )
        ).toBeNull();

        expect(
            util.decodeWebDavHref(
                "/remote.php/dav/files/alice/Obsidian%20Vault/%2e%2e/secret.md",
                "alice",
                "Obsidian Vault"
            )
        ).toBeNull();

        expect(
            util.decodeWebDavHref(
                "https://cloud.example.com/remote.php/dav/files/alice/Obsidian%20Vault/Notes/../secret.md",
                "alice",
                "Obsidian Vault"
            )
        ).toBeNull();

        expect(
            util.decodeWebDavHref(
                "HTTPS://cloud.example.com/remote.php/dav/files/alice/Obsidian%20Vault/Notes/../secret.md",
                "alice",
                "Obsidian Vault"
            )
        ).toBeNull();

        expect(
            util.decodeWebDavHref(
                "/remote.php/dav/files/alice/Obsidian%20Vault/note%00.md",
                "alice",
                "Obsidian Vault"
            )
        ).toBeNull();

        expect(
            util.decodeWebDavHref(
                "/remote.php/dav/files/alice/Obsidian%20Vault/%E0%A4%A",
                "alice",
                "Obsidian Vault"
            )
        ).toBeNull();
    });

    it("computes folder levels, parent paths, and path depth", () => {
        expect(util.getFolderLevels("a/b/c.md", false)).toEqual(["a", "a/b"]);
        expect(util.getFolderLevels("a/b/c", true)).toEqual(["a", "a/b", "a/b/c"]);
        expect(util.getFolderLevels("root.md", false)).toEqual([]);

        expect(util.getParentPath("a/b/c.md")).toBe("a/b");
        expect(util.getParentPath("root.md")).toBe("");
        expect(util.getParentPath("")).toBe("");

        expect(util.getPathDepth("root.md")).toBe(1);
        expect(util.getPathDepth("a/b/c.md")).toBe(3);
    });

    it("normalizes ETags and timestamps to second precision", () => {
        expect(util.normalizeEtag('"652a1b3c4d"')).toBe("652a1b3c4d");
        expect(util.normalizeEtag('W/"weak-etag-1"')).toBe("weak-etag-1");
        expect(util.normalizeEtag(undefined)).toBe("");

        expect(util.toSecondPrecision(1728928291987)).toBe(1728928291000);
        expect(util.toSecondPrecision(Number.NaN)).toBe(0);
        expect(util.toSecondPrecision(-500)).toBe(0);
    });

    it("generates deterministic conflict copy paths and guards against invalid timestamps", () => {
        const ts: number = Date.UTC(2026, 9, 14, 19, 51, 31);
        const firstConflict: string = util.getConflictPath("folder/note.md", ts);
        expect(firstConflict).toBe("folder/note.conflict-20261014-195131.md");

        const existing: Set<string> = new Set<string>([firstConflict]);
        const secondConflict: string = util.getConflictPath("folder/note.md", ts, existing);
        expect(secondConflict).toBe("folder/note.conflict-20261014-195131-2.md");

        expect(util.getConflictPath(".hidden", ts)).toBe(".hidden.conflict-20261014-195131");
        expect(util.getConflictPath("README", ts)).toBe("README.conflict-20261014-195131");
        expect(util.getConflictPath("folder/note.md", Number.NaN)).toBe(
            "folder/note.conflict-19700101-000000.md"
        );
        expect(util.getConflictPath("folder/note.md", -100)).toBe(
            "folder/note.conflict-19700101-000000.md"
        );
    });

    it("excludes sync state, plugin files, case variations, trash, workspace files, traversal segments, and null-byte paths while allowing .github/.gitlab", () => {
        expect(util.isExcludedPath(".obsidian/plugins/vaultdav/sync-state.json")).toBe(true);
        expect(util.isExcludedPath(".obsidian/plugins/vaultdav/data.json")).toBe(true);
        expect(util.isExcludedPath(".obsidian/plugins/VaultDAV/data.json")).toBe(true);
        expect(util.isExcludedPath(".obsidian/plugins/vaultdav/DATA.JSON")).toBe(true);
        expect(util.isExcludedPath(".obsidian/plugins/vaultdav/main.js")).toBe(true);
        expect(util.isExcludedPath(".obsidian/plugins/vaultdav/data.json.bak")).toBe(true);
        expect(util.isExcludedPath(".obsidian/plugins/vaultdav")).toBe(true);
        expect(util.isExcludedPath(".obsidian/plugins/other/data.json")).toBe(true);
        expect(util.isExcludedPath(".obsidian/plugins/other/sync-state.json")).toBe(true);
        expect(util.isExcludedPath(".obsidian/workspace.json")).toBe(true);
        expect(util.isExcludedPath(".OBSIDIAN/workspace.json")).toBe(true);
        expect(util.isExcludedPath(".obsidian/workspace-mobile.json")).toBe(true);
        expect(util.isExcludedPath(".obsidian-mobile/plugins/vaultdav/data.json")).toBe(
            true
        );
        expect(util.isExcludedPath(".obsidian-mobile/workspace.json")).toBe(true);
        expect(
            util.isExcludedPath("custom-config/plugins/vaultdav/data.json", "custom-config")
        ).toBe(true);
        expect(
            util.isExcludedPath("custom-config/plugins/vaultdav", "custom-config")
        ).toBe(true);
        expect(
            util.isExcludedPath("custom-config/workspace.json", "custom-config")
        ).toBe(true);
        expect(
            util.isExcludedPath("custom-config/plugins/other/sync-state.json", "custom-config")
        ).toBe(true);
        expect(
            util.isExcludedPath("custom-config/app.json", "custom-config")
        ).toBe(false);
        expect(util.isExcludedPath(".trash/note.md")).toBe(true);
        expect(util.isExcludedPath(".TRASH/note.md")).toBe(true);
        expect(util.isExcludedPath("sub/.DS_Store")).toBe(true);
        expect(util.isExcludedPath(".git/config")).toBe(true);
        expect(util.isExcludedPath(".GIT/config")).toBe(true);
        expect(util.isExcludedPath("../outside.md")).toBe(true);
        expect(util.isExcludedPath("Notes/../outside.md")).toBe(true);
        expect(util.isExcludedPath("./note.md")).toBe(true);
        expect(util.isExcludedPath("note\0.md")).toBe(true);

        expect(util.isExcludedPath(".github/workflows/ci.yml")).toBe(false);
        expect(util.isExcludedPath(".gitlab/issue_templates/bug.md")).toBe(false);
        expect(util.isExcludedPath(".obsidian/app.json")).toBe(false);
        expect(util.isExcludedPath("Notes/Daily.md")).toBe(false);

        // Custom vault.configDir support (e.g. .obsidian-mobile)
        expect(
            util.isExcludedPath(
                ".obsidian-mobile/plugins/vaultdav/data.json",
                ".obsidian-mobile"
            )
        ).toBe(true);
        expect(
            util.isExcludedPath(
                ".obsidian-mobile/plugins/vaultdav/sync-state.json",
                ".obsidian-mobile"
            )
        ).toBe(true);
        expect(
            util.isExcludedPath(
                ".obsidian-mobile/plugins/other/data.json",
                ".obsidian-mobile"
            )
        ).toBe(true);
        expect(
            util.isExcludedPath(
                ".obsidian-mobile/workspace-mobile.json",
                ".obsidian-mobile"
            )
        ).toBe(true);
        expect(
            util.isExcludedPath(
                ".obsidian-mobile/app.json",
                ".obsidian-mobile"
            )
        ).toBe(false);
        expect(util.getSyncStateFilePath(".obsidian-mobile")).toBe(
            ".obsidian-mobile/plugins/vaultdav/sync-state.json"
        );
        expect(util.isExplicitRootPath("")).toBe(true);
        expect(util.isExplicitRootPath("/")).toBe(true);
        expect(util.isExplicitRootPath("\n")).toBe(false);
        expect(util.isExplicitRootPath("\r/")).toBe(false);
        expect(util.isExplicitRootPath("\t")).toBe(false);
    });

    it("compares ArrayBuffers and limits concurrency in runConcurrent including NaN guard", async () => {
        const bufA: ArrayBuffer = new Uint8Array([1, 2, 3]).buffer;
        const bufB: ArrayBuffer = new Uint8Array([1, 2, 3]).buffer;
        const bufC: ArrayBuffer = new Uint8Array([1, 2, 4]).buffer;

        expect(util.areArrayBuffersEqual(bufA, bufA)).toBe(true);
        expect(util.areArrayBuffersEqual(bufA, bufB)).toBe(true);
        expect(util.areArrayBuffersEqual(bufA, bufC)).toBe(false);

        let active: number = 0;
        let maxActive: number = 0;
        const tasks: Array<() => Promise<number>> = [1, 2, 3, 4, 5, 6].map(
            (n: number) => async (): Promise<number> => {
                active += 1;
                if (active > maxActive) {
                    maxActive = active;
                }
                await util.delay(10);
                active -= 1;
                return n * 2;
            }
        );

        const results: number[] = await util.runConcurrent(tasks, 2);
        expect(results).toEqual([2, 4, 6, 8, 10, 12]);
        expect(maxActive).toBeLessThanOrEqual(2);

        const nanResults: number[] = await util.runConcurrent(
            [async (): Promise<number> => 42],
            Number.NaN
        );
        expect(nanResults).toEqual([42]);
    });

    it("supports debug logging toggle and Notice notifications", () => {
        const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => undefined);
        log.debugEnabled = false;
        log.debug("hidden message");
        expect(debugSpy).not.toHaveBeenCalled();

        log.debugEnabled = true;
        log.debug("visible message");
        expect(debugSpy).toHaveBeenCalledOnce();
        log.debugEnabled = false;
        debugSpy.mockRestore();
    });

    it("handles cross-platform case variations in decodeWebDavHref, prototype keys, getConflictPath, and NFC normalization", () => {
        // NFD decomposed 'u\u0308' normalized to NFC '\u00fc'
        const nfdPath: string = "Notes/Mu\u0308ller.md";
        const nfcPath: string = "Notes/M\u00fcller.md";
        expect(util.normalizeVaultPath(nfdPath)).toBe(nfcPath);

        // Case-variant prototype keys rejected
        expect(util.normalizeVaultPath("__PROTO__/file.md")).toBe("");
        expect(util.normalizeVaultPath("Notes/CONSTRUCTOR/file.md")).toBe("");
        expect(util.normalizeVaultPath("Notes/Prototype/file.md")).toBe("");

        // Case-insensitive remoteBaseDir matching in decodeWebDavHref
        expect(
            util.decodeWebDavHref(
                "/remote.php/dav/files/alice/Obsidian%20Vault/Notes/Daily.md",
                "alice",
                "obsidian vault"
            )
        ).toBe("Notes/Daily.md");
        expect(
            util.decodeWebDavHref(
                "/remote.php/dav/files/alice/Obsidian%20Vault/",
                "alice",
                "obsidian vault"
            )
        ).toBe("");

        // Case-insensitive collision avoidance in getConflictPath
        const ts: number = Date.UTC(2026, 9, 14, 19, 51, 31);
        const existingUpper: Set<string> = new Set<string>([
            "FOLDER/NOTE.CONFLICT-20261014-195131.MD"
        ]);
        expect(util.getConflictPath("folder/note.md", ts, existingUpper)).toBe(
            "folder/note.conflict-20261014-195131-2.md"
        );
    });

    it("neutralizes red team exploits: cross-user/cross-endpoint href spoofing, invalid remoteBaseDir/username traversal, Windows trailing dot/space smuggling, and out-of-range Date timestamps", () => {
        // 1. Cross-user and cross-endpoint WebDAV href spoofing must return null
        expect(
            util.decodeWebDavHref(
                "/remote.php/dav/files/eve/shared/remote.php/dav/files/alice/Obsidian%20Vault/pwned.md",
                "alice",
                "Obsidian Vault"
            )
        ).toBeNull();
        expect(
            util.decodeWebDavHref(
                "/remote.php/dav/uploads/alice/remote.php/dav/files/alice/Obsidian%20Vault/pwned.md",
                "alice",
                "Obsidian Vault"
            )
        ).toBeNull();
        expect(
            util.decodeWebDavHref(
                "file:///remote.php/dav/files/alice/Obsidian%20Vault/pwned.md",
                "alice",
                "Obsidian Vault"
            )
        ).toBeNull();
        expect(
            util.decodeWebDavHref(
                "http://cloud.example.com/remote.php/dav/files/alice/Obsidian%20Vault/pwned.md",
                "alice",
                "Obsidian Vault"
            )
        ).toBeNull();
        expect(
            util.decodeWebDavHref(
                "//evil.example.com/remote.php/dav/files/alice/Obsidian%20Vault/pwned.md",
                "alice",
                "Obsidian Vault"
            )
        ).toBeNull();
        expect(
            util.decodeWebDavHref(
                "/remote.php/dav/files/alice/Obsidian%20Vault/note.md?download=1",
                "alice",
                "Obsidian Vault"
            )
        ).toBeNull();

        // 2. Traversal or malformed remoteBaseDir must not silently fall back to user root
        for (const badBase of [".", "..", "../secret", "Vault/\0", "__proto__"]) {
            expect(
                util.decodeWebDavHref(
                    "/remote.php/dav/files/alice/SecretPhoto.jpg",
                    "alice",
                    badBase
                )
            ).toBeNull();
            expect(() =>
                util.buildNextcloudWebDavBaseUrl(
                    "https://cloud.example.com",
                    "alice",
                    badBase
                )
            ).toThrow(/remoteBaseDir/i);
        }

        // 3. Username traversal, colons, slashes, control chars, and prototype keys must be rejected; NFD username must match NFC href
        for (const badUser of [
            ".",
            "..",
            "alice:injected",
            "alice/bob",
            "alice\\bob",
            "alice\0",
            "__proto__"
        ]) {
            expect(() =>
                util.buildNextcloudWebDavBaseUrl(
                    "https://cloud.example.com",
                    badUser,
                    "Vault"
                )
            ).toThrow(/username/i);
            expect(
                util.decodeWebDavHref(
                    "/remote.php/dav/files/alice/Vault/Note.md",
                    badUser,
                    "Vault"
                )
            ).toBeNull();
        }
        expect(
            util.decodeWebDavHref(
                "/remote.php/dav/files/m%C3%BCller/Vault/Note.md",
                "mu\u0308ller",
                "Vault"
            )
        ).toBe("Note.md");

        // 4. Windows trailing dot / space segment smuggling & plugin exclusion bypass
        for (const smuggledPath of [
            "Notes/.. /secret.md",
            "Notes/ .../secret.md",
            ".obsidian/plugins/vaultdav./main.js",
            ".obsidian/plugins/vaultdav./data.json",
            ".obsidian/plugins/vaultdav /data.json",
            ".obsidian/plugins/other/data.json.",
            ".git./config"
        ]) {
            expect(util.normalizeVaultPath(smuggledPath)).toBe("");
            expect(util.isExcludedPath(smuggledPath)).toBe(true);
        }
        expect(
            util.decodeWebDavHref(
                "/remote.php/dav/files/alice/Vault/.obsidian/plugins/vaultdav./main.js",
                "alice",
                "Vault"
            )
        ).toBeNull();
        expect(
            util.decodeWebDavHref(
                "/remote.php/dav/files/alice/Vault/Notes/..%20/secret.md",
                "alice",
                "Vault"
            )
        ).toBeNull();

        // 5. Out-of-range finite timestamps (> 8.64e15) and empty/invalid paths in getConflictPath
        expect(util.getConflictPath("folder/note.md", 9e15)).toBe(
            "folder/note.conflict-19700101-000000.md"
        );
        expect(util.getConflictPath("folder/note.md", Number.MAX_VALUE)).toBe(
            "folder/note.conflict-19700101-000000.md"
        );
        expect(() => util.getConflictPath("", 1000)).toThrow(/Conflict path/i);
        expect(() => util.getConflictPath("../secret.md", 1000)).toThrow(
            /Conflict path/i
        );
    });

    it("aborts remaining queued tasks in runConcurrent when a worker rejects and supports O(1) existingLowerPaths in getConflictPath", async () => {
        const started: number[] = [];
        const tasks: Array<() => Promise<number>> = Array.from(
            { length: 12 },
            (_unused: unknown, index: number) => async (): Promise<number> => {
                started.push(index);
                await Promise.resolve();
                if (index === 0) {
                    throw new Error("boom");
                }
                await new Promise<void>((resolve) => setTimeout(resolve, 10));
                return index;
            }
        );

        await expect(util.runConcurrent(tasks, 3)).rejects.toThrow("boom");
        // Allow the other in-flight workers (indices 1 and 2) to settle; no queued tasks (3..11) may start
        await new Promise<void>((resolve) => setTimeout(resolve, 30));
        expect(started).toEqual([0, 1, 2]);

        const stamp: number = Date.UTC(2026, 9, 14, 18, 30, 0);
        const existingLower: Set<string> = new Set<string>([
            "notes/doc.conflict-20261014-183000.md",
            "notes/doc.conflict-20261014-183000-2.md"
        ]);
        expect(
            util.getConflictPath("Notes/Doc.md", stamp, undefined, existingLower)
        ).toBe("Notes/Doc.conflict-20261014-183000-3.md");
    });

    it("neutralizes backslash/triple-slash URL bypasses, NTFS ADS exclusion bypasses, cross-endpoint/encoded-separator href spoofing, and drains in-flight workers on runConcurrent abort", async () => {
        // 1. Backslash and triple-slash https:// URL parsing bypasses in decodeWebDavHref
        for (const maliciousUrlHref of [
            "https://cloud.example.com\\remote.php\\dav\\files\\alice\\Obsidian%20Vault\\Notes\\..\\secret.md",
            "https://cloud.example.com\\remote.php\\dav\\files\\eve\\..\\alice\\Obsidian%20Vault\\pwned.md",
            "https://cloud.example.com\\remote.php\\dav\\uploads\\alice\\..\\..\\files\\alice\\Obsidian%20Vault\\pwned.md",
            "https://cloud.example.com\\remote.php\\dav\\files\\alice\\Obsidian%20Vault\\Notes\\..\\",
            "https://cloud.example.com\\remote.php\\dav\\files\\alice\\Obsidian%20Vault\\note.md?",
            "https://cloud.example.com\\remote.php\\dav\\files\\eve\\shared/remote.php/dav/files/alice/Obsidian%20Vault/pwned.md",
            "https:///remote.php/dav/files/alice/Obsidian%20Vault/pwned.md",
            "https://:@cloud.example.com/remote.php/dav/files/alice/Obsidian%20Vault/pwned.md"
        ]) {
            expect(
                util.decodeWebDavHref(
                    maliciousUrlHref,
                    "alice",
                    "Obsidian Vault"
                )
            ).toBeNull();
        }

        // 2. Windows NTFS Alternate Data Stream (ADS) bypasses across normalizeVaultPath, isExcludedPath, and decodeWebDavHref
        for (const adsPath of [
            ".obsidian/plugins/vaultdav::$INDEX_ALLOCATION/main.js",
            ".obsidian/plugins::$INDEX_ALLOCATION/vaultdav/main.js",
            ".obsidian/plugins/vaultdav::$INDEX_ALLOCATION/data.json",
            ".obsidian/plugins/other/data.json::$DATA",
            ".obsidian/workspace.json::$DATA",
            ".git::$INDEX_ALLOCATION/config",
            ".trash::$INDEX_ALLOCATION/note.md",
            "custom-config::$INDEX_ALLOCATION/plugins/vaultdav/data.json",
            "..::$INDEX_ALLOCATION/secret.md",
            "Notes/file.md:hidden"
        ]) {
            expect(util.normalizeVaultPath(adsPath)).toBe("");
            expect(util.isExcludedPath(adsPath, "custom-config")).toBe(true);
            expect(
                util.decodeWebDavHref(
                    `/remote.php/dav/files/alice/Vault/${adsPath}`,
                    "alice",
                    "Vault"
                )
            ).toBeNull();
        }

        // 3. Cross-endpoint spoofing (/remote.php/webdav, /public.php) and encoded path separator (%2F/%5C) or relative/backslash hrefs
        for (const spoofedHref of [
            "/remote.php/webdav/remote.php/dav/files/alice/Obsidian%20Vault/pwned.md",
            "/remote.php/carddav/calendars/remote.php/dav/files/alice/Obsidian%20Vault/pwned.md",
            "/public.php/dav/files/token/remote.php/dav/files/alice/Obsidian%20Vault/pwned.md",
            "/remote.php/dav/files/alice/Obsidian%20Vault/Notes%2fpwned.md",
            "/remote.php/dav/files/alice/Obsidian%20Vault/Notes%5cpwned.md",
            "/remote.php%2fdav%2ffiles%2falice%2fObsidian%20Vault%2fpwned.md",
            "evil.example.com/remote.php/dav/files/alice/Obsidian%20Vault/pwned.md",
            "/evil.example.com\\remote.php\\dav\\files\\alice\\Obsidian%20Vault\\pwned.md"
        ]) {
            expect(
                util.decodeWebDavHref(
                    spoofedHref,
                    "alice",
                    "Obsidian Vault"
                )
            ).toBeNull();
        }

        // Legitimate nested directory named remote.php inside the user's vault must still decode normally
        expect(
            util.decodeWebDavHref(
                "/remote.php/dav/files/alice/Obsidian%20Vault/remote.php/dav/files/note.md",
                "alice",
                "Obsidian Vault"
            )
        ).toBe("remote.php/dav/files/note.md");

        // 4. runConcurrent must wait for all in-flight workers to settle before rejecting (no orphaned background tasks)
        let activeWorkers: number = 0;
        let activeAtReject: number = -1;
        const started: number[] = [];
        const drainTasks: Array<() => Promise<number>> = Array.from(
            { length: 8 },
            (_unused: unknown, index: number) => async (): Promise<number> => {
                started.push(index);
                activeWorkers += 1;
                try {
                    if (index === 0) {
                        await new Promise<void>((resolve) => setTimeout(resolve, 5));
                        throw new Error("chunk failed");
                    }
                    await new Promise<void>((resolve) => setTimeout(resolve, 25));
                    return index;
                } finally {
                    activeWorkers -= 1;
                }
            }
        );

        let caughtErr: unknown = null;
        try {
            await util.runConcurrent(drainTasks, 3);
        } catch (err: unknown) {
            caughtErr = err;
            activeAtReject = activeWorkers;
        }
        expect(caughtErr).toBeInstanceOf(Error);
        expect((caughtErr as Error).message).toBe("chunk failed");
        expect(activeAtReject).toBe(0);
        expect(started).toEqual([0, 1, 2]);
    });

    it("resolves and excludes sync-history.json, parses conflict copy paths, and formats byte sizes", () => {
        expect(util.getSyncHistoryFilePath(".obsidian")).toBe(
            ".obsidian/plugins/vaultdav/sync-history.json"
        );
        expect(util.getSyncHistoryFilePath(".custom-cfg")).toBe(
            ".custom-cfg/plugins/vaultdav/sync-history.json"
        );
        expect(() => util.getSyncHistoryFilePath("..")).toThrow(
            "Invalid Obsidian configDir"
        );

        expect(
            util.isExcludedPath(
                ".obsidian/plugins/vaultdav/sync-history.json",
                ".obsidian"
            )
        ).toBe(true);
        expect(
            util.isExcludedPath(
                "custom-cfg/plugins/vaultdav/sync-history.json",
                "custom-cfg"
            )
        ).toBe(true);
        expect(
            util.isExcludedPath(
                ".custom/plugins/other/sync-history.json",
                ".custom"
            )
        ).toBe(true);

        expect(
            util.parseConflictCopyPath("Notes/Daily.conflict-20261124-173500.md")
        ).toEqual({
            originalPath: "Notes/Daily.md",
            timestampUtc: "2026-11-24 17:35:00 UTC"
        });
        expect(
            util.parseConflictCopyPath(
                "Notes/Daily.conflict-20261124-173500-2.md"
            )
        ).toEqual({
            originalPath: "Notes/Daily.md",
            timestampUtc: "2026-11-24 17:35:00 UTC"
        });
        expect(
            util.parseConflictCopyPath("archive.tar.conflict-20261124-010203.gz")
        ).toEqual({
            originalPath: "archive.tar.gz",
            timestampUtc: "2026-11-24 01:02:03 UTC"
        });
        expect(
            util.parseConflictCopyPath("README.conflict-20261124-000000")
        ).toEqual({
            originalPath: "README",
            timestampUtc: "2026-11-24 00:00:00 UTC"
        });
        expect(
            util.parseConflictCopyPath(".env.conflict-20261124-000000")
        ).toEqual({
            originalPath: ".env",
            timestampUtc: "2026-11-24 00:00:00 UTC"
        });
        expect(util.parseConflictCopyPath("Notes/Daily.md")).toBeNull();
        expect(util.parseConflictCopyPath("../bad.conflict-20261124-000000.md")).toBeNull();

        expect(util.formatByteSize(0)).toBe("0 B");
        expect(util.formatByteSize(-10)).toBe("0 B");
        expect(util.formatByteSize(Number.NaN)).toBe("0 B");
        expect(util.formatByteSize(512)).toBe("512 B");
        expect(util.formatByteSize(1536)).toBe("1.5 KB");
        expect(util.formatByteSize(2 * 1024 * 1024)).toBe("2.0 MB");
        expect(util.formatByteSize(1.5 * 1024 * 1024 * 1024)).toBe("1.50 GB");
    });
});
