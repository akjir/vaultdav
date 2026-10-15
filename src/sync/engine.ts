import type { ListedFiles, Stat, Vault } from "obsidian";
import { formatTransferProgress, log } from "../log";
import type {
    LocalItem,
    ProgressReporter,
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

export const MAX_FILE_SIZE_BYTES: number = util.MAX_FILE_SIZE_BYTES;

const BYTES_PER_MB: number = 1024 * 1024;
const DEFAULT_CHUNKING_THRESHOLD_MB: number = 90;
const MAX_CHUNKED_FILE_SIZE_BYTES: number = 1024 * 1024 * 1024;
const MAX_CHUNKING_THRESHOLD_MB: number = 1024;
const PARALLEL_DOWNLOAD_THRESHOLD_BYTES: number = 5 * 1024 * 1024;
const TRANSFER_CONCURRENCY: number = 4;

export function buildSyncPlan(
    localItems: ReadonlyArray<LocalItem>,
    remoteItems: ReadonlyArray<RemoteItem>,
    stateRecords: Readonly<Record<string, SyncStateRecord>>,
    timestamp: number = Date.now()
): SyncPlan {
    const safeTimestamp: number =
        Number.isFinite(timestamp) && timestamp > 0 ? timestamp : 0;
    const canonicalPathByLower: Map<string, string> = new Map<string, string>();
    const localLowerMap: Map<string, string> = new Map<string, string>();
    const remoteLowerMap: Map<string, string> = new Map<string, string>();
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
        const lowerNorm: string = norm.toLowerCase();
        const existingLocalPath: string | undefined = localLowerMap.get(lowerNorm);
        if (existingLocalPath !== undefined) {
            if (existingLocalPath !== norm) {
                log.warn(
                    `Skipping case-colliding local path: ${norm} (collides with ${existingLocalPath})`
                );
            }
            continue;
        }
        localLowerMap.set(lowerNorm, norm);
        const canonical: string = canonicalPathByLower.get(lowerNorm) ?? norm;
        canonicalPathByLower.set(lowerNorm, canonical);
        localMap.set(canonical, { ...item, path: norm });
        allPathsSet.add(canonical);
        if (item.isDirectory) {
            directoryPaths.add(canonical);
        }
        for (const ancestor of util.getFolderLevels(canonical, false)) {
            const lowerAncestor: string = ancestor.toLowerCase();
            const canonicalAncestor: string =
                canonicalPathByLower.get(lowerAncestor) ?? ancestor;
            canonicalPathByLower.set(lowerAncestor, canonicalAncestor);
            allPathsSet.add(canonicalAncestor);
            directoryPaths.add(canonicalAncestor);
        }
    }

    for (const item of remoteItems) {
        const norm: string = util.normalizeVaultPath(item.path);
        if (util.isExcludedPath(norm)) {
            continue;
        }
        const lowerNorm: string = norm.toLowerCase();
        const existingRemotePath: string | undefined = remoteLowerMap.get(lowerNorm);
        if (existingRemotePath !== undefined) {
            if (existingRemotePath !== norm) {
                log.warn(
                    `Skipping case-colliding remote path: ${norm} (collides with ${existingRemotePath})`
                );
            }
            continue;
        }
        remoteLowerMap.set(lowerNorm, norm);
        const existingCanonical: string | undefined =
            canonicalPathByLower.get(lowerNorm);
        if (existingCanonical !== undefined && existingCanonical !== norm) {
            log.warn(
                `Case mismatch detected between local "${existingCanonical}" and remote "${norm}"`
            );
        }
        const canonical: string = existingCanonical ?? norm;
        canonicalPathByLower.set(lowerNorm, canonical);
        remoteMap.set(canonical, { ...item, path: norm });
        allPathsSet.add(canonical);
        if (item.isDirectory) {
            directoryPaths.add(canonical);
        }
        for (const ancestor of util.getFolderLevels(canonical, false)) {
            const lowerAncestor: string = ancestor.toLowerCase();
            const canonicalAncestor: string =
                canonicalPathByLower.get(lowerAncestor) ?? ancestor;
            canonicalPathByLower.set(lowerAncestor, canonicalAncestor);
            allPathsSet.add(canonicalAncestor);
            directoryPaths.add(canonicalAncestor);
        }
    }

    for (const [rawKey, record] of Object.entries(stateRecords)) {
        const norm: string = util.normalizeVaultPath(rawKey);
        if (util.isExcludedPath(norm)) {
            continue;
        }
        const lowerNorm: string = norm.toLowerCase();
        const canonical: string = canonicalPathByLower.get(lowerNorm) ?? norm;
        canonicalPathByLower.set(lowerNorm, canonical);
        stateMap.set(canonical, { ...record, path: canonical });
        allPathsSet.add(canonical);
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
            const canonicalParent: string =
                canonicalPathByLower.get(parent.toLowerCase()) ?? parent;
            keptFolders.add(canonicalParent);
        }
    };

    for (const path of sortedPaths) {
        const local: LocalItem | undefined = localMap.get(path);
        const remote: RemoteItem | undefined = remoteMap.get(path);
        const state: SyncStateRecord | undefined = stateMap.get(path);
        const depth: number = util.getPathDepth(path);

        if (
            (local !== undefined &&
                remote !== undefined &&
                local.isDirectory !== remote.isDirectory) ||
            (local !== undefined && !local.isDirectory && directoryPaths.has(path)) ||
            (remote !== undefined && !remote.isDirectory && directoryPaths.has(path))
        ) {
            log.warn(`Skipping path with file/directory type conflict: ${path}`);
            markParentKept(path);
            actions.push({
                depth,
                isDirectory: Boolean(local?.isDirectory || remote?.isDirectory),
                path,
                type: "noop"
            });
            continue;
        }

        const isDirectory: boolean =
            directoryPaths.has(path) ||
            Boolean(local?.isDirectory) ||
            Boolean(remote?.isDirectory) ||
            (local === undefined && remote === undefined && Boolean(state?.isDirectory));

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
                        safeTimestamp,
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
                    safeTimestamp,
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
        timestamp: safeTimestamp
    };
}

function hasCaseInsensitivePath(
    paths: ReadonlySet<string>,
    candidatePath: string
): boolean {
    if (paths.has(candidatePath)) {
        return true;
    }
    const lowerCandidate: string = candidatePath.toLowerCase();
    for (const existing of paths) {
        if (existing.toLowerCase() === lowerCandidate) {
            return true;
        }
    }
    return false;
}

export function isLocalModified(local: LocalItem, state: SyncStateRecord): boolean {
    if (local.isDirectory !== state.isDirectory || local.size !== state.size) {
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
    if (remote.isDirectory !== state.isDirectory) {
        return true;
    }
    const remoteEtag: string = util.normalizeEtag(remote.etag);
    const stateEtag: string = util.normalizeEtag(state.etag);
    if (remoteEtag !== "" && stateEtag !== "") {
        return remoteEtag !== stateEtag || remote.size !== state.size;
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
    private readonly planReservedConflictPaths: Set<string> = new Set<string>();
    private readonly progressReporter: ProgressReporter | null;
    private readonly settings: VaultDavSettings;
    private readonly stateStore: SyncStateStore;
    private readonly vault: Vault;

    public constructor(
        vault: Vault,
        client: WebDavClient,
        stateStore: SyncStateStore,
        settings: VaultDavSettings,
        progressReporter: ProgressReporter | null = null
    ) {
        this.vault = vault;
        this.client = client;
        this.stateStore = stateStore;
        this.settings = settings;
        this.progressReporter = progressReporter;
    }

    public async createLocalDirectory(path: string): Promise<void> {
        const normalizedPath: string = util.normalizeVaultPath(path);
        if (normalizedPath === "" || util.isExcludedPath(normalizedPath)) {
            throw new Error(`Local mkdir refused on invalid or excluded path: ${path}`);
        }
        const levels: string[] = util.getFolderLevels(normalizedPath, true);
        for (const folder of levels) {
            const exists: boolean = await this.vault.adapter.exists(folder);
            if (!exists) {
                await this.vault.adapter.mkdir(folder);
            }
        }
    }

    public async deleteLocalItem(path: string, isDirectory: boolean): Promise<void> {
        const normalizedPath: string = util.normalizeVaultPath(path);
        if (normalizedPath === "" || util.isExcludedPath(normalizedPath)) {
            throw new Error(`Local delete refused on invalid or excluded path: ${path}`);
        }
        const exists: boolean = await this.vault.adapter.exists(normalizedPath);
        if (!exists) {
            return;
        }
        if (isDirectory && typeof this.vault.adapter.list === "function") {
            const listed: ListedFiles = await this.vault.adapter.list(normalizedPath);
            if (listed.files.length > 0 || listed.folders.length > 0) {
                throw new Error(
                    `ENOTEMPTY: Local directory not empty: ${normalizedPath}`
                );
            }
        }
        if (typeof this.vault.adapter.trashLocal === "function") {
            await this.vault.adapter.trashLocal(normalizedPath);
            return;
        }
        if (isDirectory) {
            await this.vault.adapter.rmdir(normalizedPath, false);
        } else {
            await this.vault.adapter.remove(normalizedPath);
        }
    }

    private async downloadContent(
        remoteDownloadPath: string,
        progressLabelPath: string,
        remoteSize: number,
        fileIndex: number,
        totalFiles: number
    ): Promise<ArrayBuffer> {
        if (
            Number.isFinite(remoteSize) &&
            remoteSize > MAX_CHUNKED_FILE_SIZE_BYTES
        ) {
            throw new Error(
                `Download refused on oversized file (${remoteSize} bytes exceeds ${MAX_CHUNKED_FILE_SIZE_BYTES} bytes): ${progressLabelPath}`
            );
        }
        if (
            Number.isFinite(remoteSize) &&
            remoteSize > PARALLEL_DOWNLOAD_THRESHOLD_BYTES
        ) {
            const chunkedBuffer: ArrayBuffer =
                await this.client.downloadFileChunked(
                    remoteDownloadPath,
                    remoteSize,
                    (chunkIndex: number, totalChunks: number): void => {
                        if (this.progressReporter !== null) {
                            this.progressReporter.reportProgress(
                                formatTransferProgress(
                                    "Downloading",
                                    progressLabelPath,
                                    fileIndex,
                                    totalFiles,
                                    chunkIndex,
                                    totalChunks
                                )
                            );
                        }
                    }
                );
            if (chunkedBuffer.byteLength > MAX_CHUNKED_FILE_SIZE_BYTES) {
                throw new Error(
                    `Download refused on oversized file (${chunkedBuffer.byteLength} bytes exceeds ${MAX_CHUNKED_FILE_SIZE_BYTES} bytes): ${progressLabelPath}`
                );
            }
            return chunkedBuffer;
        }
        if (this.progressReporter !== null) {
            this.progressReporter.reportProgress(
                formatTransferProgress(
                    "Downloading",
                    progressLabelPath,
                    fileIndex,
                    totalFiles
                )
            );
        }
        const downloadedBuffer: ArrayBuffer =
            await this.client.downloadFile(remoteDownloadPath);
        if (downloadedBuffer.byteLength > MAX_CHUNKED_FILE_SIZE_BYTES) {
            throw new Error(
                `Download refused on oversized file (${downloadedBuffer.byteLength} bytes exceeds ${MAX_CHUNKED_FILE_SIZE_BYTES} bytes): ${progressLabelPath}`
            );
        }
        return downloadedBuffer;
    }

    public async executeConflict(
        action: SyncAction,
        localMap: ReadonlyMap<string, LocalItem>,
        remoteMap: ReadonlyMap<string, RemoteItem>,
        existingPaths: Set<string>,
        now: number,
        fileIndex: number = 1,
        totalFiles: number = 1
    ): Promise<void> {
        const normalizedPath: string = util.normalizeVaultPath(action.path);
        if (normalizedPath === "" || util.isExcludedPath(normalizedPath)) {
            throw new Error(
                `Conflict resolution refused on invalid or excluded path: ${action.path}`
            );
        }
        const local: LocalItem | undefined = localMap.get(normalizedPath);
        const remote: RemoteItem | undefined = remoteMap.get(normalizedPath);
        if (local === undefined || remote === undefined) {
            return;
        }
        if (local.isDirectory || remote.isDirectory) {
            throw new Error(
                `Conflict resolution refused on directory path: ${normalizedPath}`
            );
        }

        if (this.settings.conflictStrategy === "newest_wins") {
            if (
                util.toSecondPrecision(local.mtime) >=
                util.toSecondPrecision(remote.mtime)
            ) {
                await this.executeUpload(
                    normalizedPath,
                    localMap,
                    now,
                    fileIndex,
                    totalFiles
                );
            } else {
                await this.executeDownload(
                    normalizedPath,
                    remoteMap,
                    now,
                    fileIndex,
                    totalFiles
                );
            }
            return;
        }

        if (
            Number.isFinite(local.size) &&
            local.size > MAX_CHUNKED_FILE_SIZE_BYTES
        ) {
            throw new Error(
                `Conflict resolution refused on oversized local file (${local.size} bytes exceeds ${MAX_CHUNKED_FILE_SIZE_BYTES} bytes): ${normalizedPath}`
            );
        }
        if (
            Number.isFinite(remote.size) &&
            remote.size > MAX_CHUNKED_FILE_SIZE_BYTES
        ) {
            throw new Error(
                `Conflict resolution refused on oversized remote file (${remote.size} bytes exceeds ${MAX_CHUNKED_FILE_SIZE_BYTES} bytes): ${normalizedPath}`
            );
        }

        const localReadPath: string =
            util.normalizeVaultPath(local.path) || normalizedPath;
        const remoteDownloadPath: string =
            util.normalizeVaultPath(remote.path) || normalizedPath;

        const [localBuffer, remoteBuffer]: [ArrayBuffer, ArrayBuffer] =
            await Promise.all([
                this.vault.adapter.readBinary(localReadPath),
                this.downloadContent(
                    remoteDownloadPath,
                    normalizedPath,
                    remote.size,
                    fileIndex,
                    totalFiles
                )
            ]);

        if (
            localBuffer.byteLength > MAX_CHUNKED_FILE_SIZE_BYTES ||
            remoteBuffer.byteLength > MAX_CHUNKED_FILE_SIZE_BYTES
        ) {
            throw new Error(
                `Conflict resolution refused on oversized file buffer: ${normalizedPath}`
            );
        }

        if (
            localBuffer.byteLength === remoteBuffer.byteLength &&
            util.areArrayBuffersEqual(localBuffer, remoteBuffer)
        ) {
            this.stateStore.upsertRecord({
                etag: util.normalizeEtag(remote.etag),
                isDirectory: false,
                lastSyncTime: now,
                localMtime: util.toSecondPrecision(local.mtime),
                path: normalizedPath,
                remoteMtime: util.toSecondPrecision(remote.mtime),
                size: remoteBuffer.byteLength
            });
            return;
        }

        existingPaths.add(normalizedPath);
        const normalizedPlannedConflict: string =
            action.conflictCopyPath !== undefined
                ? util.normalizeVaultPath(action.conflictCopyPath)
                : "";
        const canUsePlannedConflictPath: boolean =
            normalizedPlannedConflict !== "" &&
            normalizedPlannedConflict.toLowerCase() !==
                normalizedPath.toLowerCase() &&
            !util.isExcludedPath(normalizedPlannedConflict) &&
            (this.planReservedConflictPaths.delete(normalizedPlannedConflict) ||
                !hasCaseInsensitivePath(existingPaths, normalizedPlannedConflict));
        const conflictPath: string = canUsePlannedConflictPath
            ? normalizedPlannedConflict
            : util.getConflictPath(normalizedPath, now, existingPaths);
        existingPaths.add(conflictPath);

        const parentDir: string = util.getParentPath(conflictPath);
        if (parentDir !== "") {
            await this.createLocalDirectory(parentDir);
        }

        const safeLocalMtime: number = util.toSecondPrecision(local.mtime);
        await this.vault.adapter.writeBinary(conflictPath, localBuffer, {
            ctime: local.ctime,
            mtime: safeLocalMtime
        });
        const uploadedConflict: RemoteItem = await this.uploadContent(
            conflictPath,
            localBuffer,
            safeLocalMtime,
            fileIndex,
            totalFiles
        );
        const conflictStat: Stat | null = await this.vault.adapter.stat(conflictPath);
        const resolvedConflictMtime: number =
            conflictStat !== null &&
            Number.isFinite(conflictStat.mtime) &&
            conflictStat.mtime > 0
                ? util.toSecondPrecision(conflictStat.mtime)
                : safeLocalMtime;

        this.stateStore.upsertRecord({
            etag: util.normalizeEtag(uploadedConflict.etag),
            isDirectory: false,
            lastSyncTime: now,
            localMtime: resolvedConflictMtime,
            path: conflictPath,
            remoteMtime: util.toSecondPrecision(uploadedConflict.mtime),
            size: localBuffer.byteLength
        });

        const safeRemoteMtime: number = util.toSecondPrecision(remote.mtime);
        await this.vault.adapter.writeBinary(normalizedPath, remoteBuffer, {
            mtime: safeRemoteMtime
        });
        const mainStat: Stat | null = await this.vault.adapter.stat(normalizedPath);
        const resolvedMainMtime: number =
            mainStat !== null && Number.isFinite(mainStat.mtime) && mainStat.mtime > 0
                ? util.toSecondPrecision(mainStat.mtime)
                : safeRemoteMtime;

        this.stateStore.upsertRecord({
            etag: util.normalizeEtag(remote.etag),
            isDirectory: false,
            lastSyncTime: now,
            localMtime: resolvedMainMtime,
            path: normalizedPath,
            remoteMtime: safeRemoteMtime,
            size: remoteBuffer.byteLength
        });
    }

    public async executeDownload(
        path: string,
        remoteMap: ReadonlyMap<string, RemoteItem>,
        now: number,
        fileIndex: number = 1,
        totalFiles: number = 1
    ): Promise<void> {
        const normalizedPath: string = util.normalizeVaultPath(path);
        if (normalizedPath === "" || util.isExcludedPath(normalizedPath)) {
            throw new Error(`Download refused on invalid or excluded path: ${path}`);
        }
        const remote: RemoteItem | undefined = remoteMap.get(normalizedPath);
        if (remote?.isDirectory === true) {
            throw new Error(`Download refused on directory path: ${normalizedPath}`);
        }
        const remoteDownloadPath: string =
            remote !== undefined
                ? util.normalizeVaultPath(remote.path) || normalizedPath
                : normalizedPath;
        const remoteSize: number =
            remote !== undefined && Number.isFinite(remote.size) ? remote.size : 0;
        const content: ArrayBuffer = await this.downloadContent(
            remoteDownloadPath,
            normalizedPath,
            remoteSize,
            fileIndex,
            totalFiles
        );
        const parentDir: string = util.getParentPath(normalizedPath);
        if (parentDir !== "") {
            await this.createLocalDirectory(parentDir);
        }

        const targetMtime: number = util.toSecondPrecision(remote?.mtime ?? now);
        await this.vault.adapter.writeBinary(normalizedPath, content, {
            mtime: targetMtime
        });
        const localStat: Stat | null = await this.vault.adapter.stat(normalizedPath);
        const resolvedLocalMtime: number =
            localStat !== null &&
            Number.isFinite(localStat.mtime) &&
            localStat.mtime > 0
                ? util.toSecondPrecision(localStat.mtime)
                : targetMtime;

        this.stateStore.upsertRecord({
            etag: util.normalizeEtag(remote?.etag),
            isDirectory: false,
            lastSyncTime: now,
            localMtime: resolvedLocalMtime,
            path: normalizedPath,
            remoteMtime: targetMtime,
            size: content.byteLength
        });
    }

    public async executePlan(
        plan: SyncPlan,
        localItems: ReadonlyArray<LocalItem>,
        remoteItems: ReadonlyArray<RemoteItem>
    ): Promise<SyncResult> {
        const now: number =
            Number.isFinite(plan.timestamp) && plan.timestamp > 0
                ? plan.timestamp
                : 0;
        const localMap: Map<string, LocalItem> = new Map<string, LocalItem>();
        const localLowerMap: Map<string, LocalItem> = new Map<string, LocalItem>();
        for (const item of localItems) {
            const norm: string = util.normalizeVaultPath(item.path);
            if (norm !== "") {
                localMap.set(norm, item);
                const lower: string = norm.toLowerCase();
                if (!localLowerMap.has(lower)) {
                    localLowerMap.set(lower, item);
                }
            }
        }
        const remoteMap: Map<string, RemoteItem> = new Map<string, RemoteItem>();
        const remoteLowerMap: Map<string, RemoteItem> = new Map<string, RemoteItem>();
        for (const item of remoteItems) {
            const norm: string = util.normalizeVaultPath(item.path);
            if (norm !== "") {
                remoteMap.set(norm, item);
                const lower: string = norm.toLowerCase();
                if (!remoteLowerMap.has(lower)) {
                    remoteLowerMap.set(lower, item);
                }
            }
        }
        for (const action of plan.actions) {
            const normActionPath: string = util.normalizeVaultPath(action.path);
            if (normActionPath === "") {
                continue;
            }
            const lowerActionPath: string = normActionPath.toLowerCase();
            if (!localMap.has(normActionPath)) {
                const matchedLocal: LocalItem | undefined =
                    localLowerMap.get(lowerActionPath);
                if (matchedLocal !== undefined) {
                    localMap.set(normActionPath, matchedLocal);
                }
            }
            if (!remoteMap.has(normActionPath)) {
                const matchedRemote: RemoteItem | undefined =
                    remoteLowerMap.get(lowerActionPath);
                if (matchedRemote !== undefined) {
                    remoteMap.set(normActionPath, matchedRemote);
                }
            }
        }

        this.planReservedConflictPaths.clear();
        const existingPaths: Set<string> = new Set<string>([
            ...localMap.keys(),
            ...remoteMap.keys()
        ]);
        for (const action of plan.actions) {
            if (action.conflictCopyPath !== undefined) {
                const normalizedConflict: string = util.normalizeVaultPath(
                    action.conflictCopyPath
                );
                if (
                    normalizedConflict !== "" &&
                    !util.isExcludedPath(normalizedConflict) &&
                    !hasCaseInsensitivePath(existingPaths, normalizedConflict)
                ) {
                    existingPaths.add(normalizedConflict);
                    this.planReservedConflictPaths.add(normalizedConflict);
                }
            }
        }

        const result: SyncResult = {
            conflictsResolved: 0,
            deletedLocal: 0,
            deletedRemote: 0,
            downloaded: 0,
            errors: [],
            timestamp: now,
            uploaded: 0
        };

        const protectedDeleteDirsLower: Set<string> = new Set<string>();
        const protectAncestors = (targetPath: string): void => {
            for (const ancestor of util.getFolderLevels(targetPath, false)) {
                protectedDeleteDirsLower.add(ancestor.toLowerCase());
            }
        };

        let stateDirty: boolean = false;
        for (const action of plan.actions) {
            const normActionPath: string = util.normalizeVaultPath(action.path);
            if (normActionPath === "" || util.isExcludedPath(normActionPath)) {
                continue;
            }
            if (
                action.type === "noop" ||
                action.type === "upload" ||
                action.type === "download" ||
                action.type === "conflict" ||
                action.type === "create_local_dir" ||
                action.type === "create_remote_dir"
            ) {
                protectAncestors(normActionPath);
            }
            if (action.type === "prune_state") {
                this.stateStore.removeRecord(normActionPath);
                stateDirty = true;
            } else if (action.type === "noop") {
                const existing: SyncStateRecord | undefined =
                    this.stateStore.getRecord(normActionPath);
                const local: LocalItem | undefined = localMap.get(normActionPath);
                const remote: RemoteItem | undefined = remoteMap.get(normActionPath);
                if (
                    existing === undefined &&
                    local !== undefined &&
                    remote !== undefined &&
                    local.isDirectory === remote.isDirectory
                ) {
                    this.stateStore.upsertRecord({
                        etag: util.normalizeEtag(remote.etag),
                        isDirectory: action.isDirectory,
                        lastSyncTime: now,
                        localMtime: util.toSecondPrecision(local.mtime),
                        path: normActionPath,
                        remoteMtime: util.toSecondPrecision(remote.mtime),
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
            new Set<number>(
                dirCreations.map((a: SyncAction) => util.getPathDepth(a.path))
            )
        ).sort((a: number, b: number) => a - b);

        for (const level of dirDepthLevels) {
            const levelActions: SyncAction[] = dirCreations.filter(
                (a: SyncAction) => util.getPathDepth(a.path) === level
            );
            const tasks: Array<() => Promise<void>> = levelActions.map(
                (action: SyncAction) => async (): Promise<void> => {
                    try {
                        const normalizedDir: string = util.normalizeVaultPath(
                            action.path
                        );
                        if (
                            normalizedDir === "" ||
                            util.isExcludedPath(normalizedDir)
                        ) {
                            throw new Error(
                                `Directory creation refused on invalid or excluded path: ${action.path}`
                            );
                        }
                        if (action.type === "create_local_dir") {
                            await this.createLocalDirectory(normalizedDir);
                        } else {
                            await this.client.createDirectory(normalizedDir);
                        }
                        this.stateStore.upsertRecord({
                            etag: "",
                            isDirectory: true,
                            lastSyncTime: now,
                            localMtime: util.toSecondPrecision(now),
                            path: normalizedDir,
                            remoteMtime: util.toSecondPrecision(now),
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
                const normalizedPath: string = util.normalizeVaultPath(action.path);
                try {
                    if (
                        normalizedPath === "" ||
                        util.isExcludedPath(normalizedPath)
                    ) {
                        throw new Error(
                            `File deletion refused on invalid or excluded path: ${action.path}`
                        );
                    }
                    if (action.type === "delete_local") {
                        await this.deleteLocalItem(normalizedPath, false);
                        result.deletedLocal += 1;
                    } else {
                        await this.client.deleteItem(normalizedPath, false);
                        result.deletedRemote += 1;
                    }
                    this.stateStore.removeRecord(normalizedPath);
                } catch (err: unknown) {
                    if (normalizedPath !== "") {
                        protectAncestors(normalizedPath);
                    }
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
            new Set<number>(
                dirDeletions.map((a: SyncAction) => util.getPathDepth(a.path))
            )
        ).sort((a: number, b: number) => b - a);

        for (const level of deleteDepthLevels) {
            const levelActions: SyncAction[] = dirDeletions.filter(
                (a: SyncAction) => util.getPathDepth(a.path) === level
            );
            const tasks: Array<() => Promise<void>> = levelActions.map(
                (action: SyncAction) => async (): Promise<void> => {
                    const normalizedDir: string = util.normalizeVaultPath(
                        action.path
                    );
                    try {
                        if (
                            normalizedDir === "" ||
                            util.isExcludedPath(normalizedDir)
                        ) {
                            throw new Error(
                                `Directory deletion refused on invalid or excluded path: ${action.path}`
                            );
                        }
                        if (
                            protectedDeleteDirsLower.has(
                                normalizedDir.toLowerCase()
                            )
                        ) {
                            throw new Error(
                                `Directory deletion aborted because child item remains in ${normalizedDir}`
                            );
                        }
                        if (action.type === "delete_local") {
                            await this.deleteLocalItem(normalizedDir, true);
                        } else {
                            await this.client.deleteItem(normalizedDir, true);
                        }
                        this.stateStore.removeRecord(normalizedDir);
                    } catch (err: unknown) {
                        if (normalizedDir !== "") {
                            protectAncestors(normalizedDir);
                        }
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
        const totalFiles: number = transfers.length;
        const transferTasks: Array<() => Promise<void>> = transfers.map(
            (action: SyncAction, index: number) => async (): Promise<void> => {
                const fileIndex: number = index + 1;
                try {
                    if (action.type === "upload") {
                        await this.executeUpload(
                            action.path,
                            localMap,
                            now,
                            fileIndex,
                            totalFiles
                        );
                        result.uploaded += 1;
                    } else if (action.type === "download") {
                        await this.executeDownload(
                            action.path,
                            remoteMap,
                            now,
                            fileIndex,
                            totalFiles
                        );
                        result.downloaded += 1;
                    } else if (action.type === "conflict") {
                        await this.executeConflict(
                            action,
                            localMap,
                            remoteMap,
                            existingPaths,
                            now,
                            fileIndex,
                            totalFiles
                        );
                        result.conflictsResolved += 1;
                    }
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
            await this.stateStore.save();
        }

        return result;
    }

    public async executeUpload(
        path: string,
        localMap: ReadonlyMap<string, LocalItem>,
        now: number,
        fileIndex: number = 1,
        totalFiles: number = 1
    ): Promise<void> {
        const normalizedPath: string = util.normalizeVaultPath(path);
        if (normalizedPath === "" || util.isExcludedPath(normalizedPath)) {
            throw new Error(`Upload refused on invalid or excluded path: ${path}`);
        }
        const local: LocalItem | undefined = localMap.get(normalizedPath);
        if (local?.isDirectory === true) {
            throw new Error(`Upload refused on directory path: ${normalizedPath}`);
        }
        if (
            local !== undefined &&
            Number.isFinite(local.size) &&
            local.size > MAX_CHUNKED_FILE_SIZE_BYTES
        ) {
            throw new Error(
                `Upload refused on oversized file (${local.size} bytes exceeds ${MAX_CHUNKED_FILE_SIZE_BYTES} bytes): ${normalizedPath}`
            );
        }
        const localReadPath: string =
            local !== undefined
                ? util.normalizeVaultPath(local.path) || normalizedPath
                : normalizedPath;
        const content: ArrayBuffer = await this.vault.adapter.readBinary(localReadPath);
        const localMtime: number = util.toSecondPrecision(local?.mtime ?? now);
        const remoteItem: RemoteItem = await this.uploadContent(
            normalizedPath,
            content,
            localMtime,
            fileIndex,
            totalFiles
        );

        this.stateStore.upsertRecord({
            etag: util.normalizeEtag(remoteItem.etag),
            isDirectory: false,
            lastSyncTime: now,
            localMtime,
            path: normalizedPath,
            remoteMtime: util.toSecondPrecision(remoteItem.mtime),
            size: content.byteLength
        });
    }

    private getChunkingThresholdBytes(): number {
        const thresholdMB: number =
            Number.isFinite(this.settings.chunkingThresholdMB) &&
            this.settings.chunkingThresholdMB >= 1
                ? Math.min(
                      MAX_CHUNKING_THRESHOLD_MB,
                      Math.floor(this.settings.chunkingThresholdMB)
                  )
                : DEFAULT_CHUNKING_THRESHOLD_MB;
        return thresholdMB * BYTES_PER_MB;
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

    private async uploadContent(
        normalizedPath: string,
        content: ArrayBuffer,
        localMtime: number,
        fileIndex: number,
        totalFiles: number
    ): Promise<RemoteItem> {
        if (content.byteLength > MAX_CHUNKED_FILE_SIZE_BYTES) {
            throw new Error(
                `Upload refused on oversized file (${content.byteLength} bytes exceeds ${MAX_CHUNKED_FILE_SIZE_BYTES} bytes): ${normalizedPath}`
            );
        }
        const thresholdBytes: number = this.getChunkingThresholdBytes();
        if (content.byteLength > thresholdBytes) {
            return await this.client.uploadFileChunked(
                normalizedPath,
                content,
                localMtime,
                (chunkIndex: number, totalChunks: number): void => {
                    if (this.progressReporter !== null) {
                        this.progressReporter.reportProgress(
                            formatTransferProgress(
                                "Uploading",
                                normalizedPath,
                                fileIndex,
                                totalFiles,
                                chunkIndex,
                                totalChunks
                            )
                        );
                    }
                }
            );
        }
        if (this.progressReporter !== null) {
            this.progressReporter.reportProgress(
                formatTransferProgress(
                    "Uploading",
                    normalizedPath,
                    fileIndex,
                    totalFiles
                )
            );
        }
        return await this.client.uploadFile(normalizedPath, content, localMtime);
    }

    public async walkLocal(): Promise<LocalItem[]> {
        const discovered: LocalItem[] = [];
        const seenLowerPaths: Map<string, string> = new Map<string, string>();
        const visitedLowerDirs: Set<string> = new Set<string>([""]);
        let queue: string[] = [""];

        while (queue.length > 0) {
            const currentBatch: string[] = queue;
            queue = [];

            const batchLists: ListedFiles[] = await util.runConcurrent(
                currentBatch.map(
                    (dirPath: string) => async (): Promise<ListedFiles> => {
                        try {
                            return await this.vault.adapter.list(dirPath);
                        } catch (err: unknown) {
                            log.error(`Failed to list directory ${dirPath}`, err);
                            throw err;
                        }
                    }
                ),
                TRANSFER_CONCURRENCY
            );

            for (const listed of batchLists) {
                for (const folderRaw of listed.folders) {
                    const folderPath: string = util.normalizeVaultPath(folderRaw);
                    const depth: number = util.getPathDepth(folderPath);
                    if (
                        folderPath === "" ||
                        util.isExcludedPath(folderPath) ||
                        depth > util.MAX_WALK_DEPTH
                    ) {
                        continue;
                    }
                    const lowerFolder: string = folderPath.toLowerCase();
                    const existingFolder: string | undefined =
                        seenLowerPaths.get(lowerFolder);
                    if (existingFolder !== undefined) {
                        if (existingFolder !== folderPath) {
                            log.warn(
                                `Skipping case-colliding local folder: ${folderPath} (collides with ${existingFolder})`
                            );
                        }
                        continue;
                    }
                    seenLowerPaths.set(lowerFolder, folderPath);
                    const stat: Stat | null = await this.vault.adapter.stat(folderPath);
                    const mtime: number =
                        stat !== null && Number.isFinite(stat.mtime) && stat.mtime > 0
                            ? stat.mtime
                            : 0;
                    const ctime: number =
                        stat !== null && Number.isFinite(stat.ctime) && stat.ctime > 0
                            ? stat.ctime
                            : mtime;
                    discovered.push({
                        ctime,
                        isDirectory: true,
                        mtime,
                        path: folderPath,
                        size: 0
                    });
                    if (!visitedLowerDirs.has(lowerFolder) && depth < util.MAX_WALK_DEPTH) {
                        visitedLowerDirs.add(lowerFolder);
                        queue.push(folderPath);
                    }
                }

                for (const fileRaw of listed.files) {
                    const filePath: string = util.normalizeVaultPath(fileRaw);
                    const depth: number = util.getPathDepth(filePath);
                    if (
                        filePath === "" ||
                        util.isExcludedPath(filePath) ||
                        depth > util.MAX_WALK_DEPTH
                    ) {
                        continue;
                    }
                    const lowerFile: string = filePath.toLowerCase();
                    const existingFile: string | undefined =
                        seenLowerPaths.get(lowerFile);
                    if (existingFile !== undefined) {
                        if (existingFile !== filePath) {
                            log.warn(
                                `Skipping case-colliding local file: ${filePath} (collides with ${existingFile})`
                            );
                        }
                        continue;
                    }
                    const stat: Stat | null = await this.vault.adapter.stat(filePath);
                    if (stat === null) {
                        continue;
                    }
                    seenLowerPaths.set(lowerFile, filePath);
                    const safeMtime: number =
                        Number.isFinite(stat.mtime) && stat.mtime > 0 ? stat.mtime : 0;
                    const safeCtime: number =
                        Number.isFinite(stat.ctime) && stat.ctime > 0 ? stat.ctime : 0;
                    const mtime: number = safeMtime > 0 ? safeMtime : safeCtime;
                    discovered.push({
                        ctime: safeCtime > 0 ? safeCtime : mtime,
                        isDirectory: false,
                        mtime,
                        path: filePath,
                        size: Number.isFinite(stat.size) && stat.size > 0 ? stat.size : 0
                    });
                }
            }
        }

        return discovered;
    }
}
