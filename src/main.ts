import { Plugin } from "obsidian";
import { log, redactSensitiveText } from "./log";
import {
    DEFAULT_SETTINGS,
    MAX_SYNC_INTERVAL_MINUTES,
    VaultDavSettingTab,
    sanitizeAppPassword,
    sanitizeChunkSizeMB,
    sanitizeChunkingThresholdMB,
    sanitizeRemoteBaseDir,
    sanitizeServerUrl,
    sanitizeSyncInterval,
    sanitizeUsername
} from "./settings";
import { SyncEngine } from "./sync/engine";
import { SyncStateStore } from "./sync/state";
import type {
    ConflictStrategy,
    ProgressReporter,
    SyncResult,
    VaultDavSettings
} from "./types";
import { util } from "./utilities";
import { WebDavClient } from "./webdav/client";

export default class VaultDavPlugin extends Plugin implements ProgressReporter {
    private activeSyncInterval: number = 0;
    public isSyncing: boolean = false;
    private isUnloaded: boolean = false;
    private saveSettingsPromise: Promise<void> = Promise.resolve();
    public settings: VaultDavSettings = { ...DEFAULT_SETTINGS };
    private stateStore: SyncStateStore | null = null;
    private statusBarItem: HTMLElement | null = null;
    private syncIntervalId: number | null = null;

    public configureAutoSync(): void {
        if (this.isUnloaded) {
            return;
        }
        const targetMinutes: number =
            Number.isFinite(this.settings.syncInterval) &&
            this.settings.syncInterval > 0
                ? Math.min(
                      MAX_SYNC_INTERVAL_MINUTES,
                      Math.floor(this.settings.syncInterval)
                  )
                : 0;
        if (
            targetMinutes === this.activeSyncInterval &&
            (targetMinutes === 0 || this.syncIntervalId !== null)
        ) {
            return;
        }
        if (this.syncIntervalId !== null) {
            window.clearInterval(this.syncIntervalId);
            this.syncIntervalId = null;
        }
        this.activeSyncInterval = targetMinutes;
        if (targetMinutes > 0) {
            const intervalMs: number = targetMinutes * 60 * 1000;
            const id: number = window.setInterval(() => {
                void this.triggerSync();
            }, intervalMs);
            this.syncIntervalId = this.registerInterval(id);
        }
    }

    private getResolvedSettings(): VaultDavSettings {
        const configDir: string = this.app.vault.configDir;
        const normalizedRemoteBaseDir: string = sanitizeRemoteBaseDir(
            this.settings.remoteBaseDir,
            configDir
        );
        const normalizedVaultName: string = sanitizeRemoteBaseDir(
            this.app.vault.getName(),
            configDir
        );
        const fallbackBaseDir: string =
            normalizedRemoteBaseDir !== ""
                ? normalizedRemoteBaseDir
                : normalizedVaultName !== ""
                  ? normalizedVaultName
                  : "VaultDAV";
        return {
            ...this.settings,
            remoteBaseDir: fallbackBaseDir
        };
    }

    public isConfigured(): boolean {
        return (
            this.settings.url.trim() !== "" &&
            this.settings.username.trim() !== "" &&
            this.settings.appPassword.trim() !== ""
        );
    }

    public async loadSettings(): Promise<void> {
        const loaded: unknown = await this.loadData();
        const record: Record<string, unknown> =
            typeof loaded === "object" && loaded !== null
                ? (loaded as Record<string, unknown>)
                : {};
        const configDir: string = this.app.vault.configDir;

        const appPassword: string =
            typeof record.appPassword === "string"
                ? sanitizeAppPassword(record.appPassword)
                : DEFAULT_SETTINGS.appPassword;
        const chunkSizeMB: number = sanitizeChunkSizeMB(record.chunkSizeMB);
        const chunkingThresholdMB: number = sanitizeChunkingThresholdMB(
            record.chunkingThresholdMB
        );
        const conflictStrategy: ConflictStrategy =
            record.conflictStrategy === "newest_wins" ||
            record.conflictStrategy === "keep_both"
                ? record.conflictStrategy
                : DEFAULT_SETTINGS.conflictStrategy;
        const remoteBaseDir: string =
            typeof record.remoteBaseDir === "string"
                ? sanitizeRemoteBaseDir(record.remoteBaseDir, configDir)
                : DEFAULT_SETTINGS.remoteBaseDir;
        const syncInterval: number = sanitizeSyncInterval(record.syncInterval);
        const url: string =
            typeof record.url === "string"
                ? sanitizeServerUrl(record.url)
                : DEFAULT_SETTINGS.url;
        const username: string =
            typeof record.username === "string"
                ? sanitizeUsername(record.username)
                : DEFAULT_SETTINGS.username;

        this.settings = {
            appPassword,
            chunkSizeMB,
            chunkingThresholdMB,
            conflictStrategy,
            remoteBaseDir,
            syncInterval,
            url,
            username
        };
    }

    public async onload(): Promise<void> {
        this.isUnloaded = false;
        await this.loadSettings();
        if (this.isUnloaded) {
            return;
        }
        const configDir: string = this.app.vault.configDir;
        this.stateStore = new SyncStateStore(
            this.app.vault.adapter,
            util.getSyncStateFilePath(configDir),
            configDir
        );
        this.statusBarItem = this.addStatusBarItem() ?? null;

        this.addRibbonIcon("refresh-cw", "Synchronize with Nextcloud", () => {
            void this.triggerSync();
        });

        this.addCommand({
            callback: () => {
                void this.triggerSync();
            },
            id: "sync-now",
            name: "Synchronize now"
        });

        this.addCommand({
            callback: () => {
                void this.testConnection();
            },
            id: "test-connection",
            name: "Test Nextcloud WebDAV connection"
        });

        this.addSettingTab(new VaultDavSettingTab(this.app, this));
        this.configureAutoSync();
    }

    public onunload(): void {
        this.isUnloaded = true;
        if (this.syncIntervalId !== null) {
            window.clearInterval(this.syncIntervalId);
            this.syncIntervalId = null;
        }
        this.activeSyncInterval = 0;
        this.reportProgress("");
        this.statusBarItem = null;
    }

    public reportProgress(message: string): void {
        if (this.statusBarItem === null || this.statusBarItem === undefined) {
            return;
        }
        const safeText: string =
            message === "" ? "" : redactSensitiveText(message);
        if (typeof this.statusBarItem.setText === "function") {
            this.statusBarItem.setText(safeText);
        } else {
            this.statusBarItem.textContent = safeText;
        }
    }

    public saveSettings(): Promise<void> {
        const snapshot: VaultDavSettings = { ...this.settings };
        const writeTask = async (): Promise<void> => {
            await this.saveData(snapshot);
            this.configureAutoSync();
        };
        const nextPromise: Promise<void> = this.saveSettingsPromise.then(
            writeTask,
            writeTask
        );
        this.saveSettingsPromise = nextPromise.catch(() => undefined);
        return nextPromise;
    }

    public async testConnection(): Promise<boolean> {
        if (!this.isConfigured()) {
            log.notify("Configure server URL, username, and app password first.");
            return false;
        }
        try {
            const resolvedSettings: VaultDavSettings = this.getResolvedSettings();
            const client: WebDavClient = new WebDavClient(
                resolvedSettings,
                undefined,
                this.app.vault.configDir
            );
            const ok: boolean = await client.checkConnection();
            if (ok) {
                log.notify("Connection to Nextcloud WebDAV succeeded.");
            } else {
                log.notify("Connection failed: remote folder could not be verified.");
            }
            return ok;
        } catch (err: unknown) {
            const msg: string = err instanceof Error ? err.message : String(err);
            log.error("Connection test failed:", err);
            log.notify(`Connection failed: ${msg}`);
            return false;
        }
    }

    public async triggerSync(): Promise<SyncResult | null> {
        if (this.isSyncing) {
            log.notify("Synchronization is already in progress.");
            return null;
        }
        if (!this.isConfigured()) {
            log.notify("Configure Nextcloud WebDAV settings before syncing.");
            return null;
        }

        this.isSyncing = true;
        try {
            const resolvedSettings: VaultDavSettings = this.getResolvedSettings();
            const configDir: string = this.app.vault.configDir;
            const store: SyncStateStore =
                this.stateStore ??
                new SyncStateStore(
                    this.app.vault.adapter,
                    util.getSyncStateFilePath(configDir),
                    configDir
                );
            const client: WebDavClient = new WebDavClient(
                resolvedSettings,
                undefined,
                configDir
            );
            const engine: SyncEngine = new SyncEngine(
                this.app.vault,
                client,
                store,
                resolvedSettings,
                this
            );

            log.notify("Starting synchronization...");
            const result: SyncResult = await engine.runSync();
            if (result.errors.length > 0) {
                log.notify(
                    `Sync completed with ${result.errors.length} error(s). Uploaded ${result.uploaded}, downloaded ${result.downloaded}.`
                );
            } else {
                log.notify(
                    `Sync complete (up: ${result.uploaded}, down: ${result.downloaded}, conflicts: ${result.conflictsResolved}, del: ${result.deletedLocal + result.deletedRemote}).`
                );
            }
            return result;
        } catch (err: unknown) {
            const msg: string = err instanceof Error ? err.message : String(err);
            log.error("Synchronization failed:", err);
            log.notify(`Sync failed: ${msg}`);
            return null;
        } finally {
            this.reportProgress("");
            this.isSyncing = false;
        }
    }
}
