import type { ListedFiles, Stat, Vault } from "obsidian";
import { log } from "../log";
import type {
    LocalItem,
    RemoteItem,
    SyncAction,
    SyncPlan,
    SyncResult,
    SyncStateRecord,
    VaultDavSettings
} from "../types";
import { util } from "../utilities";
import type { WebDavClient } from "../webdav/client";
import type { SyncStateStore } from "./state";

const TRANSFER_CONCURRENCY: number = 4;

export function buildSyncPlan(
    localItems: ReadonlyArray<LocalItem>,
    remoteItems: ReadonlyArray<RemoteItem>,
    stateRecords: Readonly<Record<string, SyncStateRecord>>,
    timestamp: number = Date.now()
): SyncPlan {
    const localMap: Map<string, LocalItem> = new Map<string, LocalItem>();
    const remoteMap: Map<string, RemoteItem> = new Map<string, RemoteItem>();
    const stateMap: Map<string, SyncStateRecord> = new Map<string, SyncStateRecord>();
    const directoryPaths: Set<string> = new Set<string>();
    const allPathsSet: Set<string> = new Set<string>();

    for (const item of localItems) {
        const norm: string = util.normalizeVaultPath(item.path);
        if (util.isExcludedPath(norm)) {
            continue;
        }
        localMap.set(norm, { ...item, path: norm });
        allPathsSet.add(norm);
        if (item.isDirectory) {
            directoryPaths.add(norm);
        }
        for (const ancestor of util.getFolderLevels(norm, false)) {
            allPathsSet.add(ancestor);
            directoryPaths.add(ancestor);
        }
    }

    for (const item of remoteItems) {
        const norm: string = util.normalizeVaultPath(item.path);
        if (util.isExcludedPath(norm)) {
            continue;
        }
        remoteMap.set(norm, { ...item, path: norm });
        allPathsSet.add(norm);
        if (item.isDirectory) {
            directoryPaths.add(norm);
        }
        for (const ancestor of util.getFolderLevels(norm, false)) {
            allPathsSet.add(ancestor);
            directoryPaths.add(ancestor);
        }
    }

    for (const [rawKey, record] of Object.entries(stateRecords)) {
        const norm: string = util.normalizeVaultPath(rawKey);
        if (util.isExcludedPath(norm)) {
            continue;
        }
        stateMap.set(norm, { ...record, path: norm });
        allPathsSet.add(norm);
        if (record.isDirectory) {
            directoryPaths.add(norm);
        }
    }

    const sortedPaths: string[] = Array.from(allPathsSet).sort(
        (a: string, b: string): number => {
            const depthDiff: number = util.getPathDepth(b) - util.getPathDepth(a);
            if (depthDiff !== 0) {
                return depthDiff;
            }
            const lenDiff: number = b.length - a.length;
            if (lenDiff !== 0) {
                return lenDiff;
            }
            return b.localeCompare(a);
        }
    );

    const existingPaths: Set<string> = new Set<string>(allPathsSet);
    const keptFolders: Set<string> = new Set<string>();
    const actions: SyncAction[] = [];

    const markParentKept = (path: string): void => {
        const parent: string = util.getParentPath(path);
        if (parent !== "") {
            keptFolders.add(parent);
        }
    };

    for (const path of sortedPaths) {
        const local: LocalItem | undefined = localMap.get(path);
        const remote: RemoteItem | undefined = remoteMap.get(path);
        const state: SyncStateRecord | undefined = stateMap.get(path);
        const depth: number = util.getPathDepth(path);
        const isDirectory: boolean =
            directoryPaths.has(path) ||
            Boolean(local?.isDirectory) ||
            Boolean(remote?.isDirectory) ||
            Boolean(state?.isDirectory);

        if (isDirectory) {
            if (keptFolders.has(path)) {
                markParentKept(path);
                if (local !== undefined && remote !== undefined) {
                    actions.push({ depth, isDirectory: true, path, type: "noop" });
                } else if (local !== undefined && remote === undefined) {
                    actions.push({
                        depth,
                        isDirectory: true,
                        path,
                        type: "create_remote_dir"
                    });
                } else if (local === undefined && remote !== undefined) {
                    actions.push({
                        depth,
                        isDirectory: true,
                        path,
                        type: "create_local_dir"
                    });
                } else {
                    actions.push({
                        depth,
                        isDirectory: true,
                        path,
                        type: "create_local_dir"
                    });
                    actions.push({
                        depth,
                        isDirectory: true,
                        path,
                        type: "create_remote_dir"
                    });
                }
            } else if (local !== undefined && remote !== undefined) {
                markParentKept(path);
                actions.push({ depth, isDirectory: true, path, type: "noop" });
            } else if (local !== undefined && remote === undefined) {
                if (state === undefined) {
                    markParentKept(path);
                    actions.push({
                        depth,
                        isDirectory: true,
                        path,
                        type: "create_remote_dir"
                    });
                } else {
                    actions.push({
                        depth,
                        isDirectory: true,
                        path,
                        type: "delete_local"
                    });
                }
            } else if (local === undefined && remote !== undefined) {
                if (state === undefined) {
                    markParentKept(path);
                    actions.push({
                        depth,
                        isDirectory: true,
                        path,
                        type: "create_local_dir"
                    });
                } else {
                    actions.push({
                        depth,
                        isDirectory: true,
                        path,
                        type: "delete_remote"
                    });
                }
            } else if (state !== undefined) {
                actions.push({
                    depth,
                    isDirectory: true,
                    path,
                    type: "prune_state"
                });
            }
            continue;
        }

        if (local === undefined && remote === undefined) {
            if (state !== undefined) {
                actions.push({
                    depth,
                    isDirectory: false,
                    path,
                    type: "prune_state"
                });
            }
            continue;
        }

        if (local !== undefined && remote !== undefined) {
            markParentKept(path);
            if (state !== undefined) {
                const localMod: boolean = isLocalModified(local, state);
                const remoteMod: boolean = isRemoteModified(remote, state);

                if (!localMod && !remoteMod) {
                    actions.push({ depth, isDirectory: false, path, type: "noop" });
                } else if (localMod && !remoteMod) {
                    actions.push({ depth, isDirectory: false, path, type: "upload" });
                } else if (!localMod && remoteMod) {
                    actions.push({ depth, isDirectory: false, path, type: "download" });
                } else if (isMetadataEqual(local, remote)) {
                    actions.push({ depth, isDirectory: false, path, type: "noop" });
                } else {
                    const conflictCopyPath: string = util.getConflictPath(
                        path,
                        timestamp,
                        existingPaths
                    );
                    existingPaths.add(conflictCopyPath);
                    actions.push({
                        conflictCopyPath,
                        depth,
                        isDirectory: false,
                        path,
                        type: "conflict"
                    });
                }
            } else if (isMetadataEqual(local, remote)) {
                actions.push({ depth, isDirectory: false, path, type: "noop" });
            } else {
                const conflictCopyPath: string = util.getConflictPath(
                    path,
                    timestamp,
                    existingPaths
                );
                existingPaths.add(conflictCopyPath);
                actions.push({
                    conflictCopyPath,
                    depth,
                    isDirectory: false,
                    path,
                    type: "conflict"
                });
            }
            continue;
        }

        if (local !== undefined && remote === undefined) {
            if (state === undefined) {
                markParentKept(path);
                actions.push({ depth, isDirectory: false, path, type: "upload" });
            } else if (!isLocalModified(local, state)) {
                actions.push({ depth, isDirectory: false, path, type: "delete_local" });
            } else {
                markParentKept(path);
                actions.push({ depth, isDirectory: false, path, type: "upload" });
            }
            continue;
        }

        if (local === undefined && remote !== undefined) {
            if (state === undefined) {
                markParentKept(path);
                actions.push({ depth, isDirectory: false, path, type: "download" });
            } else if (!isRemoteModified(remote, state)) {
                actions.push({ depth, isDirectory: false, path, type: "delete_remote" });
            } else {
                markParentKept(path);
                actions.push({ depth, isDirectory: false, path, type: "download" });
            }
        }
    }

    return {
        actions,
        timestamp
    };
}

export function isLocalModified(local: LocalItem, state: SyncStateRecord): boolean {
    if (local.size !== state.size) {
        return true;
    }
    return (
        util.toSecondPrecision(local.mtime) !==
        util.toSecondPrecision(state.localMtime)
    );
}

export function isMetadataEqual(local: LocalItem, remote: RemoteItem): boolean {
    return (
        local.size === remote.size &&
        util.toSecondPrecision(local.mtime) ===
            util.toSecondPrecision(remote.mtime)
    );
}

export function isRemoteModified(remote: RemoteItem, state: SyncStateRecord): boolean {
    if (remote.etag !== "" && state.etag !== "") {
        return remote.etag !== state.etag || remote.size !== state.size;
    }
    if (remote.size !== state.size) {
        return true;
    }
    return (
        util.toSecondPrecision(remote.mtime) !==
        util.toSecondPrecision(state.remoteMtime)
    );
}

export class SyncEngine {
    private readonly client: WebDavClient;
    private readonly settings: VaultDavSettings;
    private readonly stateStore: SyncStateStore;
    private readonly vault: Vault;

    public constructor(
        vault: Vault,
        client: WebDavClient,
        stateStore: SyncStateStore,
        settings: VaultDavSettings
    ) {
        this.vault = vault;
        this.client = client;
        this.stateStore = stateStore;
        this.settings = settings;
    }

    public async createLocalDirectory(path: string): Promise<void> {
        const levels: string[] = util.getFolderLevels(path, true);
        for (const folder of levels) {
            const exists: boolean = await this.vault.adapter.exists(folder);
            if (!exists) {
                await this.vault.adapter.mkdir(folder);
            }
        }
    }

    public async deleteLocalItem(path: string, isDirectory: boolean): Promise<void> {
        const exists: boolean = await this.vault.adapter.exists(path);
        if (!exists) {
            return;
        }
        if (typeof this.vault.adapter.trashLocal === "function") {
            await this.vault.adapter.trashLocal(path);
            return;
        }
        if (isDirectory) {
            await this.vault.adapter.rmdir(path, true);
        } else {
            await this.vault.adapter.remove(path);
        }
    }

    public async executeConflict(
        action: SyncAction,
        localMap: ReadonlyMap<string, LocalItem>,
        remoteMap: ReadonlyMap<string, RemoteItem>,
        existingPaths: Set<string>,
        now: number
    ): Promise<void> {
        const local: LocalItem | undefined = localMap.get(action.path);
        const remote: RemoteItem | undefined = remoteMap.get(action.path);
        if (local === undefined || remote === undefined) {
            return;
        }

        if (this.settings.conflictStrategy === "newest_wins") {
            if (
                util.toSecondPrecision(local.mtime) >=
                util.toSecondPrecision(remote.mtime)
            ) {
                await this.executeUpload(action.path, localMap, now);
            } else {
                await this.executeDownload(action.path, remoteMap, now);
            }
            return;
        }

        const [localBuffer, remoteBuffer]: [ArrayBuffer, ArrayBuffer] =
            await Promise.all([
                this.vault.adapter.readBinary(action.path),
                this.client.downloadFile(action.path)
            ]);

        if (
            localBuffer.byteLength === remoteBuffer.byteLength &&
            util.areArrayBuffersEqual(localBuffer, remoteBuffer)
        ) {
            this.stateStore.upsertRecord({
                etag: remote.etag,
                isDirectory: false,
                lastSyncTime: now,
                localMtime: local.mtime,
                path: action.path,
                remoteMtime: remote.mtime,
                size: remoteBuffer.byteLength
            });
            return;
        }

        const conflictPath: string =
            action.conflictCopyPath !== undefined &&
            !existingPaths.has(action.conflictCopyPath)
                ? action.conflictCopyPath
                : util.getConflictPath(action.path, now, existingPaths);
        existingPaths.add(conflictPath);

        const parentDir: string = util.getParentPath(conflictPath);
        if (parentDir !== "") {
            await this.createLocalDirectory(parentDir);
        }

        await this.vault.adapter.writeBinary(conflictPath, localBuffer, {
            ctime: local.ctime,
            mtime: local.mtime
        });
        const uploadedConflict: RemoteItem = await this.client.uploadFile(
            conflictPath,
            localBuffer,
            local.mtime
        );
        const conflictStat: Stat | null = await this.vault.adapter.stat(conflictPath);

        this.stateStore.upsertRecord({
            etag: uploadedConflict.etag,
            isDirectory: false,
            lastSyncTime: now,
            localMtime: conflictStat?.mtime ?? local.mtime,
            path: conflictPath,
            remoteMtime: uploadedConflict.mtime,
            size: localBuffer.byteLength
        });

        await this.vault.adapter.writeBinary(action.path, remoteBuffer, {
            mtime: remote.mtime
        });
        const mainStat: Stat | null = await this.vault.adapter.stat(action.path);

        this.stateStore.upsertRecord({
            etag: remote.etag,
            isDirectory: false,
            lastSyncTime: now,
            localMtime: mainStat?.mtime ?? remote.mtime,
            path: action.path,
            remoteMtime: remote.mtime,
            size: remoteBuffer.byteLength
        });
    }

    public async executeDownload(
        path: string,
        remoteMap: ReadonlyMap<string, RemoteItem>,
        now: number
    ): Promise<void> {
        const remote: RemoteItem | undefined = remoteMap.get(path);
        const content: ArrayBuffer = await this.client.downloadFile(path);
        const parentDir: string = util.getParentPath(path);
        if (parentDir !== "") {
            await this.createLocalDirectory(parentDir);
        }

        const targetMtime: number = remote?.mtime ?? now;
        await this.vault.adapter.writeBinary(path, content, {
            mtime: targetMtime
        });
        const localStat: Stat | null = await this.vault.adapter.stat(path);

        this.stateStore.upsertRecord({
            etag: remote?.etag ?? "",
            isDirectory: false,
            lastSyncTime: now,
            localMtime: localStat?.mtime ?? targetMtime,
            path,
            remoteMtime: targetMtime,
            size: content.byteLength
        });
    }

    public async executePlan(
        plan: SyncPlan,
        localItems: ReadonlyArray<LocalItem>,
        remoteItems: ReadonlyArray<RemoteItem>
    ): Promise<SyncResult> {
        const now: number = plan.timestamp;
        const localMap: Map<string, LocalItem> = new Map<string, LocalItem>(
            localItems.map((i: LocalItem) => [util.normalizeVaultPath(i.path), i])
        );
        const remoteMap: Map<string, RemoteItem> = new Map<string, RemoteItem>(
            remoteItems.map((i: RemoteItem) => [util.normalizeVaultPath(i.path), i])
        );
        const existingPaths: Set<string> = new Set<string>([
            ...localMap.keys(),
            ...remoteMap.keys()
        ]);

        const result: SyncResult = {
            conflictsResolved: 0,
            deletedLocal: 0,
            deletedRemote: 0,
            downloaded: 0,
            errors: [],
            timestamp: now,
            uploaded: 0
        };

        let stateDirty: boolean = false;
        for (const action of plan.actions) {
            if (action.type === "prune_state") {
                this.stateStore.removeRecord(action.path);
                stateDirty = true;
            } else if (action.type === "noop") {
                const existing: SyncStateRecord | undefined =
                    this.stateStore.getRecord(action.path);
                const local: LocalItem | undefined = localMap.get(action.path);
                const remote: RemoteItem | undefined = remoteMap.get(action.path);
                if (
                    existing === undefined &&
                    local !== undefined &&
                    remote !== undefined
                ) {
                    this.stateStore.upsertRecord({
                        etag: remote.etag,
                        isDirectory: action.isDirectory,
                        lastSyncTime: now,
                        localMtime: local.mtime,
                        path: action.path,
                        remoteMtime: remote.mtime,
                        size: action.isDirectory ? 0 : remote.size
                    });
                    stateDirty = true;
                }
            }
        }
        if (stateDirty) {
            await this.stateStore.save();
        }

        const dirCreations: SyncAction[] = plan.actions.filter(
            (a: SyncAction) =>
                a.type === "create_local_dir" || a.type === "create_remote_dir"
        );
        const dirDepthLevels: number[] = Array.from(
            new Set<number>(dirCreations.map((a: SyncAction) => a.depth))
        ).sort((a: number, b: number) => a - b);

        for (const level of dirDepthLevels) {
            const levelActions: SyncAction[] = dirCreations.filter(
                (a: SyncAction) => a.depth === level
            );
            const tasks: Array<() => Promise<void>> = levelActions.map(
                (action: SyncAction) => async (): Promise<void> => {
                    try {
                        if (action.type === "create_local_dir") {
                            await this.createLocalDirectory(action.path);
                        } else {
                            await this.client.createDirectory(action.path);
                        }
                        this.stateStore.upsertRecord({
                            etag: "",
                            isDirectory: true,
                            lastSyncTime: now,
                            localMtime: now,
                            path: action.path,
                            remoteMtime: now,
                            size: 0
                        });
                    } catch (err: unknown) {
                        const msg: string =
                            err instanceof Error ? err.message : String(err);
                        log.error(`Directory creation failed for ${action.path}: ${msg}`);
                        result.errors.push(`${action.path}: ${msg}`);
                    }
                }
            );
            await util.runConcurrent(tasks, TRANSFER_CONCURRENCY);
            await this.stateStore.save();
        }

        const fileDeletions: SyncAction[] = plan.actions.filter(
            (a: SyncAction) =>
                !a.isDirectory &&
                (a.type === "delete_local" || a.type === "delete_remote")
        );
        const fileDeleteTasks: Array<() => Promise<void>> = fileDeletions.map(
            (action: SyncAction) => async (): Promise<void> => {
                try {
                    if (action.type === "delete_local") {
                        await this.deleteLocalItem(action.path, false);
                        result.deletedLocal += 1;
                    } else {
                        await this.client.deleteItem(action.path, false);
                        result.deletedRemote += 1;
                    }
                    this.stateStore.removeRecord(action.path);
                } catch (err: unknown) {
                    const msg: string =
                        err instanceof Error ? err.message : String(err);
                    log.error(`File deletion failed for ${action.path}: ${msg}`);
                    result.errors.push(`${action.path}: ${msg}`);
                }
            }
        );
        if (fileDeleteTasks.length > 0) {
            await util.runConcurrent(fileDeleteTasks, TRANSFER_CONCURRENCY);
            await this.stateStore.save();
        }

        const dirDeletions: SyncAction[] = plan.actions.filter(
            (a: SyncAction) =>
                a.isDirectory &&
                (a.type === "delete_local" || a.type === "delete_remote")
        );
        const deleteDepthLevels: number[] = Array.from(
            new Set<number>(dirDeletions.map((a: SyncAction) => a.depth))
        ).sort((a: number, b: number) => b - a);

        for (const level of deleteDepthLevels) {
            const levelActions: SyncAction[] = dirDeletions.filter(
                (a: SyncAction) => a.depth === level
            );
            const tasks: Array<() => Promise<void>> = levelActions.map(
                (action: SyncAction) => async (): Promise<void> => {
                    try {
                        if (action.type === "delete_local") {
                            await this.deleteLocalItem(action.path, true);
                        } else {
                            await this.client.deleteItem(action.path, true);
                        }
                        this.stateStore.removeRecord(action.path);
                    } catch (err: unknown) {
                        const msg: string =
                            err instanceof Error ? err.message : String(err);
                        log.error(`Directory deletion failed for ${action.path}: ${msg}`);
                        result.errors.push(`${action.path}: ${msg}`);
                    }
                }
            );
            await util.runConcurrent(tasks, TRANSFER_CONCURRENCY);
            await this.stateStore.save();
        }

        const transfers: SyncAction[] = plan.actions.filter(
            (a: SyncAction) =>
                a.type === "upload" ||
                a.type === "download" ||
                a.type === "conflict"
        );
        const transferTasks: Array<() => Promise<void>> = transfers.map(
            (action: SyncAction) => async (): Promise<void> => {
                try {
                    if (action.type === "upload") {
                        await this.executeUpload(action.path, localMap, now);
                        result.uploaded += 1;
                    } else if (action.type === "download") {
                        await this.executeDownload(action.path, remoteMap, now);
                        result.downloaded += 1;
                    } else if (action.type === "conflict") {
                        await this.executeConflict(
                            action,
                            localMap,
                            remoteMap,
                            existingPaths,
                            now
                        );
                        result.conflictsResolved += 1;
                    }
                    await this.stateStore.save();
                } catch (err: unknown) {
                    const msg: string =
                        err instanceof Error ? err.message : String(err);
                    log.error(`Transfer failed for ${action.path}: ${msg}`);
                    result.errors.push(`${action.path}: ${msg}`);
                }
            }
        );
        if (transferTasks.length > 0) {
            await util.runConcurrent(transferTasks, TRANSFER_CONCURRENCY);
        }

        return result;
    }

    public async executeUpload(
        path: string,
        localMap: ReadonlyMap<string, LocalItem>,
        now: number
    ): Promise<void> {
        const local: LocalItem | undefined = localMap.get(path);
        const content: ArrayBuffer = await this.vault.adapter.readBinary(path);
        const localMtime: number = local?.mtime ?? now;
        const remoteItem: RemoteItem = await this.client.uploadFile(
            path,
            content,
            localMtime
        );

        this.stateStore.upsertRecord({
            etag: remoteItem.etag,
            isDirectory: false,
            lastSyncTime: now,
            localMtime,
            path,
            remoteMtime: remoteItem.mtime,
            size: content.byteLength
        });
    }

    public async runSync(): Promise<SyncResult> {
        await this.client.ensureRemoteBaseDir();
        const [stateData, remoteItems, localItems]: [
            { records: Record<string, SyncStateRecord> },
            RemoteItem[],
            LocalItem[]
        ] = await Promise.all([
            this.stateStore.load(),
            this.client.walkRemote(),
            this.walkLocal()
        ]);

        const plan: SyncPlan = buildSyncPlan(
            localItems,
            remoteItems,
            stateData.records,
            Date.now()
        );
        return await this.executePlan(plan, localItems, remoteItems);
    }

    public async walkLocal(): Promise<LocalItem[]> {
        const discovered: LocalItem[] = [];
        let queue: string[] = [""];

        while (queue.length > 0) {
            const currentBatch: string[] = queue;
            queue = [];

            const batchLists: ListedFiles[] = await util.runConcurrent(
                currentBatch.map(
                    (dirPath: string) => async (): Promise<ListedFiles> => {
                        return await this.vault.adapter.list(dirPath);
                    }
                ),
                TRANSFER_CONCURRENCY
            );

            for (const listed of batchLists) {
                for (const folderRaw of listed.folders) {
                    const folderPath: string = util.normalizeVaultPath(folderRaw);
                    if (util.isExcludedPath(folderPath)) {
                        continue;
                    }
                    const stat: Stat | null = await this.vault.adapter.stat(folderPath);
                    const mtime: number = stat?.mtime ?? 0;
                    const ctime: number = stat?.ctime ?? mtime;
                    discovered.push({
                        ctime,
                        isDirectory: true,
                        mtime,
                        path: folderPath,
                        size: 0
                    });
                    queue.push(folderPath);
                }

                for (const fileRaw of listed.files) {
                    const filePath: string = util.normalizeVaultPath(fileRaw);
                    if (util.isExcludedPath(filePath)) {
                        continue;
                    }
                    const stat: Stat | null = await this.vault.adapter.stat(filePath);
                    if (stat === null) {
                        continue;
                    }
                    const mtime: number = stat.mtime > 0 ? stat.mtime : stat.ctime;
                    discovered.push({
                        ctime: stat.ctime > 0 ? stat.ctime : mtime,
                        isDirectory: false,
                        mtime,
                        path: filePath,
                        size: stat.size > 0 ? stat.size : 0
                    });
                }
            }
        }

        return discovered;
    }
}
