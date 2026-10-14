import { describe, expect, it, vi } from "vitest";
import { log } from "../src/log";
import {
    MAX_FILE_SIZE_BYTES,
    MAX_WALK_DEPTH,
    PLUGIN_DATA_FILE_PATH,
    SYNC_STATE_FILE_PATH,
    util
} from "../src/utilities";

describe("utilities and logging", () => {
    it("exports top-level file path and size constants sorted alphabetically", () => {
        expect(MAX_FILE_SIZE_BYTES).toBe(50 * 1024 * 1024);
        expect(MAX_WALK_DEPTH).toBe(64);
        expect(PLUGIN_DATA_FILE_PATH).toBe(".obsidian/plugins/vaultdav/data.json");
        expect(SYNC_STATE_FILE_PATH).toBe(".obsidian/plugins/vaultdav/sync-state.json");
        expect(util.MAX_FILE_SIZE_BYTES).toBe(MAX_FILE_SIZE_BYTES);
        expect(util.MAX_WALK_DEPTH).toBe(MAX_WALK_DEPTH);
        expect(util.PLUGIN_DATA_FILE_PATH).toBe(PLUGIN_DATA_FILE_PATH);
        expect(util.SYNC_STATE_FILE_PATH).toBe(SYNC_STATE_FILE_PATH);
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
});
