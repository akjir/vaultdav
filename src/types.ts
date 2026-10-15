export type ConflictStrategy = "keep_both" | "newest_wins";

export interface LocalItem {
    ctime: number;
    isDirectory: boolean;
    mtime: number;
    path: string;
    size: number;
}

export interface ProgressReporter {
    reportProgress: (message: string) => void;
}

export interface RemoteItem {
    etag: string;
    href: string;
    isDirectory: boolean;
    mtime: number;
    path: string;
    size: number;
}

export interface SyncAction {
    conflictCopyPath?: string;
    depth: number;
    isDirectory: boolean;
    path: string;
    type: SyncActionType;
}

export type SyncActionType =
    | "conflict"
    | "create_local_dir"
    | "create_remote_dir"
    | "delete_local"
    | "delete_remote"
    | "download"
    | "noop"
    | "prune_state"
    | "upload";

export interface SyncPlan {
    actions: SyncAction[];
    timestamp: number;
}

export interface SyncResult {
    conflictsResolved: number;
    deletedLocal: number;
    deletedRemote: number;
    downloaded: number;
    errors: string[];
    timestamp: number;
    uploaded: number;
}

export interface SyncStateData {
    records: Record<string, SyncStateRecord>;
    version: number;
}

export interface SyncStateRecord {
    etag: string;
    isDirectory: boolean;
    lastSyncTime: number;
    localMtime: number;
    path: string;
    remoteMtime: number;
    size: number;
}

export interface VaultDavSettings {
    appPassword: string;
    chunkSizeMB: number;
    chunkingThresholdMB: number;
    conflictStrategy: ConflictStrategy;
    remoteBaseDir: string;
    syncInterval: number;
    url: string;
    username: string;
}

export type WebDavMethod =
    | "DELETE"
    | "GET"
    | "MKCOL"
    | "MOVE"
    | "OPTIONS"
    | "PROPFIND"
    | "PUT";

export interface WebDavRequestOptions {
    body?: ArrayBuffer | string;
    contentType?: string;
    depth?: "0" | "1";
    headers?: Record<string, string>;
    method: WebDavMethod;
    path: string;
    timeoutMs?: number;
}
