import { describe, expect, it, vi } from "vitest";
import { log } from "../src/log";
import { util } from "../src/utilities";

describe("utilities and logging", () => {
    it("encodes ASCII and UTF-8 credentials for HTTP Basic Auth", () => {
        expect(util.encodeBasicAuth("alice", "secret123")).toBe("Basic YWxpY2U6c2VjcmV0MTIz");
        expect(util.encodeBasicAuth("müller", "pässwörd-你好")).toBe(
            "Basic bcO8bGxlcjpww6Rzc3fDtnJkLeS9oOWlvQ=="
        );
    });

    it("normalizes vault paths and encodes WebDAV path segments safely", () => {
        expect(util.normalizeVaultPath("/notes//daily/2026-10-14.md/")).toBe(
            "notes/daily/2026-10-14.md"
        );
        expect(util.normalizeVaultPath("/")).toBe("");
        expect(util.normalizeVaultPath("")).toBe("");

        expect(util.encodeWebDavPath("Notes/C# Programming & Q?.md")).toBe(
            "Notes/C%23%20Programming%20%26%20Q%3F.md"
        );
    });

    it("builds Nextcloud WebDAV base URLs from root or full DAV endpoints", () => {
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
    });

    it("decodes WebDAV href values and filters root or outside paths", () => {
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
                "https://cloud.example.com/remote.php/dav/files/alice/OtherFolder/file.md",
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
    });

    it("generates deterministic conflict copy paths without collisions", () => {
        const ts: number = Date.UTC(2026, 9, 14, 19, 51, 31);
        const firstConflict: string = util.getConflictPath("folder/note.md", ts);
        expect(firstConflict).toBe("folder/note.conflict-20261014-195131.md");

        const existing: Set<string> = new Set<string>([firstConflict]);
        const secondConflict: string = util.getConflictPath("folder/note.md", ts, existing);
        expect(secondConflict).toBe("folder/note.conflict-20261014-195131-2.md");

        expect(util.getConflictPath(".hidden", ts)).toBe(".hidden.conflict-20261014-195131");
        expect(util.getConflictPath("README", ts)).toBe("README.conflict-20261014-195131");
    });

    it("excludes sync state, plugin credentials, workspace files, and OS artifacts", () => {
        expect(util.isExcludedPath(".obsidian/plugins/vaultdav/sync-state.json")).toBe(true);
        expect(util.isExcludedPath(".obsidian/plugins/vaultdav/data.json")).toBe(true);
        expect(util.isExcludedPath(".obsidian/workspace.json")).toBe(true);
        expect(util.isExcludedPath(".obsidian/workspace-mobile.json")).toBe(true);
        expect(util.isExcludedPath("sub/.DS_Store")).toBe(true);
        expect(util.isExcludedPath(".git/config")).toBe(true);

        expect(util.isExcludedPath(".obsidian/app.json")).toBe(false);
        expect(util.isExcludedPath("Notes/Daily.md")).toBe(false);
    });

    it("compares ArrayBuffers and limits concurrency in runConcurrent", async () => {
        const bufA: ArrayBuffer = new Uint8Array([1, 2, 3]).buffer;
        const bufB: ArrayBuffer = new Uint8Array([1, 2, 3]).buffer;
        const bufC: ArrayBuffer = new Uint8Array([1, 2, 4]).buffer;

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
});
