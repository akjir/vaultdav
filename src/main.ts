import { Plugin } from "obsidian";
import { log } from "./log";
import { DEFAULT_SETTINGS, VaultDavSettingTab } from "./settings";
import { SyncEngine } from "./sync/engine";
import { SyncStateStore } from "./sync/state";
import type { SyncResult, VaultDavSettings } from "./types";
import { WebDavClient } from "./webdav/client";

export default class VaultDavPlugin extends Plugin {
    public isSyncing: boolean = false;
    public settings: VaultDavSettings = { ...DEFAULT_SETTINGS };
    private stateStore: SyncStateStore | null = null;
    private syncIntervalId: number | null = null;

    public configureAutoSync(): void {
        if (this.syncIntervalId !== null) {
            window.clearInterval(this.syncIntervalId);
            this.syncIntervalId = null;
        }
        if (this.settings.syncInterval > 0) {
            const intervalMs: number = this.settings.syncInterval * 60 * 1000;
            const id: number = window.setInterval(() => {
                void this.triggerSync();
            }, intervalMs);
            this.syncIntervalId = this.registerInterval(id);
        }
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
        const partial: Partial<VaultDavSettings> =
            typeof loaded === "object" && loaded !== null
                ? (loaded as Partial<VaultDavSettings>)
                : {};
        this.settings = {
            ...DEFAULT_SETTINGS,
            ...partial
        };
    }

    public async onload(): Promise<void> {
        await this.loadSettings();
        this.stateStore = new SyncStateStore(this.app.vault.adapter);

        this.addRibbonIcon("refresh-cw", "VaultDAV: Synchronize now", () => {
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
        if (this.syncIntervalId !== null) {
            window.clearInterval(this.syncIntervalId);
            this.syncIntervalId = null;
        }
    }

    public async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
        this.configureAutoSync();
    }

    public async testConnection(): Promise<boolean> {
        if (!this.isConfigured()) {
            log.notify("Configure Server URL, Username, and App Password first.");
            return false;
        }
        try {
            const resolvedSettings: VaultDavSettings = {
                ...this.settings,
                remoteBaseDir:
                    this.settings.remoteBaseDir.trim() !== ""
                        ? this.settings.remoteBaseDir.trim()
                        : this.app.vault.getName()
            };
            const client: WebDavClient = new WebDavClient(resolvedSettings);
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
            const resolvedSettings: VaultDavSettings = {
                ...this.settings,
                remoteBaseDir:
                    this.settings.remoteBaseDir.trim() !== ""
                        ? this.settings.remoteBaseDir.trim()
                        : this.app.vault.getName()
            };
            const store: SyncStateStore =
                this.stateStore ?? new SyncStateStore(this.app.vault.adapter);
            const client: WebDavClient = new WebDavClient(resolvedSettings);
            const engine: SyncEngine = new SyncEngine(
                this.app.vault,
                client,
                store,
                resolvedSettings
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
            this.isSyncing = false;
        }
    }
}
