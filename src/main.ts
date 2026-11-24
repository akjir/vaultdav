import {
    Plugin,
    requireApiVersion,
    type SecretStorage,
    type WorkspaceLeaf
} from "obsidian";
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
    sanitizeSyncLogRetentionDays,
    sanitizeUsername
} from "./settings";
import { SyncEngine } from "./sync/engine";
import { createEmptyRunSummary, SyncHistoryStore } from "./sync/history";
import { SyncStateStore } from "./sync/state";
import type {
    ConflictStrategy,
    ProgressReporter,
    SyncResult,
    SyncRunRecord,
    SyncRunSummary,
    SyncRunTrigger,
    VaultDavSettings,
    WebDavClientConfig
} from "./types";
import { SYNC_LOG_VIEW_TYPE, SyncLogView } from "./ui/sync_log_view";
import { util } from "./utilities";
import { WebDavClient } from "./webdav/client";

const MAX_MIGRATION_SECRET_ATTEMPTS: number = 1000;

function createFallbackSummary(result: SyncResult): SyncRunSummary {
    if (result.summary !== undefined) {
        return { ...result.summary };
    }
    const summary: SyncRunSummary = createEmptyRunSummary();
    summary.conflictsResolved = result.conflictsResolved;
    summary.deletedLocal = result.deletedLocal;
    summary.deletedRemote = result.deletedRemote;
    summary.downloaded = result.downloaded;
    summary.errors = result.errors.length;
    summary.uploaded = result.uploaded;
    return summary;
}

export default class VaultDavPlugin extends Plugin implements ProgressReporter {
    private activeSyncInterval: number = 0;
    private historyStore: SyncHistoryStore | null = null;
    public isSyncing: boolean = false;
    private isUnloaded: boolean = false;
    private runIdSequence: number = 0;
    private saveSettingsPromise: Promise<void> = Promise.resolve();
    public settings: VaultDavSettings = { ...DEFAULT_SETTINGS };
    private stateStore: SyncStateStore | null = null;
    private statusBarItem: HTMLElement | null = null;
    private syncIntervalId: number | null = null;

    public async clearSyncHistory(): Promise<void> {
        const store: SyncHistoryStore = this.getHistoryStore();
        await store.clear();
        this.reportProgress("");
        this.refreshSyncLogViews();
    }

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
                void this.triggerSync("auto");
            }, intervalMs);
            this.syncIntervalId = this.registerInterval(id);
        }
    }

    private createRunId(timestamp: number): string {
        this.runIdSequence += 1;
        const safeTimestamp: number =
            Number.isFinite(timestamp) && timestamp > 0
                ? Math.floor(timestamp)
                : 0;
        return `${safeTimestamp}-${this.runIdSequence}`;
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

    private getHistoryStore(): SyncHistoryStore {
        if (this.historyStore === null) {
            const configDir: string = this.app.vault.configDir;
            this.historyStore = new SyncHistoryStore(
                this.app.vault.adapter,
                util.getSyncHistoryFilePath(configDir),
                configDir
            );
        }
        return this.historyStore;
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

    public getSyncHistoryRuns(): SyncRunRecord[] {
        return this.historyStore !== null ? this.historyStore.getRuns() : [];
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
        const syncLogRetentionDays: number = sanitizeSyncLogRetentionDays(
            record.syncLogRetentionDays
        );
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
            syncLogRetentionDays,
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

    public async loadSyncHistory(): Promise<SyncRunRecord[]> {
        try {
            const store: SyncHistoryStore = this.getHistoryStore();
            const data = await store.load(this.settings.syncLogRetentionDays);
            return data.runs;
        } catch (err: unknown) {
            log.warn("Failed to load sync history:", err);
            return [];
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
        this.historyStore = new SyncHistoryStore(
            this.app.vault.adapter,
            util.getSyncHistoryFilePath(configDir),
            configDir
        );
        this.statusBarItem = this.addStatusBarItem() ?? null;
        if (this.statusBarItem !== null) {
            this.registerDomEvent(this.statusBarItem, "click", (): void => {
                void this.openSyncLogView();
            });
        }

        this.registerView(
            SYNC_LOG_VIEW_TYPE,
            (leaf: WorkspaceLeaf): SyncLogView => new SyncLogView(leaf, this)
        );

        this.addRibbonIcon("refresh-cw", "Synchronize with Nextcloud", () => {
            void this.triggerSync("manual");
        });

        this.addRibbonIcon("history", "Open sync log", () => {
            void this.openSyncLogView();
        });

        this.addCommand({
            callback: () => {
                void this.triggerSync("manual");
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

        this.addCommand({
            callback: () => {
                void this.openSyncLogView();
            },
            id: "open-sync-log",
            name: "Open sync log"
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

    public async openSyncLogView(): Promise<void> {
        if (
            this.app.workspace === undefined ||
            typeof this.app.workspace.getLeavesOfType !== "function"
        ) {
            return;
        }
        const existingLeaves: WorkspaceLeaf[] =
            this.app.workspace.getLeavesOfType(SYNC_LOG_VIEW_TYPE);
        let leaf: WorkspaceLeaf | null = existingLeaves[0] ?? null;
        if (leaf === null) {
            const rightLeaf: WorkspaceLeaf | null =
                typeof this.app.workspace.getRightLeaf === "function"
                    ? this.app.workspace.getRightLeaf(false)
                    : null;
            leaf =
                rightLeaf ??
                (typeof this.app.workspace.getLeaf === "function"
                    ? this.app.workspace.getLeaf(true)
                    : null);
            if (leaf === null) {
                return;
            }
            await leaf.setViewState({
                active: true,
                type: SYNC_LOG_VIEW_TYPE
            });
        }
        if (typeof this.app.workspace.revealLeaf === "function") {
            await this.app.workspace.revealLeaf(leaf);
        }
    }

    private persistSettingsData(): Promise<void> {
        const snapshot: VaultDavSettings = {
            appPasswordSecret: sanitizeSecretId(this.settings.appPasswordSecret),
            chunkSizeMB: this.settings.chunkSizeMB,
            chunkingThresholdMB: this.settings.chunkingThresholdMB,
            conflictStrategy: this.settings.conflictStrategy,
            remoteBaseDir: this.settings.remoteBaseDir,
            syncInterval: this.settings.syncInterval,
            syncLogRetentionDays: this.settings.syncLogRetentionDays,
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

    private async recordSyncRunSafely(run: SyncRunRecord): Promise<void> {
        try {
            const store: SyncHistoryStore = this.getHistoryStore();
            await store.recordRun(
                run,
                this.settings.syncLogRetentionDays,
                run.finishedAt
            );
        } catch (err: unknown) {
            log.warn("Failed to save sync history entry:", err);
        }
    }

    public refreshSyncLogViews(): void {
        if (
            this.app.workspace === undefined ||
            typeof this.app.workspace.getLeavesOfType !== "function"
        ) {
            return;
        }
        const leaves: WorkspaceLeaf[] =
            this.app.workspace.getLeavesOfType(SYNC_LOG_VIEW_TYPE);
        for (const leaf of leaves) {
            if (leaf.view instanceof SyncLogView) {
                leaf.view.refresh();
            }
        }
    }

    public reportProgress(message: string): void {
        if (this.statusBarItem === null || this.statusBarItem === undefined) {
            return;
        }
        this.statusBarItem.classList.remove("vaultdav-status-error");
        this.statusBarItem.removeAttribute("title");
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

    private setStatusBarError(message: string): void {
        if (this.statusBarItem === null || this.statusBarItem === undefined) {
            return;
        }
        const safeText: string = redactSensitiveText(message);
        if (typeof this.statusBarItem.setText === "function") {
            this.statusBarItem.setText(safeText);
        } else {
            this.statusBarItem.textContent = safeText;
        }
        this.statusBarItem.classList.add("vaultdav-status-error");
        this.statusBarItem.setAttribute("title", "Open sync log");
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

    public async triggerSync(
        trigger: SyncRunTrigger = "manual"
    ): Promise<SyncResult | null> {
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

        const startedAt: number = Date.now();
        let hasErrorStatus: boolean = false;
        this.isSyncing = true;
        this.refreshSyncLogViews();
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
            const finishedAt: number = Date.now();
            const runSummary: SyncRunSummary = createFallbackSummary(result);
            const runRecord: SyncRunRecord = {
                collapsedCount: 1,
                detailsPruned: false,
                durationMs: Math.max(0, finishedAt - startedAt),
                events: Array.isArray(result.events) ? result.events : [],
                finishedAt,
                id: this.createRunId(finishedAt),
                omittedEvents: 0,
                startedAt,
                status: result.errors.length > 0 ? "partial" : "success",
                summary: runSummary,
                trigger
            };
            await this.recordSyncRunSafely(runRecord);

            if (result.errors.length > 0) {
                hasErrorStatus = true;
                const errorStatusText: string =
                    result.errors.length === 1
                        ? "VaultDAV: 1 sync error"
                        : `VaultDAV: ${result.errors.length} sync errors`;
                this.setStatusBarError(errorStatusText);
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
            const finishedAt: number = Date.now();
            const msg: string = err instanceof Error ? err.message : String(err);
            const failedSummary: SyncRunSummary = createEmptyRunSummary();
            failedSummary.errors = 1;
            const failedRun: SyncRunRecord = {
                collapsedCount: 1,
                detailsPruned: false,
                durationMs: Math.max(0, finishedAt - startedAt),
                events: [
                    {
                        kind: "error",
                        message: redactSensitiveText(msg)
                    }
                ],
                finishedAt,
                id: this.createRunId(finishedAt),
                omittedEvents: 0,
                startedAt,
                status: "failed",
                summary: failedSummary,
                trigger
            };
            await this.recordSyncRunSafely(failedRun);
            hasErrorStatus = true;
            this.setStatusBarError("VaultDAV: sync failed");
            log.error("Synchronization failed:", err);
            log.notify(`Sync failed: ${msg}`);
            return null;
        } finally {
            if (!hasErrorStatus) {
                this.reportProgress("");
            }
            this.isSyncing = false;
            this.refreshSyncLogViews();
        }
    }
}
