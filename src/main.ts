import { Plugin, requireApiVersion, type SecretStorage } from "obsidian";
import { log, redactSensitiveText } from "./log";
import {
    DEFAULT_APP_PASSWORD_SECRET_ID,
    DEFAULT_SETTINGS,
    hasEmbeddedUrlCredentials,
    MAX_SYNC_INTERVAL_MINUTES,
    VaultDavSettingTab,
    sanitizeAppPassword,
    sanitizeChunkSizeMB,
    sanitizeChunkingThresholdMB,
    sanitizeRemoteBaseDir,
    sanitizeSecretId,
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
    VaultDavSettings,
    WebDavClientConfig
} from "./types";
import { util } from "./utilities";
import { WebDavClient } from "./webdav/client";

const MAX_MIGRATION_SECRET_ATTEMPTS: number = 1000;

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

    public getAppPassword(): string {
        const secretId: string = sanitizeSecretId(
            this.settings.appPasswordSecret
        );
        if (secretId === "") {
            return "";
        }
        const storage: SecretStorage | null = this.getSecretStorage();
        if (storage === null) {
            return "";
        }
        try {
            const storedSecret: string | null = storage.getSecret(secretId);
            if (typeof storedSecret !== "string") {
                return "";
            }
            return sanitizeAppPassword(storedSecret);
        } catch (err: unknown) {
            log.warn("Failed to read app password from secret storage:", err);
            return "";
        }
    }

    private getResolvedClientConfig(
        resolvedSettings: VaultDavSettings,
        appPassword: string
    ): WebDavClientConfig {
        return {
            appPassword,
            chunkSizeMB: resolvedSettings.chunkSizeMB,
            chunkingThresholdMB: resolvedSettings.chunkingThresholdMB,
            remoteBaseDir: resolvedSettings.remoteBaseDir,
            url: resolvedSettings.url,
            username: resolvedSettings.username
        };
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

    private getSecretStorage(): SecretStorage | null {
        if (!requireApiVersion("1.11.4")) {
            return null;
        }
        const storage: SecretStorage | undefined = this.app.secretStorage;
        if (
            storage === undefined ||
            storage === null ||
            typeof storage.getSecret !== "function" ||
            typeof storage.setSecret !== "function"
        ) {
            return null;
        }
        return storage;
    }

    public hasSecretStorage(): boolean {
        return this.getSecretStorage() !== null;
    }

    public isConfigured(): boolean {
        return (
            this.settings.url.trim() !== "" &&
            this.settings.username.trim() !== "" &&
            this.getAppPassword() !== ""
        );
    }

    public async loadSettings(): Promise<void> {
        const loaded: unknown = await this.loadData();
        if (this.isUnloaded) {
            return;
        }
        const record: Record<string, unknown> =
            typeof loaded === "object" && loaded !== null
                ? (loaded as Record<string, unknown>)
                : {};
        const configDir: string = this.app.vault.configDir;

        let appPasswordSecret: string = sanitizeSecretId(
            record.appPasswordSecret
        );
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
        const rawUrl: string = typeof record.url === "string" ? record.url : "";
        const hadEmbeddedUrlCredentials: boolean =
            rawUrl !== "" && hasEmbeddedUrlCredentials(rawUrl);
        const url: string =
            rawUrl !== "" ? sanitizeServerUrl(rawUrl) : DEFAULT_SETTINGS.url;
        const username: string =
            typeof record.username === "string"
                ? sanitizeUsername(record.username)
                : DEFAULT_SETTINGS.username;

        const hasLegacyPasswordField: boolean =
            Object.prototype.hasOwnProperty.call(record, "appPassword");
        const legacyAppPassword: string =
            typeof record.appPassword === "string"
                ? sanitizeAppPassword(record.appPassword)
                : "";
        let shouldPersistScrubbedSettings: boolean = hadEmbeddedUrlCredentials;

        if (hasLegacyPasswordField) {
            if (legacyAppPassword === "") {
                shouldPersistScrubbedSettings = true;
            } else {
                const migratedSecretId: string | null =
                    this.migrateLegacyAppPassword(
                        legacyAppPassword,
                        appPasswordSecret
                    );
                if (migratedSecretId !== null) {
                    appPasswordSecret = migratedSecretId;
                    shouldPersistScrubbedSettings = true;
                }
            }
        }

        this.settings = {
            appPasswordSecret,
            chunkSizeMB,
            chunkingThresholdMB,
            conflictStrategy,
            remoteBaseDir,
            syncInterval,
            url,
            username
        };

        if (shouldPersistScrubbedSettings && !this.isUnloaded) {
            try {
                await this.persistSettingsData();
            } catch (err: unknown) {
                log.error(
                    "Failed to remove legacy plaintext credentials from plugin data:",
                    err
                );
            }
        }
    }

    private migrateLegacyAppPassword(
        legacyAppPassword: string,
        existingSecretId: string
    ): string | null {
        const storage: SecretStorage | null = this.getSecretStorage();
        if (storage === null) {
            log.warn(
                "Obsidian 1.11.4 or newer is required to migrate the stored app password into secret storage."
            );
            return null;
        }
        try {
            const resolved: { secretId: string; shouldWrite: boolean } | null =
                this.resolveMigrationSecretId(
                    storage,
                    existingSecretId,
                    legacyAppPassword
                );
            if (resolved === null) {
                log.warn(
                    "Unable to allocate an unused secret ID for legacy app password migration."
                );
                return null;
            }
            if (resolved.shouldWrite) {
                storage.setSecret(resolved.secretId, legacyAppPassword);
                const verified: string | null = storage.getSecret(
                    resolved.secretId
                );
                if (
                    typeof verified !== "string" ||
                    sanitizeAppPassword(verified) !== legacyAppPassword
                ) {
                    log.error(
                        "Failed to verify migrated app password in secret storage."
                    );
                    return null;
                }
            }
            return resolved.secretId;
        } catch (err: unknown) {
            log.error(
                "Failed to migrate legacy app password to secret storage:",
                err
            );
            return null;
        }
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

    private persistSettingsData(): Promise<void> {
        const snapshot: VaultDavSettings = {
            appPasswordSecret: sanitizeSecretId(this.settings.appPasswordSecret),
            chunkSizeMB: this.settings.chunkSizeMB,
            chunkingThresholdMB: this.settings.chunkingThresholdMB,
            conflictStrategy: this.settings.conflictStrategy,
            remoteBaseDir: this.settings.remoteBaseDir,
            syncInterval: this.settings.syncInterval,
            url: sanitizeServerUrl(this.settings.url),
            username: this.settings.username
        };
        const writeTask = async (): Promise<void> => {
            await this.saveData(snapshot);
        };
        const nextPromise: Promise<void> = this.saveSettingsPromise.then(
            writeTask,
            writeTask
        );
        this.saveSettingsPromise = nextPromise.catch(() => undefined);
        return nextPromise;
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

    private resolveMigrationSecretId(
        storage: SecretStorage,
        existingSecretId: string,
        legacyAppPassword: string
    ): { secretId: string; shouldWrite: boolean } | null {
        if (existingSecretId !== "") {
            const existingSecret: string | null =
                storage.getSecret(existingSecretId);
            if (
                typeof existingSecret === "string" &&
                sanitizeAppPassword(existingSecret) !== ""
            ) {
                return { secretId: existingSecretId, shouldWrite: false };
            }
            return { secretId: existingSecretId, shouldWrite: true };
        }

        const listedIds: ReadonlySet<string> = new Set<string>(
            typeof storage.listSecrets === "function"
                ? storage.listSecrets()
                : []
        );
        for (
            let attempt: number = 1;
            attempt <= MAX_MIGRATION_SECRET_ATTEMPTS;
            attempt += 1
        ) {
            const candidate: string =
                attempt === 1
                    ? DEFAULT_APP_PASSWORD_SECRET_ID
                    : `${DEFAULT_APP_PASSWORD_SECRET_ID}-${attempt}`;
            const existingValue: string | null = storage.getSecret(candidate);
            if (
                typeof existingValue === "string" &&
                sanitizeAppPassword(existingValue) === legacyAppPassword
            ) {
                return { secretId: candidate, shouldWrite: false };
            }
            if (!listedIds.has(candidate) && existingValue === null) {
                return { secretId: candidate, shouldWrite: true };
            }
        }
        return null;
    }

    public async saveSettings(): Promise<void> {
        await this.persistSettingsData();
        this.configureAutoSync();
    }

    public async testConnection(): Promise<boolean> {
        if (!this.hasSecretStorage()) {
            log.notify(
                "Obsidian 1.11.4 or newer is required for secure password storage."
            );
            return false;
        }
        const secretId: string = sanitizeSecretId(
            this.settings.appPasswordSecret
        );
        if (
            this.settings.url.trim() === "" ||
            this.settings.username.trim() === "" ||
            secretId === ""
        ) {
            log.notify("Configure server URL, username, and app password first.");
            return false;
        }
        const appPassword: string = this.getAppPassword();
        if (appPassword === "") {
            log.notify("App password secret was not found in secret storage.");
            return false;
        }
        try {
            const resolvedSettings: VaultDavSettings = this.getResolvedSettings();
            const clientConfig: WebDavClientConfig =
                this.getResolvedClientConfig(resolvedSettings, appPassword);
            const client: WebDavClient = new WebDavClient(
                clientConfig,
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
        if (!this.hasSecretStorage()) {
            log.notify(
                "Obsidian 1.11.4 or newer is required for secure password storage."
            );
            return null;
        }
        const secretId: string = sanitizeSecretId(
            this.settings.appPasswordSecret
        );
        if (
            this.settings.url.trim() === "" ||
            this.settings.username.trim() === "" ||
            secretId === ""
        ) {
            log.notify("Configure Nextcloud WebDAV settings before syncing.");
            return null;
        }
        const appPassword: string = this.getAppPassword();
        if (appPassword === "") {
            log.notify("App password secret was not found in secret storage.");
            return null;
        }

        this.isSyncing = true;
        try {
            const resolvedSettings: VaultDavSettings = this.getResolvedSettings();
            const clientConfig: WebDavClientConfig =
                this.getResolvedClientConfig(resolvedSettings, appPassword);
            const configDir: string = this.app.vault.configDir;
            const store: SyncStateStore =
                this.stateStore ??
                new SyncStateStore(
                    this.app.vault.adapter,
                    util.getSyncStateFilePath(configDir),
                    configDir
                );
            const client: WebDavClient = new WebDavClient(
                clientConfig,
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
