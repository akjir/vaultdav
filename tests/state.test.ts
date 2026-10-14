import type { DataAdapter } from "obsidian";
import { describe, expect, it } from "vitest";
import { SyncStateStore } from "../src/sync/state";
import type { SyncStateRecord } from "../src/types";
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
    it("initializes an empty state when the sync state file does not exist", async () => {
        const { adapter } = createMockAdapter();
        const store: SyncStateStore = new SyncStateStore(adapter);
        const data = await store.load();

        expect(data.version).toBe(1);
        expect(data.records).toEqual({});
        expect(store.getAll()).toEqual({});
    });

    it("upserts, persists, reloads, and removes SyncStateRecord entries", async () => {
        const { adapter, dirs, files } = createMockAdapter();
        const store: SyncStateStore = new SyncStateStore(adapter);
        await store.load();

        const record: SyncStateRecord = {
            etag: "etag-1",
            isDirectory: false,
            lastSyncTime: 1728928291000,
            localMtime: 1728928291456,
            path: "Notes/Daily.md",
            remoteMtime: 1728928291000,
            size: 120
        };

        store.upsertRecord(record);
        await store.save();

        expect(dirs.has(".obsidian")).toBe(true);
        expect(dirs.has(".obsidian/plugins")).toBe(true);
        expect(dirs.has(".obsidian/plugins/vaultdav")).toBe(true);
        expect(files.has(SYNC_STATE_FILE_PATH)).toBe(true);

        const reloadedStore: SyncStateStore = new SyncStateStore(adapter);
        await reloadedStore.load();
        expect(reloadedStore.getRecord("Notes/Daily.md")).toEqual(record);

        reloadedStore.removeRecord("Notes/Daily.md");
        await reloadedStore.save();
        expect(reloadedStore.getRecord("Notes/Daily.md")).toBeUndefined();
    });

    it("recovers gracefully when the persisted JSON is corrupted", async () => {
        const { adapter } = createMockAdapter({
            [SYNC_STATE_FILE_PATH]: "{ invalid json"
        });
        const store: SyncStateStore = new SyncStateStore(adapter);
        const data = await store.load();

        expect(data.version).toBe(1);
        expect(data.records).toEqual({});
    });

    it("rejects excluded or traversal paths and sanitizes non-finite or negative numbers", async () => {
        const rawJson: string = JSON.stringify({
            records: {
                "../traversal.md": {
                    etag: "bad",
                    isDirectory: false,
                    lastSyncTime: 100,
                    localMtime: 100,
                    path: "../traversal.md",
                    remoteMtime: 100,
                    size: 10
                },
                ".trash/deleted.md": {
                    etag: "trash",
                    isDirectory: false,
                    lastSyncTime: 100,
                    localMtime: 100,
                    path: ".trash/deleted.md",
                    remoteMtime: 100,
                    size: 10
                },
                "Notes/Valid.md": {
                    etag: "ok",
                    isDirectory: false,
                    lastSyncTime: -50,
                    localMtime: -10,
                    path: "Notes/Valid.md",
                    remoteMtime: -20,
                    size: -999
                }
            },
            version: 1
        });
        const { adapter } = createMockAdapter({
            [SYNC_STATE_FILE_PATH]: rawJson
        });
        const store: SyncStateStore = new SyncStateStore(adapter);
        await store.load();

        expect(store.getRecord("../traversal.md")).toBeUndefined();
        expect(store.getRecord(".trash/deleted.md")).toBeUndefined();
        expect(store.getRecord("Notes/Valid.md")).toEqual({
            etag: "ok",
            isDirectory: false,
            lastSyncTime: 0,
            localMtime: 0,
            path: "Notes/Valid.md",
            remoteMtime: 0,
            size: 0
        });

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
            etag: "ignored",
            isDirectory: false,
            lastSyncTime: 1000,
            localMtime: 1000,
            path: "../outside.md",
            remoteMtime: 1000,
            size: 5
        });
        expect(store.getRecord("../outside.md")).toBeUndefined();
    });
});
