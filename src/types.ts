export type ConflictStrategy = "keep_both" | "newest_wins";

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
    | "upload";

export interface SyncPlan {
    actions: SyncAction[];
    timestamp: number;
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
    conflictStrategy: ConflictStrategy;
    remoteBaseDir: string;
    syncInterval: number;
    url: string;
    username: string;
}
