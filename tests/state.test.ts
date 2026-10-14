import type { DataAdapter } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { SyncStateStore } from "../src/sync/state";
import type { SyncStateData, SyncStateRecord } from "../src/types";
import { SYNC_STATE_FILE_PATH } from "../src/utilities";

function createMockAdapter(initialFiles: Record<string, string> = {}): {
    adapter: DataAdapter;
    dirs: Set<string>;
    files: Map<string, string>;
} {
    const files: Map<string, string> = new Map<string, string>(
        Object.entries(initialFiles)
    );
    const dirs: Set<string> = new Set<string>();

    const adapter: Partial<DataAdapter> = {
        exists: async (normalizedPath: string): Promise<boolean> => {
            return files.has(normalizedPath) || dirs.has(normalizedPath);
        },
        mkdir: async (normalizedPath: string): Promise<void> => {
            dirs.add(normalizedPath);
        },
        read: async (normalizedPath: string): Promise<string> => {
            const val: string | undefined = files.get(normalizedPath);
            if (val === undefined) {
                throw new Error(`ENOENT: ${normalizedPath}`);
            }
            return val;
        },
        write: async (normalizedPath: string, data: string): Promise<void> => {
            files.set(normalizedPath, data);
        }
    };

    return {
        adapter: adapter as DataAdapter,
        dirs,
        files
    };
}

describe("SyncStateStore", () => {
    it("returns an empty state and defaults to version 1 when the file does not exist or is corrupted", async () => {
        const { adapter: missingAdapter } = createMockAdapter();
        const missingStore: SyncStateStore = new SyncStateStore(missingAdapter);
        const missingData: SyncStateData = await missingStore.load();

        expect(missingData.version).toBe(1);
        expect(missingData.records).toEqual({});
        expect(missingStore.getAll()).toEqual({});

        const { adapter: corruptedAdapter } = createMockAdapter({
            [SYNC_STATE_FILE_PATH]: "{ invalid json"
        });
        const corruptedStore: SyncStateStore = new SyncStateStore(corruptedAdapter);
        const corruptedData: SyncStateData = await corruptedStore.load();

        expect(corruptedData.version).toBe(1);
        expect(corruptedData.records).toEqual({});
        expect(corruptedStore.getAll()).toEqual({});

        const { adapter: malformedAdapter } = createMockAdapter({
            [SYNC_STATE_FILE_PATH]: JSON.stringify({ records: null, version: 99 })
        });
        const malformedStore: SyncStateStore = new SyncStateStore(malformedAdapter);
        const malformedData: SyncStateData = await malformedStore.load();

        expect(malformedData.version).toBe(1);
        expect(malformedData.records).toEqual({});
    });

    it("deserializes valid records, sanitizes invalid fields, normalizes ETags, and skips excluded paths in load()", async () => {
        const rawJson: string =
            '{"version":1,"records":{' +
            '"../traversal.md":{"etag":"bad","isDirectory":false,"lastSyncTime":100,"localMtime":100,"path":"../traversal.md","remoteMtime":100,"size":10},' +
            '".trash/deleted.md":{"etag":"trash","isDirectory":false,"lastSyncTime":100,"localMtime":100,"path":".trash/deleted.md","remoteMtime":100,"size":10},' +
            '".obsidian/workspace.json":{"etag":"ws","isDirectory":false,"lastSyncTime":100,"localMtime":100,"path":".obsidian/workspace.json","remoteMtime":100,"size":10},' +
            '"//Notes/Quoted.md":{"etag":"W/\\"etag-weak-123\\"","isDirectory":false,"lastSyncTime":1700000000000,"localMtime":1700000001000,"path":"Notes/Quoted.md","remoteMtime":1700000000000,"size":256},' +
            '"Notes/InvalidFields.md":{"etag":null,"isDirectory":1,"lastSyncTime":"not-a-number","localMtime":null,"path":"Notes/InvalidFields.md","remoteMtime":-20,"size":-999},' +
            '"Notes/PrimitiveEntry.md":"invalid-record"' +
            "}}";

        const { adapter } = createMockAdapter({
            [SYNC_STATE_FILE_PATH]: rawJson
        });
        const store: SyncStateStore = new SyncStateStore(adapter);
        const loaded: SyncStateData = await store.load();

        expect(loaded.version).toBe(1);
        expect(store.getRecord("../traversal.md")).toBeUndefined();
        expect(store.getRecord(".trash/deleted.md")).toBeUndefined();
        expect(store.getRecord(".obsidian/workspace.json")).toBeUndefined();
        expect(store.getRecord("Notes/PrimitiveEntry.md")).toBeUndefined();

        expect(store.getRecord("Notes/Quoted.md")).toEqual({
            etag: "etag-weak-123",
            isDirectory: false,
            lastSyncTime: 1700000000000,
            localMtime: 1700000001000,
            path: "Notes/Quoted.md",
            remoteMtime: 1700000000000,
            size: 256
        });

        expect(store.getRecord("Notes/InvalidFields.md")).toEqual({
            etag: "",
            isDirectory: true,
            lastSyncTime: 0,
            localMtime: 0,
            path: "Notes/InvalidFields.md",
            remoteMtime: 0,
            size: 0
        });
    });

    it("normalizes paths, applies defensive numeric bounds, and ignores excluded paths in upsertRecord()", () => {
        const { adapter } = createMockAdapter();
        const store: SyncStateStore = new SyncStateStore(adapter);

        store.upsertRecord({
            etag: "etag-norm",
            isDirectory: false,
            lastSyncTime: 1728928291000,
            localMtime: 1728928291456,
            path: "  //Notes//Daily.md/  ",
            remoteMtime: 1728928291000,
            size: 120
        });

        expect(store.getRecord("Notes/Daily.md")).toEqual({
            etag: "etag-norm",
            isDirectory: false,
            lastSyncTime: 1728928291000,
            localMtime: 1728928291456,
            path: "Notes/Daily.md",
            remoteMtime: 1728928291000,
            size: 120
        });
        expect(store.getRecord("//Notes/Daily.md/")).toEqual(
            store.getRecord("Notes/Daily.md")
        );

        store.upsertRecord({
            etag: "nan-record",
            isDirectory: false,
            lastSyncTime: Number.NaN,
            localMtime: Number.POSITIVE_INFINITY,
            path: "Notes/NaN.md",
            remoteMtime: -1,
            size: Number.NaN
        });
        expect(store.getRecord("Notes/NaN.md")).toEqual({
            etag: "nan-record",
            isDirectory: false,
            lastSyncTime: 0,
            localMtime: 0,
            path: "Notes/NaN.md",
            remoteMtime: 0,
            size: 0
        });

        store.upsertRecord({
            etag: "ignored-traversal",
            isDirectory: false,
            lastSyncTime: 1000,
            localMtime: 1000,
            path: "../outside.md",
            remoteMtime: 1000,
            size: 5
        });
        store.upsertRecord({
            etag: "ignored-trash",
            isDirectory: false,
            lastSyncTime: 1000,
            localMtime: 1000,
            path: ".trash/note.md",
            remoteMtime: 1000,
            size: 5
        });
        store.upsertRecord({
            etag: "ignored-empty",
            isDirectory: false,
            lastSyncTime: 1000,
            localMtime: 1000,
            path: "   /   ",
            remoteMtime: 1000,
            size: 5
        });

        expect(store.getRecord("../outside.md")).toBeUndefined();
        expect(store.getRecord(".trash/note.md")).toBeUndefined();
        expect(Object.keys(store.getAll())).toEqual([
            "Notes/Daily.md",
            "Notes/NaN.md"
        ]);
    });

    it("removes entries by normalized path in removeRecord() and clears all records in clear()", async () => {
        const { adapter } = createMockAdapter();
        const store: SyncStateStore = new SyncStateStore(adapter);

        store.upsertRecord({
            etag: "etag-1",
            isDirectory: false,
            lastSyncTime: 1000,
            localMtime: 1000,
            path: "Folder/FileA.md",
            remoteMtime: 1000,
            size: 10
        });
        store.upsertRecord({
            etag: "etag-2",
            isDirectory: false,
            lastSyncTime: 2000,
            localMtime: 2000,
            path: "Folder/FileB.md",
            remoteMtime: 2000,
            size: 20
        });

        store.removeRecord(" //Folder//FileA.md/ ");
        expect(store.getRecord("Folder/FileA.md")).toBeUndefined();
        expect(store.getRecord("Folder/FileB.md")).toBeDefined();

        await store.clear();
        expect(store.getAll()).toEqual({});
    });

    it("checks adapter.exists() only once in ensureParentDirectory() and caches via isParentDirEnsured", async () => {
        const { adapter, dirs } = createMockAdapter();
        const existsSpy = vi.spyOn(adapter, "exists");
        const mkdirSpy = vi.spyOn(adapter, "mkdir");
        const store: SyncStateStore = new SyncStateStore(adapter);

        await store.ensureParentDirectory();

        expect(existsSpy).toHaveBeenCalledTimes(3);
        expect(mkdirSpy).toHaveBeenCalledTimes(3);
        expect(dirs.has(".obsidian")).toBe(true);
        expect(dirs.has(".obsidian/plugins")).toBe(true);
        expect(dirs.has(".obsidian/plugins/vaultdav")).toBe(true);

        await store.ensureParentDirectory();
        await store.save();
        await store.save();

        expect(existsSpy).toHaveBeenCalledTimes(3);
        expect(mkdirSpy).toHaveBeenCalledTimes(3);
    });

    it("serializes concurrent save() calls sequentially without race conditions and writes compact JSON", async () => {
        const { adapter, files } = createMockAdapter();
        const store: SyncStateStore = new SyncStateStore(adapter);

        let activeWrites: number = 0;
        let maxConcurrentWrites: number = 0;
        const writeOrder: number[] = [];
        const writtenPayloads: string[] = [];

        let callIndex: number = 0;
        vi.spyOn(adapter, "write").mockImplementation(
            async (normalizedPath: string, data: string): Promise<void> => {
                callIndex += 1;
                const currentCall: number = callIndex;
                activeWrites += 1;
                if (activeWrites > maxConcurrentWrites) {
                    maxConcurrentWrites = activeWrites;
                }

                const delayMs: number = (6 - currentCall) * 5;
                await new Promise<void>((resolve: () => void) => {
                    setTimeout(resolve, delayMs);
                });

                writeOrder.push(currentCall);
                writtenPayloads.push(data);
                files.set(normalizedPath, data);
                activeWrites -= 1;
            }
        );

        const savePromises: Promise<void>[] = [];
        for (let i: number = 1; i <= 5; i += 1) {
            store.upsertRecord({
                etag: `etag-${i}`,
                isDirectory: false,
                lastSyncTime: i * 1000,
                localMtime: i * 1000,
                path: `Notes/File${i}.md`,
                remoteMtime: i * 1000,
                size: i * 10
            });
            savePromises.push(store.save());
        }

        await Promise.all(savePromises);

        expect(maxConcurrentWrites).toBe(1);
        expect(writeOrder).toEqual([1, 2, 3, 4, 5]);
        expect(writtenPayloads).toHaveLength(5);

        const finalSerialized: string = files.get(SYNC_STATE_FILE_PATH) ?? "";
        expect(finalSerialized.includes("\n")).toBe(false);

        const reloadedStore: SyncStateStore = new SyncStateStore(adapter);
        await reloadedStore.load();
        expect(Object.keys(reloadedStore.getAll())).toHaveLength(5);
    });
});
