import type { DataAdapter, ListedFiles, Stat, Vault } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { log } from "../src/log";
import {
    SyncEngine,
    buildSyncPlan,
    isLocalModified,
    isMetadataEqual,
    isRemoteModified
} from "../src/sync/engine";
import { SyncStateStore } from "../src/sync/state";
import type {
    LocalItem,
    RemoteItem,
    SyncAction,
    SyncPlan,
    SyncStateRecord,
    VaultDavSettings
} from "../src/types";
import type { WebDavClient } from "../src/webdav/client";

function makeLocal(
    path: string,
    mtime: number,
    size: number,
    isDirectory: boolean = false
): LocalItem {
    return {
        ctime: mtime,
        isDirectory,
        mtime,
        path,
        size: isDirectory ? 0 : size
    };
}

function makeRemote(
    path: string,
    mtime: number,
    size: number,
    etag: string,
    isDirectory: boolean = false
): RemoteItem {
    return {
        etag,
        href: `/remote.php/dav/files/alice/Vault/${path}`,
        isDirectory,
        mtime,
        path,
        size: isDirectory ? 0 : size
    };
}

function makeState(
    path: string,
    localMtime: number,
    remoteMtime: number,
    size: number,
    etag: string,
    isDirectory: boolean = false
): SyncStateRecord {
    return {
        etag,
        isDirectory,
        lastSyncTime: 1728920000000,
        localMtime,
        path,
        remoteMtime,
        size: isDirectory ? 0 : size
    };
}

describe("SyncEngine delta calculation and execution", () => {
    it("normalizes millisecond local mtime vs second remote mtime and ETag", () => {
        const local: LocalItem = makeLocal("a.md", 1728928291789, 100);
        const remote: RemoteItem = makeRemote("a.md", 1728928291000, 100, "etag-1");
        const state: SyncStateRecord = makeState(
            "a.md",
            1728928291123,
            1728928291000,
            100,
            "etag-1"
        );

        expect(isMetadataEqual(local, remote)).toBe(true);
        expect(isLocalModified(local, state)).toBe(false);
        expect(isRemoteModified(remote, state)).toBe(false);

        const modifiedRemoteEtag: RemoteItem = makeRemote(
            "a.md",
            1728928291000,
            100,
            "etag-2"
        );
        expect(isRemoteModified(modifiedRemoteEtag, state)).toBe(true);
    });

    it("evaluates all 14 file decision matrix branches (F1-F14)", () => {
        const t0: number = 1728928000000;
        const t1: number = 1728929000000;

        const localItems: LocalItem[] = [
            makeLocal("f2-unchanged.md", t0 + 400, 10),
            makeLocal("f3-local-mod.md", t1, 12),
            makeLocal("f4-remote-mod.md", t0, 10),
            makeLocal("f5-both-mod-equal.md", t1 + 250, 20),
            makeLocal("f6-both-mod-conflict.md", t1, 25),
            makeLocal("f7-new-both-equal.md", t0 + 999, 30),
            makeLocal("f8-new-both-conflict.md", t0, 31),
            makeLocal("f9-local-new.md", t0, 40),
            makeLocal("f10-remote-deleted.md", t0, 50),
            makeLocal("f11-remote-del-local-mod.md", t1, 55)
        ];

        const remoteItems: RemoteItem[] = [
            makeRemote("f2-unchanged.md", t0, 10, "e2"),
            makeRemote("f3-local-mod.md", t0, 10, "e3"),
            makeRemote("f4-remote-mod.md", t1, 15, "e4-new"),
            makeRemote("f5-both-mod-equal.md", t1, 20, "e5-new"),
            makeRemote("f6-both-mod-conflict.md", t1, 28, "e6-new"),
            makeRemote("f7-new-both-equal.md", t0, 30, "e7"),
            makeRemote("f8-new-both-conflict.md", t1, 35, "e8"),
            makeRemote("f12-remote-new.md", t0, 60, "e12"),
            makeRemote("f13-local-deleted.md", t0, 70, "e13"),
            makeRemote("f14-local-del-remote-mod.md", t1, 75, "e14-new")
        ];

        const stateRecords: Record<string, SyncStateRecord> = {
            "f1-both-deleted.md": makeState("f1-both-deleted.md", t0, t0, 10, "e1"),
            "f2-unchanged.md": makeState("f2-unchanged.md", t0, t0, 10, "e2"),
            "f3-local-mod.md": makeState("f3-local-mod.md", t0, t0, 10, "e3"),
            "f4-remote-mod.md": makeState("f4-remote-mod.md", t0, t0, 10, "e4"),
            "f5-both-mod-equal.md": makeState("f5-both-mod-equal.md", t0, t0, 10, "e5"),
            "f6-both-mod-conflict.md": makeState(
                "f6-both-mod-conflict.md",
                t0,
                t0,
                10,
                "e6"
            ),
            "f10-remote-deleted.md": makeState("f10-remote-deleted.md", t0, t0, 50, "e10"),
            "f11-remote-del-local-mod.md": makeState(
                "f11-remote-del-local-mod.md",
                t0,
                t0,
                50,
                "e11"
            ),
            "f13-local-deleted.md": makeState("f13-local-deleted.md", t0, t0, 70, "e13"),
            "f14-local-del-remote-mod.md": makeState(
                "f14-local-del-remote-mod.md",
                t0,
                t0,
                70,
                "e14"
            )
        };

        const plan: SyncPlan = buildSyncPlan(localItems, remoteItems, stateRecords, t1);
        const byPath: Map<string, SyncAction> = new Map<string, SyncAction>(
            plan.actions.map((a: SyncAction) => [a.path, a])
        );

        expect(byPath.get("f1-both-deleted.md")?.type).toBe("prune_state");
        expect(byPath.get("f2-unchanged.md")?.type).toBe("noop");
        expect(byPath.get("f3-local-mod.md")?.type).toBe("upload");
        expect(byPath.get("f4-remote-mod.md")?.type).toBe("download");
        expect(byPath.get("f5-both-mod-equal.md")?.type).toBe("noop");
        expect(byPath.get("f6-both-mod-conflict.md")?.type).toBe("conflict");
        expect(byPath.get("f7-new-both-equal.md")?.type).toBe("noop");
        expect(byPath.get("f8-new-both-conflict.md")?.type).toBe("conflict");
        expect(byPath.get("f9-local-new.md")?.type).toBe("upload");
        expect(byPath.get("f10-remote-deleted.md")?.type).toBe("delete_local");
        expect(byPath.get("f11-remote-del-local-mod.md")?.type).toBe("upload");
        expect(byPath.get("f12-remote-new.md")?.type).toBe("download");
        expect(byPath.get("f13-local-deleted.md")?.type).toBe("delete_remote");
        expect(byPath.get("f14-local-del-remote-mod.md")?.type).toBe("download");
    });

    it("propagates keptFolders so parent folders with new children are recreated instead of deleted", () => {
        const t0: number = 1728928000000;
        const localItems: LocalItem[] = [
            makeLocal("Archive", t0, 0, true),
            makeLocal("Archive/Sub", t0, 0, true),
            makeLocal("Archive/Sub/NewLocalNote.md", t0, 25, false),
            makeLocal("EmptyDeletedOnRemote", t0, 0, true)
        ];
        const remoteItems: RemoteItem[] = [];
        const stateRecords: Record<string, SyncStateRecord> = {
            Archive: makeState("Archive", t0, t0, 0, "dir-1", true),
            "Archive/Sub": makeState("Archive/Sub", t0, t0, 0, "dir-2", true),
            EmptyDeletedOnRemote: makeState(
                "EmptyDeletedOnRemote",
                t0,
                t0,
                0,
                "dir-3",
                true
            )
        };

        const plan: SyncPlan = buildSyncPlan(localItems, remoteItems, stateRecords, t0);
        const byPath: Map<string, SyncAction> = new Map<string, SyncAction>(
            plan.actions.map((a: SyncAction) => [a.path, a])
        );

        expect(byPath.get("Archive/Sub/NewLocalNote.md")?.type).toBe("upload");
        expect(byPath.get("Archive/Sub")?.type).toBe("create_remote_dir");
        expect(byPath.get("Archive")?.type).toBe("create_remote_dir");
        expect(byPath.get("EmptyDeletedOnRemote")?.type).toBe("delete_local");
    });

    it("executes 4 phases in order (top-down mkdir, bottom-up delete, conflict keep_both & newest_wins)", async () => {
        const t0: number = Date.UTC(2026, 9, 14, 18, 0, 0);
        const t1: number = Date.UTC(2026, 9, 14, 19, 0, 0);

        const operationLog: string[] = [];
        const localFiles: Map<string, ArrayBuffer> = new Map<string, ArrayBuffer>([
            ["ConflictDiff.md", new TextEncoder().encode("local-version").buffer],
            ["ConflictSameBytes.md", new TextEncoder().encode("identical").buffer],
            ["DirA/DirB/UploadMe.md", new TextEncoder().encode("upload-payload").buffer],
            ["OldDir/OldSub/DeleteLocalFile.md", new TextEncoder().encode("old").buffer]
        ]);
        const localDirs: Set<string> = new Set<string>([
            "DirA",
            "DirA/DirB",
            "OldDir",
            "OldDir/OldSub"
        ]);
        const textFiles: Map<string, string> = new Map<string, string>();

        const adapter: Partial<DataAdapter> = {
            exists: async (p: string): Promise<boolean> => {
                return localFiles.has(p) || localDirs.has(p) || textFiles.has(p);
            },
            list: async (_p: string): Promise<ListedFiles> => {
                return { files: [], folders: [] };
            },
            mkdir: async (p: string): Promise<void> => {
                operationLog.push(`local:mkdir:${p}`);
                localDirs.add(p);
            },
            read: async (p: string): Promise<string> => {
                return textFiles.get(p) ?? "";
            },
            readBinary: async (p: string): Promise<ArrayBuffer> => {
                const buf: ArrayBuffer | undefined = localFiles.get(p);
                if (buf === undefined) {
                    throw new Error(`Missing local binary ${p}`);
                }
                return buf;
            },
            stat: async (p: string): Promise<Stat | null> => {
                const buf: ArrayBuffer | undefined = localFiles.get(p);
                if (buf !== undefined) {
                    return {
                        ctime: t1,
                        mtime: t1,
                        size: buf.byteLength,
                        type: "file"
                    };
                }
                if (localDirs.has(p)) {
                    return {
                        ctime: t1,
                        mtime: t1,
                        size: 0,
                        type: "folder"
                    };
                }
                return null;
            },
            trashLocal: async (p: string): Promise<void> => {
                operationLog.push(`local:delete:${p}`);
                localFiles.delete(p);
                localDirs.delete(p);
            },
            write: async (p: string, data: string): Promise<void> => {
                textFiles.set(p, data);
            },
            writeBinary: async (p: string, data: ArrayBuffer): Promise<void> => {
                operationLog.push(`local:write:${p}`);
                localFiles.set(p, data);
            }
        };

        const mockClient: Partial<WebDavClient> = {
            createDirectory: async (p: string): Promise<void> => {
                operationLog.push(`remote:mkdir:${p}`);
            },
            deleteItem: async (p: string): Promise<void> => {
                operationLog.push(`remote:delete:${p}`);
            },
            downloadFile: async (p: string): Promise<ArrayBuffer> => {
                operationLog.push(`remote:download:${p}`);
                if (p === "ConflictSameBytes.md") {
                    return new TextEncoder().encode("identical").buffer;
                }
                return new TextEncoder().encode(`remote-content:${p}`).buffer;
            },
            uploadFile: async (
                p: string,
                content: ArrayBuffer,
                mtime: number
            ): Promise<RemoteItem> => {
                operationLog.push(`remote:upload:${p}`);
                return makeRemote(p, mtime, content.byteLength, `etag-${p}`);
            }
        };

        const settings: VaultDavSettings = {
            appPassword: "pw",
            chunkSizeMB: 10,
            chunkingThresholdMB: 90,
            conflictStrategy: "keep_both",
            remoteBaseDir: "Vault",
            syncInterval: 0,
            url: "https://cloud.example.com",
            username: "alice"
        };

        const vault: Vault = { adapter: adapter as DataAdapter } as Vault;
        const stateStore: SyncStateStore = new SyncStateStore(adapter as DataAdapter);
        await stateStore.load();

        const localItems: LocalItem[] = [
            makeLocal("DirA", t1, 0, true),
            makeLocal("DirA/DirB", t1, 0, true),
            makeLocal("DirA/DirB/UploadMe.md", t1, 14, false),
            makeLocal("OldDir", t0, 0, true),
            makeLocal("OldDir/OldSub", t0, 0, true),
            makeLocal("OldDir/OldSub/DeleteLocalFile.md", t0, 3, false),
            makeLocal("ConflictDiff.md", t1, 13, false),
            makeLocal("ConflictSameBytes.md", t1, 9, false)
        ];

        const remoteItems: RemoteItem[] = [
            makeRemote("ConflictDiff.md", t1 + 1000, 29, "etag-diff", false),
            makeRemote("ConflictSameBytes.md", t1 + 1000, 9, "etag-same", false)
        ];

        const stateRecords: Record<string, SyncStateRecord> = {
            OldDir: makeState("OldDir", t0, t0, 0, "d1", true),
            "OldDir/OldSub": makeState("OldDir/OldSub", t0, t0, 0, "d2", true),
            "OldDir/OldSub/DeleteLocalFile.md": makeState(
                "OldDir/OldSub/DeleteLocalFile.md",
                t0,
                t0,
                3,
                "f1",
                false
            )
        };

        for (const rec of Object.values(stateRecords)) {
            stateStore.upsertRecord(rec);
        }

        const plan: SyncPlan = buildSyncPlan(localItems, remoteItems, stateRecords, t1);
        const engine: SyncEngine = new SyncEngine(
            vault,
            mockClient as WebDavClient,
            stateStore,
            settings
        );

        const result = await engine.executePlan(plan, localItems, remoteItems);

        expect(result.errors).toEqual([]);
        expect(result.uploaded).toBe(1);
        expect(result.conflictsResolved).toBe(2);
        expect(result.deletedLocal).toBe(1);

        const mkdirDirAIndex: number = operationLog.indexOf("remote:mkdir:DirA");
        const mkdirDirBIndex: number = operationLog.indexOf("remote:mkdir:DirA/DirB");
        const uploadIndex: number = operationLog.indexOf(
            "remote:upload:DirA/DirB/UploadMe.md"
        );
        expect(mkdirDirAIndex).toBeGreaterThanOrEqual(0);
        expect(mkdirDirBIndex).toBeGreaterThan(mkdirDirAIndex);
        expect(uploadIndex).toBeGreaterThan(mkdirDirBIndex);

        const delFileIdx: number = operationLog.indexOf(
            "local:delete:OldDir/OldSub/DeleteLocalFile.md"
        );
        const delSubIdx: number = operationLog.indexOf("local:delete:OldDir/OldSub");
        const delRootIdx: number = operationLog.indexOf("local:delete:OldDir");
        expect(delFileIdx).toBeGreaterThanOrEqual(0);
        expect(delSubIdx).toBeGreaterThan(delFileIdx);
        expect(delRootIdx).toBeGreaterThan(delSubIdx);

        expect(
            operationLog.some((entry: string) =>
                entry.startsWith("remote:upload:ConflictDiff.conflict-")
            )
        ).toBe(true);
        expect(
            operationLog.some((entry: string) =>
                entry.startsWith("remote:upload:ConflictSameBytes.conflict-")
            )
        ).toBe(false);
    });

    it("resolves conflicts using newest_wins strategy and walks local vault via runSync", async () => {
        const t0: number = Date.UTC(2026, 9, 14, 18, 0, 0);
        const tNewer: number = Date.UTC(2026, 9, 14, 19, 0, 0);

        const uploadedPaths: string[] = [];
        const downloadedPaths: string[] = [];
        const textFiles: Map<string, string> = new Map<string, string>();

        const adapter: Partial<DataAdapter> = {
            exists: async (): Promise<boolean> => true,
            list: async (dir: string): Promise<ListedFiles> => {
                if (dir === "") {
                    return {
                        files: [
                            "LocalWins.md",
                            "RemoteWins.md",
                            ".obsidian/workspace.json"
                        ],
                        folders: [".git"]
                    };
                }
                return { files: [], folders: [] };
            },
            mkdir: async (): Promise<void> => undefined,
            read: async (p: string): Promise<string> => textFiles.get(p) ?? "",
            readBinary: async (): Promise<ArrayBuffer> => new Uint8Array([1, 2]).buffer,
            stat: async (p: string): Promise<Stat | null> => {
                if (p === "LocalWins.md") {
                    return { ctime: tNewer, mtime: tNewer, size: 10, type: "file" };
                }
                if (p === "RemoteWins.md") {
                    return { ctime: t0, mtime: t0, size: 10, type: "file" };
                }
                return null;
            },
            write: async (p: string, d: string): Promise<void> => {
                textFiles.set(p, d);
            },
            writeBinary: async (p: string): Promise<void> => {
                downloadedPaths.push(p);
            }
        };

        const mockClient: Partial<WebDavClient> = {
            downloadFile: async (): Promise<ArrayBuffer> => new Uint8Array([3, 4, 5]).buffer,
            ensureRemoteBaseDir: async (): Promise<void> => undefined,
            uploadFile: async (
                p: string,
                content: ArrayBuffer,
                mtime: number
            ): Promise<RemoteItem> => {
                uploadedPaths.push(p);
                return makeRemote(p, mtime, content.byteLength, `etag-${p}`);
            },
            walkRemote: async (): Promise<RemoteItem[]> => [
                makeRemote("LocalWins.md", t0, 20, "r1", false),
                makeRemote("RemoteWins.md", tNewer, 20, "r2", false)
            ]
        };

        const settings: VaultDavSettings = {
            appPassword: "pw",
            chunkSizeMB: 10,
            chunkingThresholdMB: 90,
            conflictStrategy: "newest_wins",
            remoteBaseDir: "Vault",
            syncInterval: 0,
            url: "https://cloud.example.com",
            username: "alice"
        };

        const vault: Vault = { adapter: adapter as DataAdapter } as Vault;
        const stateStore: SyncStateStore = new SyncStateStore(adapter as DataAdapter);
        const engine: SyncEngine = new SyncEngine(
            vault,
            mockClient as WebDavClient,
            stateStore,
            settings
        );

        const result = await engine.runSync();
        expect(result.conflictsResolved).toBe(2);
        expect(uploadedPaths).toEqual(["LocalWins.md"]);
        expect(downloadedPaths).toEqual(["RemoteWins.md"]);
    });

    it("excludes .trash and path traversal while syncing .github and guarding NaN timestamps and stats", async () => {
        const plan: SyncPlan = buildSyncPlan(
            [
                makeLocal(".trash/deleted.md", 1000, 10),
                makeLocal("../outside.md", 1000, 10),
                makeLocal(".github/workflows/ci.yml", 1000, 20),
                makeLocal("ConflictNaN.md", 1000, 15)
            ],
            [makeRemote("ConflictNaN.md", 2000, 25, "e-nan")],
            {},
            Number.NaN
        );

        expect(plan.timestamp).toBe(0);
        const paths: string[] = plan.actions.map((a: SyncAction) => a.path);
        expect(paths).not.toContain(".trash/deleted.md");
        expect(paths).not.toContain("../outside.md");
        expect(paths).toContain(".github/workflows/ci.yml");

        const conflictAction: SyncAction | undefined = plan.actions.find(
            (a: SyncAction) => a.path === "ConflictNaN.md"
        );
        expect(conflictAction?.conflictCopyPath).toBe(
            "ConflictNaN.conflict-19700101-000000.md"
        );

        const adapter: Partial<DataAdapter> = {
            list: async (dir: string): Promise<ListedFiles> => {
                if (dir === "") {
                    return {
                        files: ["NaNStat.md", ".trash/trashed.md"],
                        folders: [".trash"]
                    };
                }
                return { files: [], folders: [] };
            },
            stat: async (p: string): Promise<Stat | null> => {
                if (p === "NaNStat.md") {
                    return {
                        ctime: Number.NaN,
                        mtime: Number.NaN,
                        size: Number.NaN,
                        type: "file"
                    };
                }
                return null;
            }
        };

        const engine: SyncEngine = new SyncEngine(
            { adapter: adapter as DataAdapter } as Vault,
            {} as WebDavClient,
            new SyncStateStore(adapter as DataAdapter),
            {
                appPassword: "pw",
                chunkSizeMB: 10,
                chunkingThresholdMB: 90,
                conflictStrategy: "keep_both",
                remoteBaseDir: "Vault",
                syncInterval: 0,
                url: "https://cloud.example.com",
                username: "alice"
            }
        );

        const walked: LocalItem[] = await engine.walkLocal();
        expect(walked).toEqual([
            {
                ctime: 0,
                isDirectory: false,
                mtime: 0,
                path: "NaNStat.md",
                size: 0
            }
        ]);
    });

    it("batches stateStore.save calls once per depth-level phase and once after 10 concurrent transfers", async () => {
        const t0: number = Date.UTC(2026, 9, 14, 20, 0, 0);
        const textFiles: Map<string, string> = new Map<string, string>();

        const adapter: Partial<DataAdapter> = {
            exists: async (p: string): Promise<boolean> =>
                textFiles.has(p) || !p.endsWith("sync-state.json"),
            mkdir: async (): Promise<void> => undefined,
            read: async (p: string): Promise<string> => textFiles.get(p) ?? "",
            readBinary: async (): Promise<ArrayBuffer> => new Uint8Array([1, 2, 3]).buffer,
            stat: async (): Promise<Stat | null> => ({
                ctime: t0,
                mtime: t0,
                size: 3,
                type: "file"
            }),
            write: async (p: string, d: string): Promise<void> => {
                textFiles.set(p, d);
            },
            writeBinary: async (): Promise<void> => undefined
        };

        const mockClient: Partial<WebDavClient> = {
            createDirectory: async (): Promise<void> => undefined,
            downloadFile: async (): Promise<ArrayBuffer> => new Uint8Array([4, 5, 6]).buffer,
            uploadFile: async (
                p: string,
                content: ArrayBuffer,
                mtime: number
            ): Promise<RemoteItem> => makeRemote(p, mtime, content.byteLength, `etag-${p}`)
        };

        const stateStore: SyncStateStore = new SyncStateStore(adapter as DataAdapter);
        await stateStore.load();
        const saveSpy = vi.spyOn(stateStore, "save");

        const localItems: LocalItem[] = [
            makeLocal("DirA", t0, 0, true),
            makeLocal("DirA/Sub1", t0, 0, true),
            makeLocal("DirB", t0, 0, true),
            makeLocal("DirB/Sub2", t0, 0, true)
        ];
        const remoteItems: RemoteItem[] = [];

        for (let i: number = 0; i < 5; i += 1) {
            localItems.push(makeLocal(`DirA/Sub1/up-${i}.md`, t0, 3, false));
            remoteItems.push(
                makeRemote(`DirB/Sub2/down-${i}.md`, t0, 3, `etag-down-${i}`, false)
            );
        }

        const plan: SyncPlan = buildSyncPlan(localItems, remoteItems, {}, t0);
        const engine: SyncEngine = new SyncEngine(
            { adapter: adapter as DataAdapter } as Vault,
            mockClient as WebDavClient,
            stateStore,
            {
                appPassword: "pw",
                chunkSizeMB: 10,
                chunkingThresholdMB: 90,
                conflictStrategy: "keep_both",
                remoteBaseDir: "Vault",
                syncInterval: 0,
                url: "https://cloud.example.com",
                username: "alice"
            }
        );

        const result = await engine.executePlan(plan, localItems, remoteItems);
        expect(result.uploaded).toBe(5);
        expect(result.downloaded).toBe(5);
        expect(result.errors).toEqual([]);
        // 2 directory creation depth levels (depth 0 and depth 1) + 1 save after 10 concurrent transfers = 3 saves total
        expect(saveSpy).toHaveBeenCalledTimes(3);

        saveSpy.mockClear();
        const transferOnlyActions: SyncAction[] = plan.actions.filter(
            (a: SyncAction) => a.type === "upload" || a.type === "download"
        );
        expect(transferOnlyActions.length).toBe(10);

        await engine.executePlan(
            { actions: transferOnlyActions, timestamp: t0 },
            localItems,
            remoteItems
        );
        expect(saveSpy).toHaveBeenCalledTimes(1);
    });

    it("rethrows adapter.list OS errors in walkLocal so runSync aborts instead of deleting remote files", async () => {
        const errorSpy = vi.spyOn(log, "error").mockImplementation((): void => undefined);
        const permissionError: Error = new Error("EACCES: permission denied");
        const remoteDeletedPaths: string[] = [];

        const adapter: Partial<DataAdapter> = {
            exists: async (): Promise<boolean> => false,
            list: async (dir: string): Promise<ListedFiles> => {
                if (dir === "") {
                    return {
                        files: ["root.md"],
                        folders: ["RestrictedDir", "SiblingDir"]
                    };
                }
                if (dir === "RestrictedDir") {
                    throw permissionError;
                }
                return { files: [], folders: [] };
            },
            stat: async (p: string): Promise<Stat | null> => ({
                ctime: 1000,
                mtime: 1000,
                size: p.endsWith(".md") ? 42 : 0,
                type: p.endsWith(".md") ? "file" : "folder"
            })
        };

        const mockClient: Partial<WebDavClient> = {
            deleteItem: async (p: string): Promise<void> => {
                remoteDeletedPaths.push(p);
            },
            ensureRemoteBaseDir: async (): Promise<void> => undefined,
            walkRemote: async (): Promise<RemoteItem[]> => [
                makeRemote("RestrictedDir/secret.md", 1000, 42, "etag-secret", false)
            ]
        };

        const stateStore: SyncStateStore = new SyncStateStore(adapter as DataAdapter);
        stateStore.upsertRecord(
            makeState("RestrictedDir/secret.md", 1000, 1000, 42, "etag-secret", false)
        );

        const engine: SyncEngine = new SyncEngine(
            { adapter: adapter as DataAdapter } as Vault,
            mockClient as WebDavClient,
            stateStore,
            {
                appPassword: "pw",
                chunkSizeMB: 10,
                chunkingThresholdMB: 90,
                conflictStrategy: "keep_both",
                remoteBaseDir: "Vault",
                syncInterval: 0,
                url: "https://cloud.example.com",
                username: "alice"
            }
        );

        try {
            await expect(engine.walkLocal()).rejects.toThrow("EACCES: permission denied");
            await expect(engine.runSync()).rejects.toThrow("EACCES: permission denied");
            expect(remoteDeletedPaths).toEqual([]);
            expect(errorSpy).toHaveBeenCalledWith(
                "Failed to list directory RestrictedDir",
                permissionError
            );
        } finally {
            errorSpy.mockRestore();
        }
    });

    it("deduplicates cyclic folders via visitedLowerDirs and enforces MAX_WALK_DEPTH in walkLocal", async () => {
        const warnSpy = vi.spyOn(log, "warn").mockImplementation((): void => undefined);
        let listCalls: number = 0;
        const cyclicAdapter: Partial<DataAdapter> = {
            list: async (dir: string): Promise<ListedFiles> => {
                listCalls += 1;
                if (dir === "") {
                    return { files: [], folders: ["Cycle", "Cycle", "cycle"] };
                }
                if (dir === "Cycle") {
                    return {
                        files: ["Cycle/note.md", "Cycle/note.md", "Cycle/NOTE.md"],
                        folders: ["Cycle", "cycle"]
                    };
                }
                return { files: [], folders: [] };
            },
            stat: async (p: string): Promise<Stat | null> => ({
                ctime: 1000,
                mtime: 1000,
                size: p.endsWith(".md") ? 10 : 0,
                type: p.endsWith(".md") ? "file" : "folder"
            })
        };

        const cyclicEngine: SyncEngine = new SyncEngine(
            { adapter: cyclicAdapter as DataAdapter } as Vault,
            {} as WebDavClient,
            new SyncStateStore(cyclicAdapter as DataAdapter),
            {
                appPassword: "pw",
                chunkSizeMB: 10,
                chunkingThresholdMB: 90,
                conflictStrategy: "keep_both",
                remoteBaseDir: "Vault",
                syncInterval: 0,
                url: "https://cloud.example.com",
                username: "alice"
            }
        );

        try {
            const cyclicItems: LocalItem[] = await cyclicEngine.walkLocal();
            expect(listCalls).toBe(2);
            expect(cyclicItems.map((i: LocalItem) => i.path)).toEqual([
                "Cycle",
                "Cycle/note.md"
            ]);
            expect(warnSpy).toHaveBeenCalledWith(
                "Skipping case-colliding local folder: cycle (collides with Cycle)"
            );
            expect(warnSpy).toHaveBeenCalledWith(
                "Skipping case-colliding local file: Cycle/NOTE.md (collides with Cycle/note.md)"
            );
        } finally {
            warnSpy.mockRestore();
        }

        const deepAdapter: Partial<DataAdapter> = {
            list: async (dir: string): Promise<ListedFiles> => {
                const child: string = dir === "" ? "d" : `${dir}/d`;
                return { files: [], folders: [child] };
            },
            stat: async (): Promise<Stat | null> => ({
                ctime: 1000,
                mtime: 1000,
                size: 0,
                type: "folder"
            })
        };

        const deepEngine: SyncEngine = new SyncEngine(
            { adapter: deepAdapter as DataAdapter } as Vault,
            {} as WebDavClient,
            new SyncStateStore(deepAdapter as DataAdapter),
            {
                appPassword: "pw",
                chunkSizeMB: 10,
                chunkingThresholdMB: 90,
                conflictStrategy: "keep_both",
                remoteBaseDir: "Vault",
                syncInterval: 0,
                url: "https://cloud.example.com",
                username: "alice"
            }
        );

        const deepItems: LocalItem[] = await deepEngine.walkLocal();
        expect(deepItems.length).toBe(64);
    });

    it("calls adapter.rmdir(path, false) in deleteLocalItem, refuses to trash directories containing excluded children, and rejects excluded paths", async () => {
        const rmdirCalls: Array<{ path: string; recursive: boolean }> = [];
        const trashCalls: string[] = [];

        const adapter: Partial<DataAdapter> = {
            exists: async (): Promise<boolean> => true,
            rmdir: async (path: string, recursive: boolean): Promise<void> => {
                rmdirCalls.push({ path, recursive });
                if (path === "NonEmptyDir" && !recursive) {
                    throw new Error("ENOTEMPTY: Directory not empty");
                }
            }
        };

        const engine: SyncEngine = new SyncEngine(
            { adapter: adapter as DataAdapter } as Vault,
            {} as WebDavClient,
            new SyncStateStore(adapter as DataAdapter),
            {
                appPassword: "pw",
                chunkSizeMB: 10,
                chunkingThresholdMB: 90,
                conflictStrategy: "keep_both",
                remoteBaseDir: "Vault",
                syncInterval: 0,
                url: "https://cloud.example.com",
                username: "alice"
            }
        );

        await engine.deleteLocalItem("EmptyDir", true);
        expect(rmdirCalls).toEqual([{ path: "EmptyDir", recursive: false }]);

        await expect(engine.deleteLocalItem("NonEmptyDir", true)).rejects.toThrow(
            "Directory not empty"
        );
        expect(rmdirCalls).toEqual([
            { path: "EmptyDir", recursive: false },
            { path: "NonEmptyDir", recursive: false }
        ]);

        await expect(engine.deleteLocalItem("..", true)).rejects.toThrow(
            /refused on invalid or excluded path/
        );
        await expect(
            engine.deleteLocalItem(".obsidian/plugins/vaultdav/data.json", false)
        ).rejects.toThrow(/refused on invalid or excluded path/);

        const trashAdapter: Partial<DataAdapter> = {
            exists: async (): Promise<boolean> => true,
            list: async (dir: string): Promise<ListedFiles> => {
                if (dir === "Subproject") {
                    return { files: [], folders: ["Subproject/.git"] };
                }
                if (dir === "HiddenFilesDir") {
                    return { files: ["HiddenFilesDir/.DS_Store"], folders: [] };
                }
                return { files: [], folders: [] };
            },
            trashLocal: async (path: string): Promise<void> => {
                trashCalls.push(path);
            }
        };

        const trashEngine: SyncEngine = new SyncEngine(
            { adapter: trashAdapter as DataAdapter } as Vault,
            {} as WebDavClient,
            new SyncStateStore(trashAdapter as DataAdapter),
            {
                appPassword: "pw",
                chunkSizeMB: 10,
                chunkingThresholdMB: 90,
                conflictStrategy: "keep_both",
                remoteBaseDir: "Vault",
                syncInterval: 0,
                url: "https://cloud.example.com",
                username: "alice"
            }
        );

        await expect(trashEngine.deleteLocalItem("Subproject", true)).rejects.toThrow(
            /ENOTEMPTY/
        );
        await expect(trashEngine.deleteLocalItem("HiddenFilesDir", true)).rejects.toThrow(
            /ENOTEMPTY/
        );
        expect(trashCalls).toEqual([]);

        await trashEngine.deleteLocalItem("TrulyEmptyDir", true);
        expect(trashCalls).toEqual(["TrulyEmptyDir"]);
    });

    it("guards against file/directory type confusion in buildSyncPlan", () => {
        const warnSpy = vi.spyOn(log, "warn").mockImplementation((): void => undefined);
        const t0: number = 1728928000000;

        try {
            const plan: SyncPlan = buildSyncPlan(
                [
                    makeLocal("ReplacedDirWithFile", t0, 0, false),
                    makeLocal("TypeConflict", t0, 20, false)
                ],
                [makeRemote("TypeConflict", t0, 0, "dir-etag", true)],
                {
                    ReplacedDirWithFile: makeState(
                        "ReplacedDirWithFile",
                        t0,
                        t0,
                        0,
                        "old-dir-etag",
                        true
                    )
                },
                t0
            );

            const byPath: Map<string, SyncAction> = new Map<string, SyncAction>(
                plan.actions.map((a: SyncAction) => [a.path, a])
            );

            expect(byPath.get("ReplacedDirWithFile")?.type).toBe("upload");
            expect(byPath.get("ReplacedDirWithFile")?.isDirectory).toBe(false);
            expect(byPath.get("TypeConflict")?.type).toBe("noop");
            expect(warnSpy).toHaveBeenCalledWith(
                "Skipping path with file/directory type conflict: TypeConflict"
            );
        } finally {
            warnSpy.mockRestore();
        }
    });

    it("registers planned conflictCopyPath in existingPaths so concurrent transfers cannot overwrite it while allowing the planned conflict to use it", async () => {
        const t1: number = Date.UTC(2026, 9, 14, 19, 0, 0);
        const textFiles: Map<string, string> = new Map<string, string>();
        const uploadedConflictPaths: string[] = [];

        const localItems: LocalItem[] = [makeLocal("Note.md", t1, 10, false)];
        const remoteItems: RemoteItem[] = [
            makeRemote("Note.md", t1 + 1000, 20, "etag-remote", false)
        ];

        const plan: SyncPlan = buildSyncPlan(localItems, remoteItems, {}, t1);
        const plannedAction: SyncAction | undefined = plan.actions.find(
            (a: SyncAction) => a.path === "Note.md" && a.type === "conflict"
        );
        const reservedConflictPath: string = "Note.conflict-20261014-190000.md";
        expect(plannedAction?.conflictCopyPath).toBe(reservedConflictPath);

        // Prepend an unreserved concurrent conflict action for the same base file
        plan.actions.unshift({
            depth: 0,
            isDirectory: false,
            path: "Note.md",
            type: "conflict"
        });

        const adapter: Partial<DataAdapter> = {
            exists: async (p: string): Promise<boolean> =>
                textFiles.has(p) || !p.endsWith("sync-state.json"),
            read: async (p: string): Promise<string> => textFiles.get(p) ?? "",
            readBinary: async (): Promise<ArrayBuffer> =>
                new TextEncoder().encode("local-data").buffer,
            stat: async (): Promise<Stat | null> => ({
                ctime: t1,
                mtime: t1,
                size: 10,
                type: "file"
            }),
            write: async (p: string, d: string): Promise<void> => {
                textFiles.set(p, d);
            },
            writeBinary: async (): Promise<void> => undefined
        };

        const mockClient: Partial<WebDavClient> = {
            downloadFile: async (): Promise<ArrayBuffer> =>
                new TextEncoder().encode("remote-data").buffer,
            uploadFile: async (
                p: string,
                content: ArrayBuffer,
                mtime: number
            ): Promise<RemoteItem> => {
                uploadedConflictPaths.push(p);
                return makeRemote(p, mtime, content.byteLength, `etag-${p}`);
            }
        };

        const stateStore: SyncStateStore = new SyncStateStore(adapter as DataAdapter);
        await stateStore.load();
        const engine: SyncEngine = new SyncEngine(
            { adapter: adapter as DataAdapter } as Vault,
            mockClient as WebDavClient,
            stateStore,
            {
                appPassword: "pw",
                chunkSizeMB: 10,
                chunkingThresholdMB: 90,
                conflictStrategy: "keep_both",
                remoteBaseDir: "Vault",
                syncInterval: 0,
                url: "https://cloud.example.com",
                username: "alice"
            }
        );

        let initialHasReservedPath: boolean = false;
        const originalExecuteConflict = engine.executeConflict.bind(engine);
        vi.spyOn(engine, "executeConflict").mockImplementation(
            async (
                action: SyncAction,
                localMap: ReadonlyMap<string, LocalItem>,
                remoteMap: ReadonlyMap<string, RemoteItem>,
                existingPaths: Set<string>,
                now: number
            ): Promise<void> => {
                if (existingPaths.has(reservedConflictPath)) {
                    initialHasReservedPath = true;
                }
                await originalExecuteConflict(
                    action,
                    localMap,
                    remoteMap,
                    existingPaths,
                    now
                );
            }
        );

        await engine.executePlan(plan, localItems, remoteItems);

        expect(initialHasReservedPath).toBe(true);
        expect(uploadedConflictPaths).toContain(reservedConflictPath);
        expect(uploadedConflictPaths).toContain("Note.conflict-20261014-190000-2.md");
    });

    it("selects standard vs chunked upload/download based on file size thresholds and reports real-time progress", async () => {
        const t0: number = Date.UTC(2026, 9, 14, 18, 0, 0);
        const hundredMb: number = 100 * 1024 * 1024;
        const eightMb: number = 8 * 1024 * 1024;
        const fakeLargeUploadBuffer: ArrayBuffer = Object.defineProperty(
            new ArrayBuffer(0),
            "byteLength",
            { value: hundredMb }
        );
        const fakeLargeDownloadBuffer: ArrayBuffer = Object.defineProperty(
            new ArrayBuffer(0),
            "byteLength",
            { value: eightMb }
        );

        const standardUploads: string[] = [];
        const chunkedUploads: string[] = [];
        const standardDownloads: string[] = [];
        const chunkedDownloads: Array<{ path: string; size: number }> = [];
        const reportedMessages: string[] = [];
        const textFiles: Map<string, string> = new Map<string, string>();

        const adapter: Partial<DataAdapter> = {
            exists: async (p: string): Promise<boolean> => textFiles.has(p),
            mkdir: async (): Promise<void> => undefined,
            read: async (p: string): Promise<string> => textFiles.get(p) ?? "",
            readBinary: async (p: string): Promise<ArrayBuffer> => {
                if (p === "HugeLocal.zip") {
                    return fakeLargeUploadBuffer;
                }
                return new Uint8Array([1, 2, 3]).buffer;
            },
            stat: async (p: string): Promise<Stat | null> => ({
                ctime: t0,
                mtime: t0,
                size:
                    p === "HugeLocal.zip"
                        ? hundredMb
                        : p === "LargeRemote.mov"
                          ? eightMb
                          : 3,
                type: "file"
            }),
            write: async (p: string, d: string): Promise<void> => {
                textFiles.set(p, d);
            },
            writeBinary: async (): Promise<void> => undefined
        };

        const mockClient: Partial<WebDavClient> = {
            downloadFile: async (p: string): Promise<ArrayBuffer> => {
                standardDownloads.push(p);
                return new Uint8Array([4, 5, 6]).buffer;
            },
            downloadFileChunked: async (
                p: string,
                totalSize: number,
                onProgress?: (completed: number, total: number) => void
            ): Promise<ArrayBuffer> => {
                chunkedDownloads.push({ path: p, size: totalSize });
                onProgress?.(1, 2);
                onProgress?.(2, 2);
                return fakeLargeDownloadBuffer;
            },
            uploadFile: async (
                p: string,
                content: ArrayBuffer,
                mtime: number
            ): Promise<RemoteItem> => {
                standardUploads.push(p);
                return makeRemote(p, mtime, content.byteLength, `etag-${p}`);
            },
            uploadFileChunked: async (
                p: string,
                content: ArrayBuffer,
                mtime: number,
                onProgress?: (completed: number, total: number) => void
            ): Promise<RemoteItem> => {
                chunkedUploads.push(p);
                onProgress?.(1, 10);
                onProgress?.(5, 10);
                onProgress?.(10, 10);
                return makeRemote(p, mtime, content.byteLength, `etag-chunked-${p}`);
            }
        };

        const stateStore: SyncStateStore = new SyncStateStore(adapter as DataAdapter);
        await stateStore.load();

        const localItems: LocalItem[] = [
            makeLocal("HugeLocal.zip", t0, hundredMb, false),
            makeLocal("SmallLocal.md", t0, 3, false)
        ];
        const remoteItems: RemoteItem[] = [
            makeRemote("LargeRemote.mov", t0, eightMb, "etag-large-remote", false),
            makeRemote("SmallRemote.md", t0, 3, "etag-small-remote", false)
        ];

        const plan: SyncPlan = buildSyncPlan(localItems, remoteItems, {}, t0);
        const engine: SyncEngine = new SyncEngine(
            { adapter: adapter as DataAdapter } as Vault,
            mockClient as WebDavClient,
            stateStore,
            {
                appPassword: "pw",
                chunkSizeMB: 10,
                chunkingThresholdMB: 90,
                conflictStrategy: "keep_both",
                remoteBaseDir: "Vault",
                syncInterval: 0,
                url: "https://cloud.example.com",
                username: "alice"
            },
            {
                reportProgress: (msg: string): void => {
                    reportedMessages.push(msg);
                }
            }
        );

        const result = await engine.executePlan(plan, localItems, remoteItems);
        expect(result.errors).toEqual([]);
        expect(result.uploaded).toBe(2);
        expect(result.downloaded).toBe(2);
        expect(standardUploads).toEqual(["SmallLocal.md"]);
        expect(chunkedUploads).toEqual(["HugeLocal.zip"]);
        expect(standardDownloads).toEqual(["SmallRemote.md"]);
        expect(chunkedDownloads).toEqual([{ path: "LargeRemote.mov", size: eightMb }]);
        expect(
            reportedMessages.some((m: string) =>
                /^Uploading HugeLocal\.zip \(5\/10 · file \d+\/4\)$/.test(m)
            )
        ).toBe(true);
        expect(
            reportedMessages.some((m: string) =>
                /^Downloading LargeRemote\.mov \(2\/2 · file \d+\/4\)$/.test(m)
            )
        ).toBe(true);
    });

    it("prevents infinite PUT upload loops by persisting normalized ETag and second-precision mtime after upload", async () => {
        const subSecondLocalMtime: number = 1728928291789;
        const serverSecondMtime: number = 1728928291000;
        const textFiles: Map<string, string> = new Map<string, string>();
        let putCount: number = 0;

        const adapter: Partial<DataAdapter> = {
            exists: async (p: string): Promise<boolean> => textFiles.has(p),
            mkdir: async (): Promise<void> => undefined,
            read: async (p: string): Promise<string> => textFiles.get(p) ?? "",
            readBinary: async (): Promise<ArrayBuffer> => new Uint8Array([1, 2, 3, 4]).buffer,
            write: async (p: string, d: string): Promise<void> => {
                textFiles.set(p, d);
            }
        };

        const mockClient: Partial<WebDavClient> = {
            createDirectory: async (): Promise<void> => undefined,
            uploadFile: async (
                p: string,
                content: ArrayBuffer,
                _mtime: number
            ): Promise<RemoteItem> => {
                putCount += 1;
                return makeRemote(
                    p,
                    serverSecondMtime,
                    content.byteLength,
                    'W/"server-etag-1"'
                );
            }
        };

        const stateStore: SyncStateStore = new SyncStateStore(adapter as DataAdapter);
        await stateStore.load();

        const engine: SyncEngine = new SyncEngine(
            { adapter: adapter as DataAdapter } as Vault,
            mockClient as WebDavClient,
            stateStore,
            {
                appPassword: "pw",
                chunkSizeMB: 10,
                chunkingThresholdMB: 90,
                conflictStrategy: "keep_both",
                remoteBaseDir: "Vault",
                syncInterval: 0,
                url: "https://cloud.example.com",
                username: "alice"
            }
        );

        const localItems: LocalItem[] = [
            makeLocal("Notes", subSecondLocalMtime, 0, true),
            makeLocal("Notes/LoopCheck.md", subSecondLocalMtime, 4, false)
        ];
        const firstPlan: SyncPlan = buildSyncPlan(
            localItems,
            [],
            stateStore.getAll(),
            subSecondLocalMtime
        );
        const firstResult = await engine.executePlan(firstPlan, localItems, []);
        expect(firstResult.uploaded).toBe(1);
        expect(putCount).toBe(1);

        const savedRecord: SyncStateRecord | undefined =
            stateStore.getRecord("Notes/LoopCheck.md");
        expect(savedRecord?.etag).toBe("server-etag-1");
        expect(savedRecord?.localMtime).toBe(serverSecondMtime);
        expect(savedRecord?.remoteMtime).toBe(serverSecondMtime);

        // Next sync cycle: local still has sub-second mtime (1728928291789), remote has second-precision mtime and normalized ETag
        const remoteItemsAfterUpload: RemoteItem[] = [
            makeRemote("Notes", serverSecondMtime, 0, "dir-etag", true),
            makeRemote("Notes/LoopCheck.md", serverSecondMtime, 4, "server-etag-1", false)
        ];
        const secondPlan: SyncPlan = buildSyncPlan(
            localItems,
            remoteItemsAfterUpload,
            stateStore.getAll(),
            subSecondLocalMtime + 5000
        );
        expect(secondPlan.actions).toEqual([
            {
                depth: 2,
                isDirectory: false,
                path: "Notes/LoopCheck.md",
                type: "noop"
            },
            {
                depth: 1,
                isDirectory: true,
                path: "Notes",
                type: "noop"
            }
        ]);

        const secondResult = await engine.executePlan(
            secondPlan,
            localItems,
            remoteItemsAfterUpload
        );
        expect(secondResult.uploaded).toBe(0);
        expect(putCount).toBe(1);
    });

    it("handles cross-platform case-sensitivity mismatches and case-colliding duplicates without ENOENT or false deletions", async () => {
        const warnSpy = vi.spyOn(log, "warn").mockImplementation((): void => undefined);
        const t0: number = Date.UTC(2026, 9, 14, 18, 0, 0);
        const t1: number = Date.UTC(2026, 9, 14, 19, 0, 0);

        try {
            // 1. Cross-source capitalization difference (local: "notes/daily.md", remote: "Notes/Daily.md", state: "NOTES/DAILY.MD")
            const localItems: LocalItem[] = [
                makeLocal("notes/daily.md", t0 + 500, 10, false),
                makeLocal("notes/modified-local.md", t1, 15, false),
                makeLocal("notes/LocalDup.md", t0, 12, false),
                makeLocal("notes/localdup.md", t0, 14, false)
            ];
            const remoteItems: RemoteItem[] = [
                makeRemote("Notes/Daily.md", t0, 10, "etag-daily", false),
                makeRemote("Notes/Modified-Local.md", t0, 10, "etag-mod", false),
                // Case-colliding sibling on remote (Linux server has both CaseCollide.md and casecollide.md)
                makeRemote("Notes/CaseCollide.md", t0, 20, "etag-cc-1", false),
                makeRemote("Notes/casecollide.md", t0, 25, "etag-cc-2", false)
            ];
            const stateRecords: Record<string, SyncStateRecord> = {
                "NOTES/DAILY.MD": makeState("NOTES/DAILY.MD", t0, t0, 10, "etag-daily", false),
                "NOTES/MODIFIED-LOCAL.MD": makeState(
                    "NOTES/MODIFIED-LOCAL.MD",
                    t0,
                    t0,
                    10,
                    "etag-mod",
                    false
                )
            };

            const plan: SyncPlan = buildSyncPlan(
                localItems,
                remoteItems,
                stateRecords,
                t1
            );

            // Should NOT produce delete_local or delete_remote for daily.md or modified-local.md
            const deleteActions: SyncAction[] = plan.actions.filter(
                (a: SyncAction) =>
                    a.type === "delete_local" || a.type === "delete_remote"
            );
            expect(deleteActions).toEqual([]);

            // Only one of CaseCollide.md / casecollide.md should be planned for download
            const collideActions: SyncAction[] = plan.actions.filter(
                (a: SyncAction) => a.path.toLowerCase() === "notes/casecollide.md"
            );
            expect(collideActions).toHaveLength(1);
            expect(collideActions[0]?.type).toBe("download");

            // Only one of LocalDup.md / localdup.md should be planned for upload
            const localCollideActions: SyncAction[] = plan.actions.filter(
                (a: SyncAction) => a.path.toLowerCase() === "notes/localdup.md"
            );
            expect(localCollideActions).toHaveLength(1);
            expect(localCollideActions[0]?.type).toBe("upload");
            expect(warnSpy).toHaveBeenCalledWith(
                "Skipping case-colliding local path: notes/localdup.md (collides with notes/LocalDup.md)"
            );
            expect(warnSpy).toHaveBeenCalledWith(
                "Skipping case-colliding remote path: Notes/casecollide.md (collides with Notes/CaseCollide.md)"
            );

            // 2. Execute plan with case-mismatched local/remote maps without ENOENT
            const textFiles: Map<string, string> = new Map<string, string>();
            const downloadedRemotePaths: string[] = [];
            const uploadedRemotePaths: string[] = [];

            const adapter: Partial<DataAdapter> = {
                exists: async (p: string): Promise<boolean> => textFiles.has(p),
                mkdir: async (): Promise<void> => undefined,
                read: async (p: string): Promise<string> => textFiles.get(p) ?? "",
                readBinary: async (p: string): Promise<ArrayBuffer> => {
                    if (
                        p === "notes/modified-local.md" ||
                        p === "notes/LocalDup.md"
                    ) {
                        return new Uint8Array([1, 2, 3, 4]).buffer;
                    }
                    throw new Error(`ENOENT: ${p}`);
                },
                stat: async (): Promise<Stat | null> => ({
                    ctime: t1,
                    mtime: t1,
                    size: 20,
                    type: "file"
                }),
                write: async (p: string, d: string): Promise<void> => {
                    textFiles.set(p, d);
                },
                writeBinary: async (): Promise<void> => undefined
            };

            const mockClient: Partial<WebDavClient> = {
                createDirectory: async (): Promise<void> => undefined,
                downloadFile: async (p: string): Promise<ArrayBuffer> => {
                    downloadedRemotePaths.push(p);
                    if (p === "Notes/CaseCollide.md") {
                        return new Uint8Array([9, 9]).buffer;
                    }
                    throw new Error(`404 Not Found: ${p}`);
                },
                uploadFile: async (
                    p: string,
                    content: ArrayBuffer,
                    mtime: number
                ): Promise<RemoteItem> => {
                    uploadedRemotePaths.push(p);
                    return makeRemote(p, mtime, content.byteLength, `etag-${p}`);
                }
            };

            const stateStore: SyncStateStore = new SyncStateStore(adapter as DataAdapter);
            await stateStore.load();
            for (const rec of Object.values(stateRecords)) {
                stateStore.upsertRecord(rec);
            }

            const engine: SyncEngine = new SyncEngine(
                { adapter: adapter as DataAdapter } as Vault,
                mockClient as WebDavClient,
                stateStore,
                {
                    appPassword: "pw",
                    chunkSizeMB: 10,
                    chunkingThresholdMB: 90,
                    conflictStrategy: "keep_both",
                    remoteBaseDir: "Vault",
                    syncInterval: 0,
                    url: "https://cloud.example.com",
                    username: "alice"
                }
            );

            const result = await engine.executePlan(plan, localItems, remoteItems);
            expect(result.errors).toEqual([]);
            expect(result.uploaded).toBe(2);
            expect(result.downloaded).toBe(1);
            expect(downloadedRemotePaths).toEqual(["Notes/CaseCollide.md"]);

            // State store must not contain duplicate case variants for modified-local.md
            const allStateKeys: string[] = Object.keys(stateStore.getAll()).filter(
                (k: string) => k.toLowerCase() === "notes/modified-local.md"
            );
            expect(allStateKeys).toHaveLength(1);
        } finally {
            warnSpy.mockRestore();
        }
    });

    it("normalizes conflictCopyPath and blocks case-insensitive or self-overwriting conflict copy collisions", async () => {
        const t1: number = Date.UTC(2026, 9, 14, 19, 0, 0);
        const writtenLocalPaths: string[] = [];
        const uploadedRemotePaths: string[] = [];
        const textFiles: Map<string, string> = new Map<string, string>();

        const adapter: Partial<DataAdapter> = {
            exists: async (p: string): Promise<boolean> => textFiles.has(p),
            mkdir: async (): Promise<void> => undefined,
            read: async (p: string): Promise<string> => textFiles.get(p) ?? "",
            readBinary: async (): Promise<ArrayBuffer> =>
                new TextEncoder().encode("local-conflict-data").buffer,
            stat: async (): Promise<Stat | null> => ({
                ctime: t1,
                mtime: t1,
                size: 19,
                type: "file"
            }),
            write: async (p: string, d: string): Promise<void> => {
                textFiles.set(p, d);
            },
            writeBinary: async (p: string): Promise<void> => {
                writtenLocalPaths.push(p);
            }
        };

        const mockClient: Partial<WebDavClient> = {
            downloadFile: async (): Promise<ArrayBuffer> =>
                new TextEncoder().encode("remote-conflict-data").buffer,
            uploadFile: async (
                p: string,
                content: ArrayBuffer,
                mtime: number
            ): Promise<RemoteItem> => {
                uploadedRemotePaths.push(p);
                return makeRemote(p, mtime, content.byteLength, `etag-${p}`);
            }
        };

        const stateStore: SyncStateStore = new SyncStateStore(adapter as DataAdapter);
        await stateStore.load();
        const engine: SyncEngine = new SyncEngine(
            { adapter: adapter as DataAdapter } as Vault,
            mockClient as WebDavClient,
            stateStore,
            {
                appPassword: "pw",
                chunkSizeMB: 10,
                chunkingThresholdMB: 90,
                conflictStrategy: "keep_both",
                remoteBaseDir: "Vault",
                syncInterval: 0,
                url: "https://cloud.example.com",
                username: "alice"
            }
        );

        const localItems: LocalItem[] = [
            makeLocal("Notes/Doc.md", t1, 19, false),
            makeLocal("notes/existing.md", t1, 10, false)
        ];
        const remoteItems: RemoteItem[] = [
            makeRemote("Notes/Doc.md", t1 + 1000, 20, "etag-doc", false),
            makeRemote("notes/existing.md", t1, 10, "etag-existing", false)
        ];

        const localMap: Map<string, LocalItem> = new Map<string, LocalItem>(
            localItems.map((item: LocalItem) => [item.path, item])
        );
        const remoteMap: Map<string, RemoteItem> = new Map<string, RemoteItem>(
            remoteItems.map((item: RemoteItem) => [item.path, item])
        );

        // 1. Direct executeConflict with unnormalized leading-slash path that case-collides with "notes/existing.md"
        const existingSet: Set<string> = new Set<string>(["notes/existing.md"]);
        await engine.executeConflict(
            {
                conflictCopyPath: "/Notes/Existing.md",
                depth: 2,
                isDirectory: false,
                path: "Notes/Doc.md",
                type: "conflict"
            },
            localMap,
            remoteMap,
            existingSet,
            t1
        );

        expect(writtenLocalPaths).not.toContain("/Notes/Existing.md");
        expect(writtenLocalPaths).not.toContain("Notes/Existing.md");
        expect(writtenLocalPaths).toContain("Notes/Doc.conflict-20261014-190000.md");

        // 2. Direct executeConflict with self-overwriting conflictCopyPath ("notes/doc.md") and empty existingPaths
        writtenLocalPaths.length = 0;
        uploadedRemotePaths.length = 0;
        await engine.executeConflict(
            {
                conflictCopyPath: "notes/doc.md",
                depth: 2,
                isDirectory: false,
                path: "Notes/Doc.md",
                type: "conflict"
            },
            localMap,
            remoteMap,
            new Set<string>(),
            t1
        );
        expect(uploadedRemotePaths).toEqual(["Notes/Doc.conflict-20261014-190000.md"]);

        // 3. executePlan with unnormalized conflictCopyPath ("/Notes\\CustomConflict.md") and duplicate case-colliding conflictCopyPath
        writtenLocalPaths.length = 0;
        uploadedRemotePaths.length = 0;
        const customPlan: SyncPlan = {
            actions: [
                {
                    conflictCopyPath: "  /Notes\\CustomConflict.md  ",
                    depth: 2,
                    isDirectory: false,
                    path: "Notes/Doc.md",
                    type: "conflict"
                },
                {
                    conflictCopyPath: "notes/customconflict.md",
                    depth: 2,
                    isDirectory: false,
                    path: "Notes/Doc.md",
                    type: "conflict"
                }
            ],
            timestamp: t1
        };

        await engine.executePlan(customPlan, localItems, remoteItems);
        expect(writtenLocalPaths).not.toContain("  /Notes\\CustomConflict.md  ");
        expect(uploadedRemotePaths).toContain("Notes/CustomConflict.md");
        expect(uploadedRemotePaths).toContain("Notes/Doc.conflict-20261014-190000.md");
        expect(uploadedRemotePaths).not.toContain("notes/customconflict.md");
    });

    it("enforces pre-flight 1 GB file size limits before readBinary/downloadContent and clamps chunkingThresholdMB", async () => {
        const t0: number = Date.UTC(2026, 9, 14, 18, 0, 0);
        const overOneGb: number = 1024 * 1024 * 1024 + 1;
        let readBinaryCalled: boolean = false;
        let writeBinaryCalled: boolean = false;
        let downloadCalled: boolean = false;
        const chunkedUploadPaths: string[] = [];

        const adapter: Partial<DataAdapter> = {
            exists: async (): Promise<boolean> => false,
            mkdir: async (): Promise<void> => undefined,
            read: async (): Promise<string> => "",
            readBinary: async (p: string): Promise<ArrayBuffer> => {
                if (p === "950MB.bin") {
                    return Object.defineProperty(new ArrayBuffer(0), "byteLength", {
                        value: 950 * 1024 * 1024
                    });
                }
                readBinaryCalled = true;
                return Object.defineProperty(new ArrayBuffer(0), "byteLength", {
                    value: overOneGb
                });
            },
            stat: async (): Promise<Stat | null> => null,
            write: async (): Promise<void> => undefined,
            writeBinary: async (): Promise<void> => {
                writeBinaryCalled = true;
            }
        };

        const mockClient: Partial<WebDavClient> = {
            downloadFileChunked: async (): Promise<ArrayBuffer> => {
                downloadCalled = true;
                return new ArrayBuffer(0);
            },
            uploadFile: async (): Promise<RemoteItem> => {
                throw new Error("Should not route 950MB file to unchunked uploadFile");
            },
            uploadFileChunked: async (
                p: string,
                content: ArrayBuffer,
                mtime: number
            ): Promise<RemoteItem> => {
                chunkedUploadPaths.push(p);
                return makeRemote(p, mtime, content.byteLength, "etag-chunked");
            }
        };

        const stateStore: SyncStateStore = new SyncStateStore(adapter as DataAdapter);
        const engine: SyncEngine = new SyncEngine(
            { adapter: adapter as DataAdapter } as Vault,
            mockClient as WebDavClient,
            stateStore,
            {
                appPassword: "pw",
                chunkSizeMB: 10,
                chunkingThresholdMB: 5000,
                conflictStrategy: "keep_both",
                remoteBaseDir: "Vault",
                syncInterval: 0,
                url: "https://cloud.example.com",
                username: "alice"
            }
        );

        const oversizedLocalMap: Map<string, LocalItem> = new Map<string, LocalItem>([
            ["Huge.iso", makeLocal("Huge.iso", t0, overOneGb, false)]
        ]);
        const oversizedRemoteMap: Map<string, RemoteItem> = new Map<string, RemoteItem>([
            ["Huge.iso", makeRemote("Huge.iso", t0 + 1000, overOneGb, "etag-huge", false)]
        ]);

        await expect(
            engine.executeUpload("Huge.iso", oversizedLocalMap, t0)
        ).rejects.toThrow(/oversized/i);
        expect(readBinaryCalled).toBe(false);

        await expect(
            engine.executeDownload("Huge.iso", oversizedRemoteMap, t0)
        ).rejects.toThrow(/oversized/i);
        expect(downloadCalled).toBe(false);
        expect(writeBinaryCalled).toBe(false);

        await expect(
            engine.executeConflict(
                {
                    depth: 1,
                    isDirectory: false,
                    path: "Huge.iso",
                    type: "conflict"
                },
                oversizedLocalMap,
                oversizedRemoteMap,
                new Set<string>(),
                t0
            )
        ).rejects.toThrow(/oversized/i);
        expect(readBinaryCalled).toBe(false);
        expect(downloadCalled).toBe(false);

        // Even if localMap reports 0 bytes, post-readBinary guard blocks oversized buffer
        const spoofedLocalMap: Map<string, LocalItem> = new Map<string, LocalItem>([
            ["Spoofed.iso", makeLocal("Spoofed.iso", t0, 10, false)]
        ]);
        await expect(
            engine.executeUpload("Spoofed.iso", spoofedLocalMap, t0)
        ).rejects.toThrow(/oversized/i);
        expect(readBinaryCalled).toBe(true);
    });

    it("hardens executePlan against NaN/inverted depth, child deletion failure before parent rmdir, and excluded remote actions", async () => {
        const errorSpy = vi.spyOn(log, "error").mockImplementation((): void => undefined);
        const t0: number = Date.UTC(2026, 9, 14, 18, 0, 0);
        const operationLog: string[] = [];
        const textFiles: Map<string, string> = new Map<string, string>();

        const adapter: Partial<DataAdapter> = {
            exists: async (p: string): Promise<boolean> => textFiles.has(p),
            mkdir: async (p: string): Promise<void> => {
                operationLog.push(`local:mkdir:${p}`);
            },
            read: async (p: string): Promise<string> => textFiles.get(p) ?? "",
            write: async (p: string, d: string): Promise<void> => {
                textFiles.set(p, d);
            }
        };

        const mockClient: Partial<WebDavClient> = {
            createDirectory: async (p: string): Promise<void> => {
                operationLog.push(`remote:mkdir:${p}`);
            },
            deleteItem: async (p: string, isDir: boolean): Promise<void> => {
                if (p === "KeepParentOnFail/Sub/Locked.md") {
                    throw new Error("423 Locked");
                }
                operationLog.push(`remote:delete:${isDir ? "dir" : "file"}:${p}`);
            }
        };

        const stateStore: SyncStateStore = new SyncStateStore(adapter as DataAdapter);
        await stateStore.load();
        const engine: SyncEngine = new SyncEngine(
            { adapter: adapter as DataAdapter } as Vault,
            mockClient as WebDavClient,
            stateStore,
            {
                appPassword: "pw",
                chunkSizeMB: 10,
                chunkingThresholdMB: 90,
                conflictStrategy: "keep_both",
                remoteBaseDir: "Vault",
                syncInterval: 0,
                url: "https://cloud.example.com",
                username: "alice"
            }
        );

        try {
            const malformedPlan: SyncPlan = {
                actions: [
                    // 1. Unnormalized noop action should still match localMap/remoteMap and seed state
                    {
                        depth: Number.NaN,
                        isDirectory: false,
                        path: "  /SeededNoop.md  ",
                        type: "noop"
                    },
                    // 2. NaN and inverted depths on directory creations (child listed first with smaller depth)
                    {
                        depth: 1,
                        isDirectory: true,
                        path: "ParentDir/ChildDir",
                        type: "create_remote_dir"
                    },
                    {
                        depth: Number.NaN,
                        isDirectory: true,
                        path: "ParentDir",
                        type: "create_remote_dir"
                    },
                    // 3. Inverted depths on directory deletions + child file deletion failure
                    {
                        depth: 10,
                        isDirectory: true,
                        path: "CleanDelete",
                        type: "delete_remote"
                    },
                    {
                        depth: Number.NaN,
                        isDirectory: true,
                        path: "CleanDelete/Sub",
                        type: "delete_remote"
                    },
                    {
                        depth: 2,
                        isDirectory: false,
                        path: "KeepParentOnFail/Sub/Locked.md",
                        type: "delete_remote"
                    },
                    {
                        depth: 2,
                        isDirectory: true,
                        path: "KeepParentOnFail/Sub",
                        type: "delete_remote"
                    },
                    {
                        depth: 1,
                        isDirectory: true,
                        path: "KeepParentOnFail",
                        type: "delete_remote"
                    },
                    // 4. Excluded or root paths on remote operations must be refused at engine boundary
                    {
                        depth: 1,
                        isDirectory: true,
                        path: "/",
                        type: "delete_remote"
                    },
                    {
                        depth: 3,
                        isDirectory: false,
                        path: ".obsidian/plugins/vaultdav/data.json",
                        type: "delete_remote"
                    }
                ],
                timestamp: Number.NaN
            };

            const result = await engine.executePlan(
                malformedPlan,
                [makeLocal("SeededNoop.md", t0, 12, false)],
                [makeRemote("SeededNoop.md", t0, 12, "etag-seed", false)]
            );

            expect(result.timestamp).toBe(0);
            expect(stateStore.getRecord("SeededNoop.md")?.etag).toBe("etag-seed");

            // ParentDir must be created before ParentDir/ChildDir despite NaN/inverted depth
            const createParentIdx: number = operationLog.indexOf("remote:mkdir:ParentDir");
            const createChildIdx: number = operationLog.indexOf(
                "remote:mkdir:ParentDir/ChildDir"
            );
            expect(createParentIdx).toBeGreaterThanOrEqual(0);
            expect(createChildIdx).toBeGreaterThan(createParentIdx);

            // CleanDelete/Sub must be deleted before CleanDelete despite NaN/inverted depth
            const delSubIdx: number = operationLog.indexOf(
                "remote:delete:dir:CleanDelete/Sub"
            );
            const delParentIdx: number = operationLog.indexOf(
                "remote:delete:dir:CleanDelete"
            );
            expect(delSubIdx).toBeGreaterThanOrEqual(0);
            expect(delParentIdx).toBeGreaterThan(delSubIdx);

            // KeepParentOnFail and KeepParentOnFail/Sub must NOT be deleted because child Locked.md failed
            expect(operationLog).not.toContain("remote:delete:dir:KeepParentOnFail/Sub");
            expect(operationLog).not.toContain("remote:delete:dir:KeepParentOnFail");

            // Root and excluded paths must never reach mockClient.deleteItem
            expect(operationLog).not.toContain("remote:delete:dir:/");
            expect(operationLog).not.toContain("remote:delete:dir:");
            expect(operationLog).not.toContain(
                "remote:delete:file:.obsidian/plugins/vaultdav/data.json"
            );
            expect(result.errors.length).toBeGreaterThanOrEqual(3);
        } finally {
            errorSpy.mockRestore();
        }
    });
});

