import type { DataWriteOptions, ListedFiles, Stat, Vault } from "obsidian";
import { formatTransferProgress, log, redactSensitiveText } from "../log";
import type {
    ConflictOutcome,
    LocalItem,
    ProgressReporter,
    RemoteItem,
    SyncAction,
    SyncLogEvent,
    SyncPlan,
    SyncResult,
    SyncRunSummary,
    SyncStateRecord,
    VaultDavSettings
} from "../types";
import { util } from "../utilities";
import type { WebDavClient } from "../webdav/client";
import { createEmptyRunSummary } from "./history";
import type { SyncStateStore } from "./state";

export const MAX_FILE_SIZE_BYTES: number = util.MAX_FILE_SIZE_BYTES;

const BYTES_PER_MB: number = 1024 * 1024;
const DEFAULT_CHUNKING_THRESHOLD_MB: number = 90;
const MAX_CHUNKED_FILE_SIZE_BYTES: number = 1024 * 1024 * 1024;
const MAX_CHUNKING_THRESHOLD_MB: number = 512;
const PARALLEL_DOWNLOAD_THRESHOLD_BYTES: number = 5 * 1024 * 1024;
const TRANSFER_CONCURRENCY: number = 4;
const WALK_STAT_CONCURRENCY: number = 5;

interface WalkStatCandidate {
    depth: number;
    isDirectory: boolean;
    lowerPath: string;
    normalizedPath: string;
    rawPath: string;
}

interface WalkStatResult {
    resolvedFsPath: string;
    stat: Stat | null;
}

function addSafeNonNegativeInt(current: number, delta: number): number {
    const safeCurrent: number =
        Number.isFinite(current) && current > 0
            ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(current))
            : 0;
    const safeDelta: number =
        Number.isFinite(delta) && delta > 0
            ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(delta))
            : 0;
    if (safeCurrent >= Number.MAX_SAFE_INTEGER - safeDelta) {
        return Number.MAX_SAFE_INTEGER;
    }
    return safeCurrent + safeDelta;
}

export function buildSyncPlan(
    localItems: ReadonlyArray<LocalItem>,
    remoteItems: ReadonlyArray<RemoteItem>,
    stateRecords: Readonly<Record<string, SyncStateRecord>>,
    timestamp: number = Date.now(),
    configDir: string = ""
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
    const warnings: SyncLogEvent[] = [];

    for (const item of localItems) {
        const norm: string = util.normalizeVaultPath(item.path);
        if (util.isExcludedPath(norm, configDir)) {
            continue;
        }
        const lowerNorm: string = norm.toLowerCase();
        const existingLocalPath: string | undefined = localLowerMap.get(lowerNorm);
        if (existingLocalPath !== undefined) {
            if (existingLocalPath !== norm) {
                const msg: string = `Skipping case-colliding local path: ${norm} (collides with ${existingLocalPath})`;
                log.warn(msg);
                warnings.push({
                    isDirectory: item.isDirectory,
                    kind: "warning",
                    message: msg,
                    path: norm
                });
            }
            continue;
        }
        localLowerMap.set(lowerNorm, norm);
        const canonical: string = resolveCanonicalPath(norm, canonicalPathByLower);
        localMap.set(canonical, { ...item, path: norm });
        allPathsSet.add(canonical);
        if (item.isDirectory) {
            directoryPaths.add(canonical);
        }
        let ancestor: string = getNormalizedParentPath(canonical);
        while (ancestor !== "") {
            allPathsSet.add(ancestor);
            directoryPaths.add(ancestor);
            ancestor = getNormalizedParentPath(ancestor);
        }
    }

    for (const item of remoteItems) {
        const norm: string = util.normalizeVaultPath(item.path);
        if (util.isExcludedPath(norm, configDir)) {
            continue;
        }
        const lowerNorm: string = norm.toLowerCase();
        const existingRemotePath: string | undefined = remoteLowerMap.get(lowerNorm);
        if (existingRemotePath !== undefined) {
            if (existingRemotePath !== norm) {
                const msg: string = `Skipping case-colliding remote path: ${norm} (collides with ${existingRemotePath})`;
                log.warn(msg);
                warnings.push({
                    isDirectory: item.isDirectory,
                    kind: "warning",
                    message: msg,
                    path: norm
                });
            }
            continue;
        }
        remoteLowerMap.set(lowerNorm, norm);
        const existingCanonical: string | undefined =
            canonicalPathByLower.get(lowerNorm);
        if (existingCanonical !== undefined && existingCanonical !== norm) {
            const msg: string = `Case mismatch detected between local "${existingCanonical}" and remote "${norm}"`;
            log.warn(msg);
            warnings.push({
                isDirectory: item.isDirectory,
                kind: "warning",
                message: msg,
                path: existingCanonical
            });
        }
        const canonical: string = resolveCanonicalPath(norm, canonicalPathByLower);
        remoteMap.set(canonical, { ...item, path: norm });
        allPathsSet.add(canonical);
        if (item.isDirectory) {
            directoryPaths.add(canonical);
        }
        let ancestor: string = getNormalizedParentPath(canonical);
        while (ancestor !== "") {
            allPathsSet.add(ancestor);
            directoryPaths.add(ancestor);
            ancestor = getNormalizedParentPath(ancestor);
        }
    }

    for (const [rawKey, record] of Object.entries(stateRecords)) {
        const norm: string = util.normalizeVaultPath(rawKey);
        if (util.isExcludedPath(norm, configDir)) {
            continue;
        }
        const canonical: string = resolveCanonicalPath(norm, canonicalPathByLower);
        stateMap.set(canonical, { ...record, path: canonical });
        allPathsSet.add(canonical);
    }

    const depthByPath: Map<string, number> = new Map<string, number>();
    const existingPaths: Set<string> = new Set<string>(allPathsSet);
    const existingPathsLower: Set<string> = new Set<string>();
    for (const p of allPathsSet) {
        depthByPath.set(p, countNormalizedPathDepth(p));
        existingPathsLower.add(p.toLowerCase());
    }

    const sortedPaths: string[] = Array.from(allPathsSet).sort(
        (a: string, b: string): number => {
            const depthDiff: number =
                (depthByPath.get(b) ?? 0) - (depthByPath.get(a) ?? 0);
            if (depthDiff !== 0) {
                return depthDiff;
            }
            const lenDiff: number = b.length - a.length;
            if (lenDiff !== 0) {
                return lenDiff;
            }
            return a < b ? 1 : a > b ? -1 : 0;
        }
    );

    const keptFolders: Set<string> = new Set<string>();
    const actions: SyncAction[] = [];

    const markParentKept = (path: string): void => {
        const parent: string = getNormalizedParentPath(path);
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
        const depth: number = depthByPath.get(path) ?? countNormalizedPathDepth(path);

        if (
            (local !== undefined &&
                remote !== undefined &&
                local.isDirectory !== remote.isDirectory) ||
            (local !== undefined && !local.isDirectory && directoryPaths.has(path)) ||
            (remote !== undefined && !remote.isDirectory && directoryPaths.has(path))
        ) {
            const msg: string = `Skipping path with file/directory type conflict: ${path}`;
            log.warn(msg);
            warnings.push({
                isDirectory: Boolean(local?.isDirectory || remote?.isDirectory),
                kind: "warning",
                message: msg,
                path
            });
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
                        existingPaths,
                        existingPathsLower
                    );
                    existingPaths.add(conflictCopyPath);
                    existingPathsLower.add(conflictCopyPath.toLowerCase());
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
                    existingPaths,
                    existingPathsLower
                );
                existingPaths.add(conflictCopyPath);
                existingPathsLower.add(conflictCopyPath.toLowerCase());
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
        timestamp: safeTimestamp,
        warnings
    };
}

function buildWriteOptions(
    mtime: number,
    ctime?: number
): DataWriteOptions | undefined {
    const safeMtime: number = util.toSecondPrecision(mtime);
    const safeCtime: number =
        ctime !== undefined && Number.isFinite(ctime) && ctime > 0
            ? Math.floor(ctime)
            : 0;
    if (safeMtime <= 0 && safeCtime <= 0) {
        return undefined;
    }
    const options: DataWriteOptions = {};
    if (safeMtime > 0) {
        options.mtime = safeMtime;
    }
    if (safeCtime > 0) {
        options.ctime = safeCtime;
    }
    return options;
}

function countNormalizedPathDepth(normalizedPath: string): number {
    if (normalizedPath === "") {
        return 0;
    }
    let depth: number = 1;
    for (let i: number = 0; i < normalizedPath.length; i += 1) {
        if (normalizedPath.charCodeAt(i) === 47) {
            depth += 1;
        }
    }
    return depth;
}

function getNormalizedParentPath(normalizedPath: string): string {
    if (normalizedPath === "") {
        return "";
    }
    const lastSlash: number = normalizedPath.lastIndexOf("/");
    return lastSlash === -1 ? "" : normalizedPath.slice(0, lastSlash);
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

function resolveCanonicalPath(
    normalizedPath: string,
    canonicalPathByLower: Map<string, string>
): string {
    const lowerFull: string = normalizedPath.toLowerCase();
    const direct: string | undefined = canonicalPathByLower.get(lowerFull);
    if (direct !== undefined) {
        return direct;
    }
    const parts: string[] = normalizedPath.split("/");
    let current: string = "";
    let currentLower: string = "";
    for (let i: number = 0; i < parts.length; i += 1) {
        const part: string = parts[i] ?? "";
        const candidate: string = i === 0 ? part : `${current}/${part}`;
        const lowerCandidate: string =
            i === 0 ? part.toLowerCase() : `${currentLower}/${part.toLowerCase()}`;
        const existing: string | undefined =
            canonicalPathByLower.get(lowerCandidate);
        if (existing !== undefined) {
            current = existing;
        } else {
            current = candidate;
            canonicalPathByLower.set(lowerCandidate, current);
        }
        currentLower = lowerCandidate;
    }
    return current;
}

function resolveLocalFsPath(
    normalizedPath: string,
    local?: LocalItem,
    explicitFsPath?: string
): string {
    const candidate: string | undefined = explicitFsPath ?? local?.fsPath;
    if (candidate !== undefined && candidate !== "") {
        const normCandidate: string = util.normalizeVaultPath(candidate);
        if (
            normCandidate !== "" &&
            (normCandidate === normalizedPath ||
                normCandidate.toLowerCase() === normalizedPath.toLowerCase())
        ) {
            return candidate;
        }
    }
    if (local !== undefined) {
        const normLocal: string = util.normalizeVaultPath(local.path);
        if (normLocal !== "") {
            return normLocal;
        }
    }
    return normalizedPath;
}

function resolveLocalWritePath(
    normalizedPath: string,
    localMap?: ReadonlyMap<string, LocalItem>,
    localDirFsPathByLower?: ReadonlyMap<string, string>
): string {
    if (localMap !== undefined) {
        const directLocal: LocalItem | undefined = localMap.get(normalizedPath);
        if (directLocal !== undefined) {
            return resolveLocalFsPath(normalizedPath, directLocal);
        }
    }
    const ancestors: string[] = util.getFolderLevels(normalizedPath, false);
    for (let i: number = ancestors.length - 1; i >= 0; i -= 1) {
        const ancestor: string | undefined = ancestors[i];
        if (ancestor === undefined) {
            continue;
        }
        let localDirPath: string = "";
        if (localMap !== undefined) {
            const localDir: LocalItem | undefined = localMap.get(ancestor);
            if (localDir !== undefined && localDir.isDirectory) {
                localDirPath = resolveLocalFsPath(ancestor, localDir);
            }
        }
        if (localDirPath === "" && localDirFsPathByLower !== undefined) {
            localDirPath =
                localDirFsPathByLower.get(ancestor.toLowerCase()) ?? "";
        }
        if (localDirPath !== "") {
            const suffix: string = normalizedPath.slice(ancestor.length);
            return `${localDirPath}${suffix}`;
        }
    }
    return normalizedPath;
}

function resolveRemotePathCasing(
    normalizedPath: string,
    remoteMap?: ReadonlyMap<string, RemoteItem>,
    remoteDirCasingByLower?: ReadonlyMap<string, string>
): string {
    if (remoteMap !== undefined) {
        const directRemote: RemoteItem | undefined = remoteMap.get(normalizedPath);
        if (directRemote !== undefined) {
            const normDirect: string = util.normalizeVaultPath(directRemote.path);
            if (normDirect !== "") {
                return normDirect;
            }
        }
    }
    const ancestors: string[] = util.getFolderLevels(normalizedPath, false);
    for (let i: number = ancestors.length - 1; i >= 0; i -= 1) {
        const ancestor: string | undefined = ancestors[i];
        if (ancestor === undefined) {
            continue;
        }
        let remoteDirPath: string = "";
        if (remoteMap !== undefined) {
            const remoteDir: RemoteItem | undefined = remoteMap.get(ancestor);
            if (remoteDir !== undefined && remoteDir.isDirectory) {
                remoteDirPath = util.normalizeVaultPath(remoteDir.path);
            }
        }
        if (remoteDirPath === "" && remoteDirCasingByLower !== undefined) {
            remoteDirPath =
                remoteDirCasingByLower.get(ancestor.toLowerCase()) ?? "";
        }
        if (remoteDirPath !== "") {
            const suffix: string = normalizedPath.slice(ancestor.length);
            return `${remoteDirPath}${suffix}`;
        }
    }
    return normalizedPath;
}

export class SyncEngine {
    private readonly client: WebDavClient;
    private readonly configDir: string;
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
        this.configDir =
            typeof vault.configDir === "string"
                ? util.normalizeVaultPath(vault.configDir)
                : "";
        this.client = client;
        this.stateStore = stateStore;
        this.settings = settings;
        this.progressReporter = progressReporter;
    }

    public async createLocalDirectory(
        path: string,
        fsPath?: string
    ): Promise<void> {
        const normalizedPath: string = util.normalizeVaultPath(path);
        if (normalizedPath === "" || util.isExcludedPath(normalizedPath, this.configDir)) {
            throw new Error(`Local mkdir refused on invalid or excluded path: ${path}`);
        }
        let levels: string[] = util.getFolderLevels(normalizedPath, true);
        if (
            fsPath !== undefined &&
            fsPath !== "" &&
            !util.hasControlChars(fsPath) &&
            !fsPath.includes("\\")
        ) {
            const normFsPath: string = util.normalizeVaultPath(fsPath);
            if (
                normFsPath !== "" &&
                (normFsPath === normalizedPath ||
                    normFsPath.toLowerCase() === normalizedPath.toLowerCase())
            ) {
                const rawParts: string[] = fsPath
                    .split("/")
                    .filter((part: string) => part !== "");
                const fsLevels: string[] = [];
                for (let i: number = 1; i <= rawParts.length; i += 1) {
                    fsLevels.push(rawParts.slice(0, i).join("/"));
                }
                if (fsLevels.length > 0) {
                    levels = fsLevels;
                }
            }
        }
        for (const folder of levels) {
            const exists: boolean = await this.vault.adapter.exists(folder);
            if (!exists) {
                await this.vault.adapter.mkdir(folder);
            }
        }
    }

    public async deleteLocalItem(
        path: string,
        isDirectory: boolean,
        fsPath?: string
    ): Promise<void> {
        const normalizedPath: string = util.normalizeVaultPath(path);
        if (normalizedPath === "" || util.isExcludedPath(normalizedPath, this.configDir)) {
            throw new Error(`Local delete refused on invalid or excluded path: ${path}`);
        }
        const safeFsPath: string = resolveLocalFsPath(
            normalizedPath,
            undefined,
            fsPath
        );
        let targetPath: string = normalizedPath;
        let exists: boolean = await this.vault.adapter.exists(targetPath);
        if (!exists && safeFsPath !== normalizedPath) {
            exists = await this.vault.adapter.exists(safeFsPath);
            if (exists) {
                targetPath = safeFsPath;
            }
        }
        if (!exists) {
            return;
        }
        if (isDirectory && typeof this.vault.adapter.list === "function") {
            const listed: ListedFiles = await this.vault.adapter.list(targetPath);
            if (listed.files.length > 0 || listed.folders.length > 0) {
                throw new Error(
                    `ENOTEMPTY: Local directory not empty: ${normalizedPath}`
                );
            }
        }
        if (typeof this.vault.adapter.trashLocal === "function") {
            await this.vault.adapter.trashLocal(targetPath);
            return;
        }
        if (isDirectory) {
            await this.vault.adapter.rmdir(targetPath, false);
        } else {
            await this.vault.adapter.remove(targetPath);
        }
    }

    private async downloadContent(
        remoteDownloadPath: string,
        progressLabelPath: string,
        remoteSize: number,
        fileIndex: number,
        totalFiles: number,
        remoteEtag?: string
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
                    },
                    remoteEtag
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
        totalFiles: number = 1,
        remoteDirCasingByLower?: ReadonlyMap<string, string>,
        localDirFsPathByLower?: ReadonlyMap<string, string>,
        existingLowerPaths?: Set<string>
    ): Promise<ConflictOutcome | null> {
        const normalizedPath: string = util.normalizeVaultPath(action.path);
        if (normalizedPath === "" || util.isExcludedPath(normalizedPath, this.configDir)) {
            throw new Error(
                `Conflict resolution refused on invalid or excluded path: ${action.path}`
            );
        }
        const local: LocalItem | undefined = localMap.get(normalizedPath);
        const remote: RemoteItem | undefined = remoteMap.get(normalizedPath);
        if (local === undefined || remote === undefined) {
            return null;
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
                const uploadedSize: number = await this.executeUpload(
                    normalizedPath,
                    localMap,
                    now,
                    fileIndex,
                    totalFiles,
                    remoteMap,
                    remoteDirCasingByLower
                );
                return {
                    bytesDownloaded: 0,
                    bytesUploaded: uploadedSize,
                    resolution: "newest_wins_local",
                    size: uploadedSize
                };
            } else {
                const downloadedSize: number = await this.executeDownload(
                    normalizedPath,
                    remoteMap,
                    now,
                    fileIndex,
                    totalFiles,
                    localMap,
                    localDirFsPathByLower
                );
                return {
                    bytesDownloaded: downloadedSize,
                    bytesUploaded: 0,
                    resolution: "newest_wins_remote",
                    size: downloadedSize
                };
            }
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

        const localReadPath: string = resolveLocalFsPath(normalizedPath, local);
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
                    totalFiles,
                    remote.etag
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
            return {
                bytesDownloaded: remoteBuffer.byteLength,
                bytesUploaded: 0,
                resolution: "identical",
                size: remoteBuffer.byteLength
            };
        }

        existingPaths.add(normalizedPath);
        existingLowerPaths?.add(normalizedPath.toLowerCase());
        const normalizedPlannedConflict: string =
            action.conflictCopyPath !== undefined
                ? util.normalizeVaultPath(action.conflictCopyPath)
                : "";
        const plannedConflictLower: string =
            normalizedPlannedConflict.toLowerCase();
        const isPlannedConflictTaken: boolean =
            existingLowerPaths !== undefined
                ? existingLowerPaths.has(plannedConflictLower)
                : hasCaseInsensitivePath(existingPaths, normalizedPlannedConflict);
        const canUsePlannedConflictPath: boolean =
            normalizedPlannedConflict !== "" &&
            plannedConflictLower !== normalizedPath.toLowerCase() &&
            !util.isExcludedPath(normalizedPlannedConflict, this.configDir) &&
            (this.planReservedConflictPaths.delete(normalizedPlannedConflict) ||
                !isPlannedConflictTaken);
        const conflictPath: string = canUsePlannedConflictPath
            ? normalizedPlannedConflict
            : util.getConflictPath(
                  normalizedPath,
                  now,
                  existingPaths,
                  existingLowerPaths
              );
        existingPaths.add(conflictPath);
        existingLowerPaths?.add(conflictPath.toLowerCase());

        const localConflictWritePath: string = resolveLocalWritePath(
            conflictPath,
            localMap,
            localDirFsPathByLower
        );
        const parentDir: string = getNormalizedParentPath(conflictPath);
        if (parentDir !== "") {
            const parentFsDir: string = getNormalizedParentPath(
                localConflictWritePath
            );
            await this.createLocalDirectory(parentDir, parentFsDir);
        }

        const safeLocalMtime: number = util.toSecondPrecision(local.mtime);
        const conflictWriteOptions: DataWriteOptions | undefined =
            buildWriteOptions(safeLocalMtime, local.ctime);
        await this.vault.adapter.writeBinary(
            localConflictWritePath,
            localBuffer,
            conflictWriteOptions
        );
        const remoteConflictPath: string = resolveRemotePathCasing(
            conflictPath,
            remoteMap,
            remoteDirCasingByLower
        );
        const uploadedConflict: RemoteItem = await this.uploadContent(
            remoteConflictPath,
            localBuffer,
            safeLocalMtime,
            fileIndex,
            totalFiles
        );
        const conflictStat: Stat | null = await this.vault.adapter.stat(
            localConflictWritePath
        );
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
        const mainWriteOptions: DataWriteOptions | undefined =
            buildWriteOptions(safeRemoteMtime);
        await this.vault.adapter.writeBinary(
            localReadPath,
            remoteBuffer,
            mainWriteOptions
        );
        const mainStat: Stat | null = await this.vault.adapter.stat(localReadPath);
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
        return {
            bytesDownloaded: remoteBuffer.byteLength,
            bytesUploaded: localBuffer.byteLength,
            conflictCopyPath: conflictPath,
            resolution: "keep_both",
            size: localBuffer.byteLength
        };
    }

    public async executeDownload(
        path: string,
        remoteMap: ReadonlyMap<string, RemoteItem>,
        now: number,
        fileIndex: number = 1,
        totalFiles: number = 1,
        localMap?: ReadonlyMap<string, LocalItem>,
        localDirFsPathByLower?: ReadonlyMap<string, string>
    ): Promise<number> {
        const normalizedPath: string = util.normalizeVaultPath(path);
        if (normalizedPath === "" || util.isExcludedPath(normalizedPath, this.configDir)) {
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
            totalFiles,
            remote?.etag
        );
        const localWritePath: string = resolveLocalWritePath(
            normalizedPath,
            localMap,
            localDirFsPathByLower
        );
        const parentDir: string = getNormalizedParentPath(normalizedPath);
        if (parentDir !== "") {
            const parentFsDir: string = getNormalizedParentPath(localWritePath);
            await this.createLocalDirectory(parentDir, parentFsDir);
        }

        const targetMtime: number = util.toSecondPrecision(remote?.mtime ?? now);
        const writeOptions: DataWriteOptions | undefined =
            buildWriteOptions(targetMtime);
        await this.vault.adapter.writeBinary(
            localWritePath,
            content,
            writeOptions
        );
        const localStat: Stat | null = await this.vault.adapter.stat(localWritePath);
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
        return content.byteLength;
    }

    public async executePlan(
        plan: SyncPlan,
        localItems: ReadonlyArray<LocalItem>,
        remoteItems: ReadonlyArray<RemoteItem>,
        initialWarnings: ReadonlyArray<SyncLogEvent> = []
    ): Promise<SyncResult> {
        const now: number =
            Number.isFinite(plan.timestamp) && plan.timestamp > 0
                ? plan.timestamp
                : 0;
        const localMap: Map<string, LocalItem> = new Map<string, LocalItem>();
        const localLowerMap: Map<string, LocalItem> = new Map<string, LocalItem>();
        const localDirFsPathByLower: Map<string, string> = new Map<string, string>();
        for (const item of localItems) {
            const norm: string = util.normalizeVaultPath(item.path);
            if (norm !== "") {
                localMap.set(norm, item);
                const lower: string = norm.toLowerCase();
                if (!localLowerMap.has(lower)) {
                    localLowerMap.set(lower, item);
                }
                const itemFsPath: string = resolveLocalFsPath(norm, item);
                const normLevels: string[] = util.getFolderLevels(
                    norm,
                    item.isDirectory
                );
                const fsParts: string[] = itemFsPath.split("/");
                const useFsParts: boolean =
                    !itemFsPath.includes("\\") &&
                    fsParts.length === countNormalizedPathDepth(norm);
                for (let i: number = 0; i < normLevels.length; i += 1) {
                    const normFolder: string | undefined = normLevels[i];
                    if (normFolder === undefined) {
                        continue;
                    }
                    const lowerFolder: string = normFolder.toLowerCase();
                    if (!localDirFsPathByLower.has(lowerFolder)) {
                        localDirFsPathByLower.set(
                            lowerFolder,
                            useFsParts
                                ? fsParts.slice(0, i + 1).join("/")
                                : normFolder
                        );
                    }
                }
            }
        }
        const remoteMap: Map<string, RemoteItem> = new Map<string, RemoteItem>();
        const remoteLowerMap: Map<string, RemoteItem> = new Map<string, RemoteItem>();
        const remoteDirCasingByLower: Map<string, string> = new Map<string, string>();
        for (const item of remoteItems) {
            const norm: string = util.normalizeVaultPath(item.path);
            if (norm !== "") {
                remoteMap.set(norm, item);
                const lower: string = norm.toLowerCase();
                if (!remoteLowerMap.has(lower)) {
                    remoteLowerMap.set(lower, item);
                }
                for (const folderLevel of util.getFolderLevels(norm, item.isDirectory)) {
                    const lowerFolder: string = folderLevel.toLowerCase();
                    if (!remoteDirCasingByLower.has(lowerFolder)) {
                        remoteDirCasingByLower.set(lowerFolder, folderLevel);
                    }
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
        const existingPathsLower: Set<string> = new Set<string>();
        for (const p of existingPaths) {
            existingPathsLower.add(p.toLowerCase());
        }
        for (const action of plan.actions) {
            if (action.conflictCopyPath !== undefined) {
                const normalizedConflict: string = util.normalizeVaultPath(
                    action.conflictCopyPath
                );
                const lowerConflict: string = normalizedConflict.toLowerCase();
                if (
                    normalizedConflict !== "" &&
                    !util.isExcludedPath(normalizedConflict, this.configDir) &&
                    !existingPathsLower.has(lowerConflict)
                ) {
                    existingPaths.add(normalizedConflict);
                    existingPathsLower.add(lowerConflict);
                    this.planReservedConflictPaths.add(normalizedConflict);
                }
            }
        }

        const summary: SyncRunSummary = createEmptyRunSummary();
        const events: SyncLogEvent[] = [];
        for (const warning of initialWarnings) {
            events.push({ ...warning });
            summary.warnings += 1;
        }
        if (Array.isArray(plan.warnings)) {
            for (const warning of plan.warnings) {
                events.push({ ...warning });
                summary.warnings += 1;
            }
        }
        const result: SyncResult = {
            conflictsResolved: 0,
            deletedLocal: 0,
            deletedRemote: 0,
            downloaded: 0,
            errors: [],
            events,
            summary,
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
            if (normActionPath === "" || util.isExcludedPath(normActionPath, this.configDir)) {
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
                    local !== undefined &&
                    remote !== undefined &&
                    local.isDirectory === remote.isDirectory
                ) {
                    const isDir: boolean = local.isDirectory;
                    const needsRefresh: boolean =
                        existing === undefined ||
                        (!isDir &&
                            isMetadataEqual(local, remote) &&
                            (isLocalModified(local, existing) ||
                                isRemoteModified(remote, existing)));
                    if (needsRefresh) {
                        this.stateStore.upsertRecord({
                            etag: util.normalizeEtag(remote.etag),
                            isDirectory: isDir,
                            lastSyncTime: now,
                            localMtime: util.toSecondPrecision(local.mtime),
                            path: normActionPath,
                            remoteMtime: util.toSecondPrecision(remote.mtime),
                            size: isDir ? 0 : remote.size
                        });
                        stateDirty = true;
                    }
                }
            }
        }
        if (stateDirty) {
            await this.stateStore.save();
        }

        const dirCreationsByDepth: Map<number, SyncAction[]> = new Map<
            number,
            SyncAction[]
        >();
        for (const action of plan.actions) {
            if (
                action.type === "create_local_dir" ||
                action.type === "create_remote_dir"
            ) {
                const depth: number = util.getPathDepth(action.path);
                const bucket: SyncAction[] | undefined =
                    dirCreationsByDepth.get(depth);
                if (bucket !== undefined) {
                    bucket.push(action);
                } else {
                    dirCreationsByDepth.set(depth, [action]);
                }
            }
        }
        const dirDepthLevels: number[] = Array.from(dirCreationsByDepth.keys()).sort(
            (a: number, b: number) => a - b
        );

        for (const level of dirDepthLevels) {
            const levelActions: SyncAction[] =
                dirCreationsByDepth.get(level) ?? [];
            const tasks: Array<() => Promise<void>> = levelActions.map(
                (action: SyncAction) => async (): Promise<void> => {
                    try {
                        const normalizedDir: string = util.normalizeVaultPath(
                            action.path
                        );
                        if (
                            normalizedDir === "" ||
                            util.isExcludedPath(normalizedDir, this.configDir)
                        ) {
                            throw new Error(
                                `Directory creation refused on invalid or excluded path: ${action.path}`
                            );
                        }
                        if (action.type === "create_local_dir") {
                            const localDirWritePath: string = resolveLocalWritePath(
                                normalizedDir,
                                localMap,
                                localDirFsPathByLower
                            );
                            await this.createLocalDirectory(
                                normalizedDir,
                                localDirWritePath
                            );
                            const lowerDir: string = normalizedDir.toLowerCase();
                            if (!localDirFsPathByLower.has(lowerDir)) {
                                localDirFsPathByLower.set(
                                    lowerDir,
                                    localDirWritePath
                                );
                            }
                            summary.dirsCreatedLocal += 1;
                            events.push({
                                isDirectory: true,
                                kind: "create_local_dir",
                                path: normalizedDir
                            });
                        } else {
                            const remoteDirPath: string = resolveRemotePathCasing(
                                normalizedDir,
                                remoteMap,
                                remoteDirCasingByLower
                            );
                            await this.client.createDirectory(remoteDirPath);
                            summary.dirsCreatedRemote += 1;
                            events.push({
                                isDirectory: true,
                                kind: "create_remote_dir",
                                path: normalizedDir
                            });
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
                        summary.errors += 1;
                        events.push({
                            isDirectory: true,
                            kind: "error",
                            message: redactSensitiveText(msg),
                            path: util.normalizeVaultPath(action.path) || action.path
                        });
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
                        util.isExcludedPath(normalizedPath, this.configDir)
                    ) {
                        throw new Error(
                            `File deletion refused on invalid or excluded path: ${action.path}`
                        );
                    }
                    if (action.type === "delete_local") {
                        await this.deleteLocalItem(
                            normalizedPath,
                            false,
                            localMap.get(normalizedPath)?.fsPath
                        );
                        result.deletedLocal += 1;
                        summary.deletedLocal += 1;
                        events.push({
                            isDirectory: false,
                            kind: "delete_local",
                            path: normalizedPath
                        });
                    } else {
                        const remoteDeletePath: string = resolveRemotePathCasing(
                            normalizedPath,
                            remoteMap,
                            remoteDirCasingByLower
                        );
                        await this.client.deleteItem(remoteDeletePath, false);
                        result.deletedRemote += 1;
                        summary.deletedRemote += 1;
                        events.push({
                            isDirectory: false,
                            kind: "delete_remote",
                            path: normalizedPath
                        });
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
                    summary.errors += 1;
                    events.push({
                        isDirectory: false,
                        kind: "error",
                        message: redactSensitiveText(msg),
                        path: normalizedPath || action.path
                    });
                }
            }
        );
        if (fileDeleteTasks.length > 0) {
            await util.runConcurrent(fileDeleteTasks, TRANSFER_CONCURRENCY);
            await this.stateStore.save();
        }

        const dirDeletionsByDepth: Map<number, SyncAction[]> = new Map<
            number,
            SyncAction[]
        >();
        for (const action of plan.actions) {
            if (
                action.isDirectory &&
                (action.type === "delete_local" || action.type === "delete_remote")
            ) {
                const depth: number = util.getPathDepth(action.path);
                const bucket: SyncAction[] | undefined =
                    dirDeletionsByDepth.get(depth);
                if (bucket !== undefined) {
                    bucket.push(action);
                } else {
                    dirDeletionsByDepth.set(depth, [action]);
                }
            }
        }
        const deleteDepthLevels: number[] = Array.from(
            dirDeletionsByDepth.keys()
        ).sort((a: number, b: number) => b - a);

        for (const level of deleteDepthLevels) {
            const levelActions: SyncAction[] =
                dirDeletionsByDepth.get(level) ?? [];
            const tasks: Array<() => Promise<void>> = levelActions.map(
                (action: SyncAction) => async (): Promise<void> => {
                    const normalizedDir: string = util.normalizeVaultPath(
                        action.path
                    );
                    try {
                        if (
                            normalizedDir === "" ||
                            util.isExcludedPath(normalizedDir, this.configDir)
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
                            await this.deleteLocalItem(
                                normalizedDir,
                                true,
                                localMap.get(normalizedDir)?.fsPath
                            );
                            summary.deletedLocalDirs += 1;
                            events.push({
                                isDirectory: true,
                                kind: "delete_local",
                                path: normalizedDir
                            });
                        } else {
                            const remoteDeleteDir: string = resolveRemotePathCasing(
                                normalizedDir,
                                remoteMap,
                                remoteDirCasingByLower
                            );
                            await this.client.deleteItem(remoteDeleteDir, true);
                            summary.deletedRemoteDirs += 1;
                            events.push({
                                isDirectory: true,
                                kind: "delete_remote",
                                path: normalizedDir
                            });
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
                        summary.errors += 1;
                        events.push({
                            isDirectory: true,
                            kind: "error",
                            message: redactSensitiveText(msg),
                            path: normalizedDir || action.path
                        });
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
                    const normalizedTransferPath: string =
                        util.normalizeVaultPath(action.path) || action.path;
                    if (action.type === "upload") {
                        const uploadedSize: number = await this.executeUpload(
                            action.path,
                            localMap,
                            now,
                            fileIndex,
                            totalFiles,
                            remoteMap,
                            remoteDirCasingByLower
                        );
                        result.uploaded += 1;
                        summary.uploaded += 1;
                        summary.bytesUploaded = addSafeNonNegativeInt(
                            summary.bytesUploaded,
                            uploadedSize
                        );
                        events.push({
                            isDirectory: false,
                            kind: "upload",
                            path: normalizedTransferPath,
                            size: uploadedSize
                        });
                    } else if (action.type === "download") {
                        const downloadedSize: number = await this.executeDownload(
                            action.path,
                            remoteMap,
                            now,
                            fileIndex,
                            totalFiles,
                            localMap,
                            localDirFsPathByLower
                        );
                        result.downloaded += 1;
                        summary.downloaded += 1;
                        summary.bytesDownloaded = addSafeNonNegativeInt(
                            summary.bytesDownloaded,
                            downloadedSize
                        );
                        events.push({
                            isDirectory: false,
                            kind: "download",
                            path: normalizedTransferPath,
                            size: downloadedSize
                        });
                    } else if (action.type === "conflict") {
                        const outcome: ConflictOutcome | null =
                            await this.executeConflict(
                                action,
                                localMap,
                                remoteMap,
                                existingPaths,
                                now,
                                fileIndex,
                                totalFiles,
                                remoteDirCasingByLower,
                                localDirFsPathByLower,
                                existingPathsLower
                            );
                        result.conflictsResolved += 1;
                        summary.conflictsResolved += 1;
                        if (outcome !== null) {
                            summary.bytesUploaded = addSafeNonNegativeInt(
                                summary.bytesUploaded,
                                outcome.bytesUploaded
                            );
                            summary.bytesDownloaded = addSafeNonNegativeInt(
                                summary.bytesDownloaded,
                                outcome.bytesDownloaded
                            );
                            if (outcome.resolution === "keep_both") {
                                summary.conflictsKeepBoth += 1;
                            } else if (outcome.resolution === "identical") {
                                summary.conflictsIdentical += 1;
                            } else {
                                summary.conflictsNewestWins += 1;
                            }
                            const conflictEvent: SyncLogEvent = {
                                isDirectory: false,
                                kind: "conflict",
                                path: normalizedTransferPath,
                                resolution: outcome.resolution,
                                size: outcome.size
                            };
                            if (outcome.conflictCopyPath !== undefined) {
                                conflictEvent.conflictCopyPath =
                                    outcome.conflictCopyPath;
                            }
                            events.push(conflictEvent);
                        }
                    }
                } catch (err: unknown) {
                    const msg: string =
                        err instanceof Error ? err.message : String(err);
                    log.error(`Transfer failed for ${action.path}: ${msg}`);
                    result.errors.push(`${action.path}: ${msg}`);
                    summary.errors += 1;
                    events.push({
                        isDirectory: false,
                        kind: "error",
                        message: redactSensitiveText(msg),
                        path: util.normalizeVaultPath(action.path) || action.path
                    });
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
        totalFiles: number = 1,
        remoteMap?: ReadonlyMap<string, RemoteItem>,
        remoteDirCasingByLower?: ReadonlyMap<string, string>
    ): Promise<number> {
        const normalizedPath: string = util.normalizeVaultPath(path);
        if (normalizedPath === "" || util.isExcludedPath(normalizedPath, this.configDir)) {
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
        const localReadPath: string = resolveLocalFsPath(normalizedPath, local);
        const content: ArrayBuffer = await this.vault.adapter.readBinary(localReadPath);
        const localMtime: number = util.toSecondPrecision(local?.mtime ?? now);
        const remoteUploadPath: string = resolveRemotePathCasing(
            normalizedPath,
            remoteMap,
            remoteDirCasingByLower
        );
        const remoteItem: RemoteItem = await this.uploadContent(
            remoteUploadPath,
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
        return content.byteLength;
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
        const walkWarnings: SyncLogEvent[] = [];
        const [stateData, remoteItems, localItems]: [
            { records: Record<string, SyncStateRecord> },
            RemoteItem[],
            LocalItem[]
        ] = await Promise.all([
            this.stateStore.load(),
            this.client.walkRemote(),
            this.walkLocal(walkWarnings)
        ]);

        const plan: SyncPlan = buildSyncPlan(
            localItems,
            remoteItems,
            stateData.records,
            Date.now(),
            this.configDir
        );
        return await this.executePlan(plan, localItems, remoteItems, walkWarnings);
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

    public async walkLocal(warnings?: SyncLogEvent[]): Promise<LocalItem[]> {
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

            const candidates: WalkStatCandidate[] = [];
            for (const listed of batchLists) {
                for (const folderRaw of listed.folders) {
                    const folderPath: string = util.normalizeVaultPath(folderRaw);
                    const depth: number = countNormalizedPathDepth(folderPath);
                    if (
                        folderPath === "" ||
                        util.isExcludedPath(folderPath, this.configDir) ||
                        depth > util.MAX_WALK_DEPTH
                    ) {
                        continue;
                    }
                    const lowerFolder: string = folderPath.toLowerCase();
                    const existingFolder: string | undefined =
                        seenLowerPaths.get(lowerFolder);
                    if (existingFolder !== undefined) {
                        if (existingFolder !== folderPath) {
                            const msg: string = `Skipping case-colliding local folder: ${folderPath} (collides with ${existingFolder})`;
                            log.warn(msg);
                            warnings?.push({
                                isDirectory: true,
                                kind: "warning",
                                message: msg,
                                path: folderPath
                            });
                        }
                        continue;
                    }
                    seenLowerPaths.set(lowerFolder, folderPath);
                    candidates.push({
                        depth,
                        isDirectory: true,
                        lowerPath: lowerFolder,
                        normalizedPath: folderPath,
                        rawPath: folderRaw
                    });
                }

                for (const fileRaw of listed.files) {
                    const filePath: string = util.normalizeVaultPath(fileRaw);
                    const depth: number = countNormalizedPathDepth(filePath);
                    if (
                        filePath === "" ||
                        util.isExcludedPath(filePath, this.configDir) ||
                        depth > util.MAX_WALK_DEPTH
                    ) {
                        continue;
                    }
                    const lowerFile: string = filePath.toLowerCase();
                    const existingFile: string | undefined =
                        seenLowerPaths.get(lowerFile);
                    if (existingFile !== undefined) {
                        if (existingFile !== filePath) {
                            const msg: string = `Skipping case-colliding local file: ${filePath} (collides with ${existingFile})`;
                            log.warn(msg);
                            warnings?.push({
                                isDirectory: false,
                                kind: "warning",
                                message: msg,
                                path: filePath
                            });
                        }
                        continue;
                    }
                    candidates.push({
                        depth,
                        isDirectory: false,
                        lowerPath: lowerFile,
                        normalizedPath: filePath,
                        rawPath: fileRaw
                    });
                }
            }

            const statResults: WalkStatResult[] = await util.runConcurrent(
                candidates.map(
                    (candidate: WalkStatCandidate) =>
                        async (): Promise<WalkStatResult> => {
                            let stat: Stat | null = await this.vault.adapter.stat(
                                candidate.normalizedPath
                            );
                            let resolvedFsPath: string = candidate.normalizedPath;
                            if (
                                stat === null &&
                                candidate.rawPath !== candidate.normalizedPath
                            ) {
                                const rawStat: Stat | null =
                                    await this.vault.adapter.stat(
                                        candidate.rawPath
                                    );
                                if (rawStat !== null) {
                                    stat = rawStat;
                                    resolvedFsPath = candidate.rawPath;
                                }
                            }
                            return { resolvedFsPath, stat };
                        }
                ),
                WALK_STAT_CONCURRENCY
            );

            for (let i: number = 0; i < candidates.length; i += 1) {
                const candidate: WalkStatCandidate | undefined = candidates[i];
                const statResult: WalkStatResult | undefined = statResults[i];
                if (candidate === undefined || statResult === undefined) {
                    continue;
                }
                const { resolvedFsPath, stat } = statResult;
                if (candidate.isDirectory) {
                    const mtime: number =
                        stat !== null && Number.isFinite(stat.mtime) && stat.mtime > 0
                            ? stat.mtime
                            : 0;
                    const ctime: number =
                        stat !== null && Number.isFinite(stat.ctime) && stat.ctime > 0
                            ? stat.ctime
                            : mtime;
                    const folderItem: LocalItem = {
                        ctime,
                        isDirectory: true,
                        mtime,
                        path: candidate.normalizedPath,
                        size: 0
                    };
                    if (resolvedFsPath !== candidate.normalizedPath) {
                        folderItem.fsPath = resolvedFsPath;
                    }
                    discovered.push(folderItem);
                    if (
                        !visitedLowerDirs.has(candidate.lowerPath) &&
                        candidate.depth < util.MAX_WALK_DEPTH
                    ) {
                        visitedLowerDirs.add(candidate.lowerPath);
                        queue.push(resolvedFsPath);
                    }
                } else {
                    const existingFile: string | undefined = seenLowerPaths.get(
                        candidate.lowerPath
                    );
                    if (existingFile !== undefined) {
                        if (existingFile !== candidate.normalizedPath) {
                            const msg: string = `Skipping case-colliding local file: ${candidate.normalizedPath} (collides with ${existingFile})`;
                            log.warn(msg);
                            warnings?.push({
                                isDirectory: false,
                                kind: "warning",
                                message: msg,
                                path: candidate.normalizedPath
                            });
                        }
                        continue;
                    }
                    if (stat === null) {
                        continue;
                    }
                    seenLowerPaths.set(
                        candidate.lowerPath,
                        candidate.normalizedPath
                    );
                    const safeMtime: number =
                        Number.isFinite(stat.mtime) && stat.mtime > 0 ? stat.mtime : 0;
                    const safeCtime: number =
                        Number.isFinite(stat.ctime) && stat.ctime > 0 ? stat.ctime : 0;
                    const mtime: number = safeMtime > 0 ? safeMtime : safeCtime;
                    const fileItem: LocalItem = {
                        ctime: safeCtime > 0 ? safeCtime : mtime,
                        isDirectory: false,
                        mtime,
                        path: candidate.normalizedPath,
                        size:
                            Number.isFinite(stat.size) && stat.size > 0
                                ? stat.size
                                : 0
                    };
                    if (resolvedFsPath !== candidate.normalizedPath) {
                        fileItem.fsPath = resolvedFsPath;
                    }
                    discovered.push(fileItem);
                }
            }
        }

        return discovered;
    }
}
