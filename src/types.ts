export type ConflictResolutionMode =
    | "identical"
    | "keep_both"
    | "newest_wins_local"
    | "newest_wins_remote";

export type ConflictStrategy = "keep_both" | "newest_wins";

export interface ActiveConflictItem {
    conflictPath: string;
    mtime: number;
    originalPath: string;
    size: number;
    timestampUtc: string;
}

export interface ConflictOutcome {
    bytesDownloaded: number;
    bytesUploaded: number;
    conflictCopyPath?: string;
    resolution: ConflictResolutionMode;
    size: number;
}

export interface LocalItem {
    ctime: number;
    fsPath?: string;
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

export type SyncEventKind =
    | "conflict"
    | "create_local_dir"
    | "create_remote_dir"
    | "delete_local"
    | "delete_remote"
    | "download"
    | "error"
    | "upload"
    | "warning";

export interface SyncHistoryData {
    runs: SyncRunRecord[];
    version: number;
}

export interface SyncLogEvent {
    conflictCopyPath?: string;
    isDirectory?: boolean;
    kind: SyncEventKind;
    message?: string;
    path?: string;
    resolution?: ConflictResolutionMode;
    size?: number;
}

export interface SyncPlan {
    actions: SyncAction[];
    timestamp: number;
    warnings: SyncLogEvent[];
}

export interface SyncResult {
    conflictsResolved: number;
    deletedLocal: number;
    deletedRemote: number;
    downloaded: number;
    errors: string[];
    events: SyncLogEvent[];
    summary: SyncRunSummary;
    timestamp: number;
    uploaded: number;
}

export interface SyncRunRecord {
    collapsedCount: number;
    detailsPruned: boolean;
    durationMs: number;
    events: SyncLogEvent[];
    finishedAt: number;
    firstCollapsedAt?: number;
    id: string;
    omittedEvents: number;
    startedAt: number;
    status: SyncRunStatus;
    summary: SyncRunSummary;
    trigger: SyncRunTrigger;
}

export type SyncRunStatus = "failed" | "partial" | "success";

export interface SyncRunSummary {
    bytesDownloaded: number;
    bytesUploaded: number;
    conflictsIdentical: number;
    conflictsKeepBoth: number;
    conflictsNewestWins: number;
    conflictsResolved: number;
    deletedLocal: number;
    deletedLocalDirs: number;
    deletedRemote: number;
    deletedRemoteDirs: number;
    dirsCreatedLocal: number;
    dirsCreatedRemote: number;
    downloaded: number;
    errors: number;
    uploaded: number;
    warnings: number;
}

export type SyncRunTrigger = "auto" | "manual";

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
    appPasswordSecret: string;
    chunkSizeMB: number;
    chunkingThresholdMB: number;
    conflictStrategy: ConflictStrategy;
    remoteBaseDir: string;
    syncInterval: number;
    syncLogRetentionDays: number;
    url: string;
    username: string;
}

export interface WebDavClientConfig {
    appPassword: string;
    chunkSizeMB: number;
    chunkingThresholdMB: number;
    remoteBaseDir: string;
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
    retryOnTimeout?: boolean;
    timeoutMs?: number;
}
