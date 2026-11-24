import * as obsidian from "obsidian";
import type { App, Command, PluginManifest } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { log } from "../src/log";
import VaultDavPlugin from "../src/main";
import {
    DEFAULT_APP_PASSWORD_SECRET_ID,
    DEFAULT_SETTINGS,
    VaultDavSettingTab
} from "../src/settings";
import { SyncEngine } from "../src/sync/engine";
import { createEmptyRunSummary, SyncHistoryStore } from "../src/sync/history";
import type { SyncResult, VaultDavSettings } from "../src/types";
import { SYNC_LOG_VIEW_TYPE, SyncLogView } from "../src/ui/sync_log_view";
import { WebDavClient } from "../src/webdav/client";
import {
    SecretStorage as MockSecretStorage,
    WorkspaceLeaf as MockWorkspaceLeaf
} from "./obsidian_mock";

function createConfiguredSettings(
    overrides: Partial<VaultDavSettings> = {}
): VaultDavSettings {
    return {
        ...DEFAULT_SETTINGS,
        appPasswordSecret: DEFAULT_APP_PASSWORD_SECRET_ID,
        remoteBaseDir: "ObsidianVault",
        url: "https://cloud.example.com",
        username: "alice",
        ...overrides
    };
}

function createTestPlugin(
    vaultName: string = "MyVault",
    configDir: string = ".obsidian",
    includeSecretStorage: boolean = true
): {
    app: App;
    plugin: VaultDavPlugin;
    secretStorage: MockSecretStorage;
} {
    const secretStorage: MockSecretStorage = new MockSecretStorage();
    const mockApp: App = {
        ...(includeSecretStorage ? { secretStorage } : {}),
        vault: {
            adapter: {
                exists: async (): Promise<boolean> => false,
                mkdir: async (): Promise<void> => undefined,
                read: async (): Promise<string> => "{}",
                write: async (): Promise<void> => undefined
            },
            configDir,
            getName: (): string => vaultName
        }
    } as unknown as App;

    const mockManifest: PluginManifest = {
        author: "Test",
        description: "Test",
        id: "vaultdav",
        isDesktopOnly: false,
        minAppVersion: "1.11.4",
        name: "VaultDAV",
        version: "0.1.0"
    };

    const plugin: VaultDavPlugin = new VaultDavPlugin(mockApp, mockManifest);
    return { app: mockApp, plugin, secretStorage };
}

describe("VaultDavPlugin lifecycle, settings, and actions", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("falls back safely in loadSettings() when loadData() returns null, primitives, or malformed fields, and migrates legacy plaintext appPassword into SecretStorage", async () => {
        const { plugin, secretStorage } = createTestPlugin();
        const saveDataSpy = vi.spyOn(plugin, "saveData").mockResolvedValue(undefined);

        vi.spyOn(plugin, "loadData").mockResolvedValueOnce(null);
        await plugin.loadSettings();
        expect(plugin.settings).toEqual(DEFAULT_SETTINGS);
        expect(saveDataSpy).not.toHaveBeenCalled();

        vi.spyOn(plugin, "loadData").mockResolvedValueOnce("primitive-string");
        await plugin.loadSettings();
        expect(plugin.settings).toEqual(DEFAULT_SETTINGS);

        vi.spyOn(plugin, "loadData").mockResolvedValueOnce(42);
        await plugin.loadSettings();
        expect(plugin.settings).toEqual(DEFAULT_SETTINGS);

        vi.spyOn(plugin, "loadData").mockResolvedValueOnce({
            appPassword: 999,
            appPasswordSecret: "INVALID_SECRET!",
            conflictStrategy: "invalid_mode",
            remoteBaseDir: "  //Notes//Vault/  ",
            syncInterval: -5,
            url: { nested: true },
            username: ["alice"]
        });
        await plugin.loadSettings();
        expect(plugin.settings).toEqual({
            ...DEFAULT_SETTINGS,
            remoteBaseDir: "Notes/Vault"
        });
        expect(saveDataSpy).toHaveBeenCalledTimes(1);
        expect(
            Object.prototype.hasOwnProperty.call(
                saveDataSpy.mock.calls[0]?.[0] as Record<string, unknown>,
                "appPassword"
            )
        ).toBe(false);

        vi.spyOn(plugin, "loadData").mockResolvedValueOnce({
            appPassword: "  secret  ",
            chunkSizeMB: 0,
            chunkingThresholdMB: -10,
            conflictStrategy: "newest_wins",
            remoteBaseDir: 123,
            syncInterval: "invalid",
            url: "  https://nc.example.com  ",
            username: "  bob  "
        });
        await plugin.loadSettings();
        expect(plugin.settings).toEqual({
            appPasswordSecret: DEFAULT_APP_PASSWORD_SECRET_ID,
            chunkSizeMB: 10,
            chunkingThresholdMB: 90,
            conflictStrategy: "newest_wins",
            remoteBaseDir: "",
            syncInterval: 0,
            syncLogRetentionDays: 30,
            url: "https://nc.example.com",
            username: "bob"
        });
        expect(secretStorage.getSecret(DEFAULT_APP_PASSWORD_SECRET_ID)).toBe("secret");
        expect(plugin.getAppPassword()).toBe("secret");
        const migratedData: Record<string, unknown> =
            saveDataSpy.mock.calls[1]?.[0] as Record<string, unknown>;
        expect(migratedData.appPasswordSecret).toBe(DEFAULT_APP_PASSWORD_SECRET_ID);
        expect(Object.prototype.hasOwnProperty.call(migratedData, "appPassword")).toBe(
            false
        );

        vi.spyOn(plugin, "loadData").mockResolvedValueOnce({
            appPasswordSecret: "  custom-nc-key  ",
            chunkSizeMB: 16.8,
            chunkingThresholdMB: 105.4,
            conflictStrategy: "keep_both",
            syncInterval: 12.9
        });
        await plugin.loadSettings();
        expect(plugin.settings.appPasswordSecret).toBe("custom-nc-key");
        expect(plugin.settings.conflictStrategy).toBe("keep_both");
        expect(plugin.settings.syncInterval).toBe(12);
        expect(plugin.settings.chunkingThresholdMB).toBe(105);
        expect(plugin.settings.chunkSizeMB).toBe(16);
    });

    it("handles collision-safe legacy appPassword migration, deduplication, SecretStorage failures, and unavailable SecretStorage", async () => {
        const { plugin, secretStorage } = createTestPlugin();
        const saveDataSpy = vi.spyOn(plugin, "saveData").mockResolvedValue(undefined);
        const errorSpy = vi.spyOn(log, "error").mockImplementation((): void => undefined);
        const warnSpy = vi.spyOn(log, "warn").mockImplementation((): void => undefined);

        // 1. Existing secret under default ID with DIFFERENT value must not be overwritten
        secretStorage.setSecret(DEFAULT_APP_PASSWORD_SECRET_ID, "vault-a-password");
        vi.spyOn(plugin, "loadData").mockResolvedValueOnce({
            appPassword: "vault-b-password",
            url: "https://cloud.example.com",
            username: "alice"
        });
        await plugin.loadSettings();
        expect(plugin.settings.appPasswordSecret).toBe(
            `${DEFAULT_APP_PASSWORD_SECRET_ID}-2`
        );
        expect(secretStorage.getSecret(DEFAULT_APP_PASSWORD_SECRET_ID)).toBe(
            "vault-a-password"
        );
        expect(secretStorage.getSecret(`${DEFAULT_APP_PASSWORD_SECRET_ID}-2`)).toBe(
            "vault-b-password"
        );
        expect(saveDataSpy).toHaveBeenCalledTimes(1);

        // 2. Existing secret with SAME value reuses existing ID without duplicating
        vi.spyOn(plugin, "loadData").mockResolvedValueOnce({
            appPassword: "vault-a-password",
            url: "https://cloud.example.com",
            username: "alice"
        });
        await plugin.loadSettings();
        expect(plugin.settings.appPasswordSecret).toBe(DEFAULT_APP_PASSWORD_SECRET_ID);
        expect(secretStorage.listSecrets()).toEqual([
            DEFAULT_APP_PASSWORD_SECRET_ID,
            `${DEFAULT_APP_PASSWORD_SECRET_ID}-2`
        ]);
        expect(saveDataSpy).toHaveBeenCalledTimes(2);

        // 3. Existing valid appPasswordSecret in data.json is kept and stale legacy appPassword is purged
        secretStorage.setSecret("my-own-secret", "real-secret");
        vi.spyOn(plugin, "loadData").mockResolvedValueOnce({
            appPassword: "stale-legacy-password",
            appPasswordSecret: "my-own-secret",
            url: "https://cloud.example.com",
            username: "alice"
        });
        await plugin.loadSettings();
        expect(plugin.settings.appPasswordSecret).toBe("my-own-secret");
        expect(secretStorage.getSecret("my-own-secret")).toBe("real-secret");
        expect(saveDataSpy).toHaveBeenCalledTimes(3);

        // 4. Failing setSecret must NOT purge data.json and must not leak password
        vi.spyOn(secretStorage, "setSecret").mockImplementationOnce(() => {
            throw new Error("Keychain locked");
        });
        vi.spyOn(plugin, "loadData").mockResolvedValueOnce({
            appPassword: "brand-new-secret-pw",
            url: "https://cloud.example.com",
            username: "alice"
        });
        await plugin.loadSettings();
        expect(plugin.settings.appPasswordSecret).toBe("");
        expect(saveDataSpy).toHaveBeenCalledTimes(3);
        expect(errorSpy).toHaveBeenCalledWith(
            "Failed to migrate legacy app password to secret storage:",
            expect.any(Error)
        );

        // 5. Unavailable SecretStorage fails closed without clobbering legacy data.json
        const { plugin: oldPlugin } = createTestPlugin("MyVault", ".obsidian", false);
        const oldSaveSpy = vi.spyOn(oldPlugin, "saveData").mockResolvedValue(undefined);
        vi.spyOn(oldPlugin, "loadData").mockResolvedValueOnce({
            appPassword: "legacy-pw",
            url: "https://cloud.example.com",
            username: "alice"
        });
        await oldPlugin.loadSettings();
        expect(oldPlugin.settings.appPasswordSecret).toBe("");
        expect(oldPlugin.isConfigured()).toBe(false);
        expect(oldSaveSpy).not.toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalled();
    });

    it("checks credentials dynamically against SecretStorage in isConfigured() and getAppPassword()", () => {
        const { plugin, secretStorage } = createTestPlugin();
        expect(plugin.isConfigured()).toBe(false);

        secretStorage.setSecret(DEFAULT_APP_PASSWORD_SECRET_ID, "app-password-123");

        plugin.settings = createConfiguredSettings({ url: "   " });
        expect(plugin.isConfigured()).toBe(false);

        plugin.settings = createConfiguredSettings({ username: "   " });
        expect(plugin.isConfigured()).toBe(false);

        plugin.settings = createConfiguredSettings({ appPasswordSecret: "   " });
        expect(plugin.isConfigured()).toBe(false);

        plugin.settings = createConfiguredSettings({
            appPasswordSecret: "missing-secret"
        });
        expect(plugin.isConfigured()).toBe(false);

        plugin.settings = createConfiguredSettings();
        expect(plugin.isConfigured()).toBe(true);
        expect(plugin.getAppPassword()).toBe("app-password-123");

        // Live rotation in SecretStorage is observed immediately without caching
        secretStorage.setSecret(DEFAULT_APP_PASSWORD_SECRET_ID, "  rotated-pw-456  ");
        expect(plugin.getAppPassword()).toBe("rotated-pw-456");

        // Control characters in SecretStorage value are rejected
        secretStorage.setSecret(DEFAULT_APP_PASSWORD_SECRET_ID, "bad\r\npw");
        expect(plugin.getAppPassword()).toBe("");
        expect(plugin.isConfigured()).toBe(false);
    });

    it("registers ribbon icon, status bar item, commands, setting tab, and auto-sync in onload(), and cleans up in onunload()", async () => {
        vi.useFakeTimers();
        const { plugin } = createTestPlugin();
        vi.spyOn(plugin, "loadData").mockResolvedValueOnce(
            createConfiguredSettings({ syncInterval: 10 })
        );

        const ribbonSpy = vi
            .spyOn(plugin, "addRibbonIcon")
            .mockImplementation(
                (
                    _icon: string,
                    _title: string,
                    _callback: (evt: MouseEvent) => unknown
                ): HTMLElement => document.createElement("div")
            );
        const statusBarEl: HTMLElement = document.createElement("div");
        const setTextSpy = vi.fn((text: string): void => {
            statusBarEl.textContent = text;
        });
        statusBarEl.setText = setTextSpy;
        const statusBarSpy = vi
            .spyOn(plugin, "addStatusBarItem")
            .mockReturnValue(statusBarEl);
        const registeredCommands: Command[] = [];
        const commandSpy = vi
            .spyOn(plugin, "addCommand")
            .mockImplementation((command: Command): Command => {
                registeredCommands.push(command);
                return command;
            });
        const settingTabSpy = vi.spyOn(plugin, "addSettingTab");
        const registerIntervalSpy = vi.spyOn(plugin, "registerInterval");
        const clearIntervalSpy = vi.spyOn(window, "clearInterval");
        const triggerSyncSpy = vi
            .spyOn(plugin, "triggerSync")
            .mockResolvedValue(null);
        const testConnectionSpy = vi
            .spyOn(plugin, "testConnection")
            .mockResolvedValue(true);
        const openSyncLogSpy = vi
            .spyOn(plugin, "openSyncLogView")
            .mockResolvedValue(undefined);
        const registerViewSpy = vi.spyOn(plugin, "registerView");

        await plugin.onload();

        expect(registerViewSpy).toHaveBeenCalledWith(
            SYNC_LOG_VIEW_TYPE,
            expect.any(Function)
        );
        expect(ribbonSpy).toHaveBeenCalledTimes(2);
        expect(ribbonSpy).toHaveBeenNthCalledWith(
            1,
            "refresh-cw",
            "Synchronize with Nextcloud",
            expect.any(Function)
        );
        expect(ribbonSpy).toHaveBeenNthCalledWith(
            2,
            "history",
            "Open sync log",
            expect.any(Function)
        );
        expect(statusBarSpy).toHaveBeenCalledTimes(1);
        plugin.reportProgress("Uploading notes.md (3/12 · file 5/18)");
        expect(setTextSpy).toHaveBeenCalledWith("Uploading notes.md (3/12 · file 5/18)");
        expect(commandSpy).toHaveBeenCalledTimes(3);
        expect(registeredCommands.map((cmd: Command) => cmd.id)).toEqual([
            "sync-now",
            "test-connection",
            "open-sync-log"
        ]);
        expect(registeredCommands.map((cmd: Command) => cmd.name)).toEqual([
            "Synchronize now",
            "Test Nextcloud WebDAV connection",
            "Open sync log"
        ]);
        expect(settingTabSpy).toHaveBeenCalledTimes(1);
        expect(settingTabSpy.mock.calls[0]?.[0]).toBeInstanceOf(VaultDavSettingTab);
        expect(registerIntervalSpy).toHaveBeenCalledTimes(1);

        const syncRibbonCallback: ((evt: MouseEvent) => unknown) | undefined =
            ribbonSpy.mock.calls[0]?.[2];
        syncRibbonCallback?.(new MouseEvent("click"));
        expect(triggerSyncSpy).toHaveBeenCalledWith("manual");

        const logRibbonCallback: ((evt: MouseEvent) => unknown) | undefined =
            ribbonSpy.mock.calls[1]?.[2];
        logRibbonCallback?.(new MouseEvent("click"));
        expect(openSyncLogSpy).toHaveBeenCalledTimes(1);

        registeredCommands[0]?.callback?.();
        expect(triggerSyncSpy).toHaveBeenCalledTimes(2);

        registeredCommands[1]?.callback?.();
        expect(testConnectionSpy).toHaveBeenCalledTimes(1);

        registeredCommands[2]?.callback?.();
        expect(openSyncLogSpy).toHaveBeenCalledTimes(2);

        statusBarEl.dispatchEvent(new MouseEvent("click"));
        expect(openSyncLogSpy).toHaveBeenCalledTimes(3);

        vi.advanceTimersByTime(10 * 60 * 1000);
        expect(triggerSyncSpy).toHaveBeenCalledWith("auto");
        expect(triggerSyncSpy).toHaveBeenCalledTimes(3);

        plugin.onunload();
        expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
        expect(setTextSpy).toHaveBeenLastCalledWith("");

        vi.advanceTimersByTime(10 * 60 * 1000);
        expect(triggerSyncSpy).toHaveBeenCalledTimes(3);
    });

    it("does not recreate auto-sync interval when syncInterval is unchanged, and clears interval when set to 0", async () => {
        vi.useFakeTimers();
        const { plugin } = createTestPlugin();
        const saveDataSpy = vi.spyOn(plugin, "saveData").mockResolvedValue(undefined);
        const setIntervalSpy = vi.spyOn(window, "setInterval");
        const clearIntervalSpy = vi.spyOn(window, "clearInterval");
        const registerIntervalSpy = vi.spyOn(plugin, "registerInterval");

        plugin.settings = createConfiguredSettings({ syncInterval: 0 });
        await plugin.saveSettings();
        expect(saveDataSpy).toHaveBeenCalledTimes(1);
        expect(setIntervalSpy).not.toHaveBeenCalled();

        plugin.settings.syncInterval = 15;
        await plugin.saveSettings();
        expect(setIntervalSpy).toHaveBeenCalledTimes(1);
        expect(registerIntervalSpy).toHaveBeenCalledTimes(1);

        plugin.settings.url = "https://other.example.com";
        await plugin.saveSettings();
        expect(setIntervalSpy).toHaveBeenCalledTimes(1);
        expect(clearIntervalSpy).not.toHaveBeenCalled();

        plugin.settings.syncInterval = 15.7;
        await plugin.saveSettings();
        expect(setIntervalSpy).toHaveBeenCalledTimes(1);
        expect(clearIntervalSpy).not.toHaveBeenCalled();

        plugin.settings.syncInterval = 30;
        await plugin.saveSettings();
        expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
        expect(setIntervalSpy).toHaveBeenCalledTimes(2);

        plugin.settings.syncInterval = 0;
        await plugin.saveSettings();
        expect(clearIntervalSpy).toHaveBeenCalledTimes(2);
        expect(setIntervalSpy).toHaveBeenCalledTimes(2);

        await plugin.saveSettings();
        expect(clearIntervalSpy).toHaveBeenCalledTimes(2);
    });

    it("handles unconfigured state, missing secret, unsupported API, fallback remoteBaseDir, success, failure, and thrown errors in testConnection()", async () => {
        const { plugin, secretStorage } = createTestPlugin("  /FallbackVault/  ");
        const notifySpy = vi.spyOn(log, "notify").mockImplementation((): void => undefined);
        const errorSpy = vi.spyOn(log, "error").mockImplementation((): void => undefined);

        const unconfiguredResult: boolean = await plugin.testConnection();
        expect(unconfiguredResult).toBe(false);
        expect(notifySpy).toHaveBeenLastCalledWith(
            "Configure server URL, username, and app password first."
        );

        plugin.settings = createConfiguredSettings({ remoteBaseDir: "   " });
        const missingSecretResult: boolean = await plugin.testConnection();
        expect(missingSecretResult).toBe(false);
        expect(notifySpy).toHaveBeenLastCalledWith(
            "App password secret was not found in secret storage."
        );

        const versionSpy = vi
            .spyOn(obsidian, "requireApiVersion")
            .mockReturnValueOnce(false);
        const unsupportedResult: boolean = await plugin.testConnection();
        expect(unsupportedResult).toBe(false);
        expect(notifySpy).toHaveBeenLastCalledWith(
            "Obsidian 1.11.4 or newer is required for secure password storage."
        );
        versionSpy.mockRestore();

        secretStorage.setSecret(DEFAULT_APP_PASSWORD_SECRET_ID, "app-password-123");
        let capturedBaseUrl: string = "";
        const checkSpy = vi
            .spyOn(WebDavClient.prototype, "checkConnection")
            .mockImplementationOnce(async function (this: WebDavClient): Promise<boolean> {
                capturedBaseUrl = this.buildResourceUrl("", false);
                return true;
            });

        const okResult: boolean = await plugin.testConnection();
        expect(okResult).toBe(true);
        expect(capturedBaseUrl).toBe(
            "https://cloud.example.com/remote.php/dav/files/alice/FallbackVault"
        );
        expect(notifySpy).toHaveBeenLastCalledWith(
            "Connection to Nextcloud WebDAV succeeded."
        );

        plugin.settings = createConfiguredSettings({
            remoteBaseDir: "  /CustomDir//Sub/  "
        });
        checkSpy.mockImplementationOnce(
            async function (this: WebDavClient): Promise<boolean> {
                capturedBaseUrl = this.buildResourceUrl("", false);
                return false;
            }
        );

        const falseResult: boolean = await plugin.testConnection();
        expect(falseResult).toBe(false);
        expect(capturedBaseUrl).toBe(
            "https://cloud.example.com/remote.php/dav/files/alice/CustomDir/Sub"
        );
        expect(notifySpy).toHaveBeenLastCalledWith(
            "Connection failed: remote folder could not be verified."
        );

        checkSpy.mockRejectedValueOnce(new Error("HTTP 401 Unauthorized"));
        const errorResult: boolean = await plugin.testConnection();
        expect(errorResult).toBe(false);
        expect(errorSpy).toHaveBeenCalledWith(
            "Connection test failed:",
            expect.any(Error)
        );
        expect(notifySpy).toHaveBeenLastCalledWith(
            "Connection failed: HTTP 401 Unauthorized"
        );

        checkSpy.mockRejectedValueOnce("raw string failure");
        const stringErrorResult: boolean = await plugin.testConnection();
        expect(stringErrorResult).toBe(false);
        expect(notifySpy).toHaveBeenLastCalledWith(
            "Connection failed: raw string failure"
        );

        const {
            plugin: emptyNamePlugin,
            secretStorage: emptyNameSecretStorage
        } = createTestPlugin("..");
        emptyNameSecretStorage.setSecret(
            DEFAULT_APP_PASSWORD_SECRET_ID,
            "app-password-123"
        );
        emptyNamePlugin.settings = createConfiguredSettings({ remoteBaseDir: ".." });
        checkSpy.mockImplementationOnce(
            async function (this: WebDavClient): Promise<boolean> {
                capturedBaseUrl = this.buildResourceUrl("", false);
                return true;
            }
        );
        const fallbackVaultDavResult: boolean = await emptyNamePlugin.testConnection();
        expect(fallbackVaultDavResult).toBe(true);
        expect(capturedBaseUrl).toBe(
            "https://cloud.example.com/remote.php/dav/files/alice/VaultDAV"
        );
    });

    it("guards concurrent runs, checks configuration, updates and clears status bar, reports SyncResult summaries, and resets isSyncing in triggerSync()", async () => {
        const { plugin, secretStorage } = createTestPlugin("MyVault");
        const statusBarEl: HTMLElement = document.createElement("div");
        statusBarEl.setText = (val: string): void => {
            statusBarEl.textContent = val;
        };
        vi.spyOn(plugin, "addStatusBarItem").mockReturnValue(statusBarEl);
        await plugin.onload();
        const notifySpy = vi.spyOn(log, "notify").mockImplementation((): void => undefined);
        const errorSpy = vi.spyOn(log, "error").mockImplementation((): void => undefined);
        const progressSpy = vi.spyOn(plugin, "reportProgress");

        plugin.isSyncing = true;
        const concurrentResult: SyncResult | null = await plugin.triggerSync();
        expect(concurrentResult).toBeNull();
        expect(notifySpy).toHaveBeenLastCalledWith(
            "Synchronization is already in progress."
        );
        plugin.isSyncing = false;

        plugin.settings = { ...DEFAULT_SETTINGS };
        const unconfiguredResult: SyncResult | null = await plugin.triggerSync();
        expect(unconfiguredResult).toBeNull();
        expect(notifySpy).toHaveBeenLastCalledWith(
            "Configure Nextcloud WebDAV settings before syncing."
        );

        plugin.settings = createConfiguredSettings({ remoteBaseDir: "" });
        const missingSecretSyncResult: SyncResult | null = await plugin.triggerSync();
        expect(missingSecretSyncResult).toBeNull();
        expect(notifySpy).toHaveBeenLastCalledWith(
            "App password secret was not found in secret storage."
        );

        secretStorage.setSecret(DEFAULT_APP_PASSWORD_SECRET_ID, "app-password-123");
        const cleanSyncResult: SyncResult = {
            conflictsResolved: 1,
            deletedLocal: 2,
            deletedRemote: 3,
            downloaded: 4,
            errors: [],
            events: [
                {
                    conflictCopyPath: "Doc.conflict-20261124-120000.md",
                    isDirectory: false,
                    kind: "conflict",
                    path: "Doc.md",
                    resolution: "keep_both",
                    size: 128
                }
            ],
            summary: {
                ...createEmptyRunSummary(),
                conflictsKeepBoth: 1,
                conflictsResolved: 1,
                deletedLocal: 2,
                deletedRemote: 3,
                downloaded: 4,
                uploaded: 5
            },
            timestamp: 1700000000000,
            uploaded: 5
        };
        const runSyncSpy = vi
            .spyOn(SyncEngine.prototype, "runSync")
            .mockImplementationOnce(async (): Promise<SyncResult> => {
                expect(plugin.isSyncing).toBe(true);
                plugin.reportProgress("Uploading notes.md (3/12 · file 5/18)");
                return cleanSyncResult;
            });

        const firstResult: SyncResult | null = await plugin.triggerSync();
        expect(firstResult).toEqual(cleanSyncResult);
        expect(plugin.isSyncing).toBe(false);
        expect(progressSpy).toHaveBeenCalledWith(
            "Uploading notes.md (3/12 · file 5/18)"
        );
        expect(progressSpy).toHaveBeenLastCalledWith("");
        expect(statusBarEl.textContent).toBe("");
        expect(statusBarEl.classList.contains("vaultdav-status-error")).toBe(false);
        expect(plugin.getSyncHistoryRuns().length).toBe(1);
        expect(plugin.getSyncHistoryRuns()[0]?.status).toBe("success");
        expect(notifySpy).toHaveBeenCalledWith("Starting synchronization...");
        expect(notifySpy).toHaveBeenLastCalledWith(
            "Sync complete (up: 5, down: 4, conflicts: 1, del: 5)."
        );

        const partialErrorResult: SyncResult = {
            conflictsResolved: 0,
            deletedLocal: 0,
            deletedRemote: 0,
            downloaded: 1,
            errors: ["Failed to upload note.md"],
            events: [
                {
                    isDirectory: false,
                    kind: "error",
                    message: "Failed to upload note.md",
                    path: "note.md"
                }
            ],
            summary: {
                ...createEmptyRunSummary(),
                downloaded: 1,
                errors: 1,
                uploaded: 2
            },
            timestamp: 1700000001000,
            uploaded: 2
        };
        runSyncSpy.mockResolvedValueOnce(partialErrorResult);

        const secondResult: SyncResult | null = await plugin.triggerSync();
        expect(secondResult).toEqual(partialErrorResult);
        expect(plugin.isSyncing).toBe(false);
        expect(statusBarEl.textContent).toBe("VaultDAV: 1 sync error");
        expect(statusBarEl.classList.contains("vaultdav-status-error")).toBe(true);
        expect(plugin.getSyncHistoryRuns()[0]?.status).toBe("partial");
        expect(notifySpy).toHaveBeenLastCalledWith(
            "Sync completed with 1 error(s). Uploaded 2, downloaded 1."
        );

        runSyncSpy.mockImplementationOnce(async (): Promise<SyncResult> => {
            plugin.reportProgress("Uploading huge.bin (1/4 · file 1/1)");
            throw new Error("Network timeout");
        });
        const thrownResult: SyncResult | null = await plugin.triggerSync();
        expect(thrownResult).toBeNull();
        expect(plugin.isSyncing).toBe(false);
        expect(statusBarEl.textContent).toBe("VaultDAV: sync failed");
        expect(statusBarEl.classList.contains("vaultdav-status-error")).toBe(true);
        expect(plugin.getSyncHistoryRuns()[0]?.status).toBe("failed");
        expect(errorSpy).toHaveBeenCalledWith(
            "Synchronization failed:",
            expect.any(Error)
        );
        expect(notifySpy).toHaveBeenLastCalledWith("Sync failed: Network timeout");

        runSyncSpy.mockRejectedValueOnce("unexpected string error");
        const stringThrownResult: SyncResult | null = await plugin.triggerSync();
        expect(stringThrownResult).toBeNull();
        expect(plugin.isSyncing).toBe(false);
        expect(notifySpy).toHaveBeenLastCalledWith(
            "Sync failed: unexpected string error"
        );
        expect(statusBarEl.textContent).toBe("VaultDAV: sync failed");

        // Subsequent clean sync clears the error indicator from status bar
        runSyncSpy.mockResolvedValueOnce(cleanSyncResult);
        await plugin.triggerSync();
        expect(statusBarEl.textContent).toBe("");
        expect(statusBarEl.classList.contains("vaultdav-status-error")).toBe(false);
    });

    it("clamps and sanitizes loaded settings, scrubs embedded URL credentials and invalid legacy passwords from data.json, guards 32-bit auto-sync timer overflow, handles undefined statusBarItem on mobile, and serializes saveSettings()", async () => {
        vi.useFakeTimers();
        const { plugin } = createTestPlugin();
        const scrubSaveSpy = vi.spyOn(plugin, "saveData").mockResolvedValue(undefined);

        vi.spyOn(plugin, "loadData").mockResolvedValueOnce({
            appPassword: "bad\r\npassword",
            chunkSizeMB: 1e305,
            chunkingThresholdMB: 5000,
            conflictStrategy: "keep_both",
            remoteBaseDir: ".obsidian/plugins/vaultdav",
            syncInterval: 99999999,
            url: "https://alice@domain.com:secret@cloud.example.com/remote.php/dav",
            username: "alice:injected"
        });
        await plugin.loadSettings();

        expect(plugin.settings.appPasswordSecret).toBe("");
        expect(plugin.settings.chunkSizeMB).toBe(512);
        expect(plugin.settings.chunkingThresholdMB).toBe(512);
        expect(plugin.settings.remoteBaseDir).toBe("");
        expect(plugin.settings.syncInterval).toBe(10080);
        expect(plugin.settings.url).toBe("https://cloud.example.com/remote.php/dav");
        expect(plugin.settings.username).toBe("");
        expect(scrubSaveSpy).toHaveBeenCalledTimes(1);
        const scrubbedPayload: Record<string, unknown> =
            scrubSaveSpy.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(Object.prototype.hasOwnProperty.call(scrubbedPayload, "appPassword")).toBe(
            false
        );
        expect(scrubbedPayload.url).toBe("https://cloud.example.com/remote.php/dav");
        scrubSaveSpy.mockRestore();

        // Embedded URL credentials without legacy appPassword field must also be scrubbed from data.json
        const urlScrubSpy = vi.spyOn(plugin, "saveData").mockResolvedValue(undefined);
        vi.spyOn(plugin, "loadData").mockResolvedValueOnce({
            appPasswordSecret: DEFAULT_APP_PASSWORD_SECRET_ID,
            url: "https://alice:topsecret@cloud.example.com",
            username: "alice"
        });
        await plugin.loadSettings();
        expect(plugin.settings.url).toBe("https://cloud.example.com");
        expect(urlScrubSpy).toHaveBeenCalledTimes(1);
        expect(
            (urlScrubSpy.mock.calls[0]?.[0] as Record<string, unknown>).url
        ).toBe("https://cloud.example.com");
        urlScrubSpy.mockRestore();

        // Direct mutation of syncInterval above 32-bit timer max must still clamp in configureAutoSync()
        const setIntervalSpy = vi.spyOn(window, "setInterval");
        plugin.settings.syncInterval = 99999999;
        plugin.configureAutoSync();
        expect(setIntervalSpy).toHaveBeenLastCalledWith(
            expect.any(Function),
            10080 * 60 * 1000
        );
        plugin.onunload();

        // Mobile addStatusBarItem returning undefined must not throw in reportProgress()
        vi.spyOn(plugin, "addStatusBarItem").mockReturnValueOnce(
            undefined as unknown as HTMLElement
        );
        vi.spyOn(plugin, "loadData").mockResolvedValueOnce({});
        await plugin.onload();
        expect(() => plugin.reportProgress("Uploading note.md (file 1/1)")).not.toThrow();
        plugin.onunload();

        // Concurrent saveSettings() calls must serialize sequentially without overlapping writes
        let activeSaves: number = 0;
        let maxActiveSaves: number = 0;
        const savedUrls: string[] = [];
        vi.spyOn(plugin, "saveData").mockImplementation(
            async (data: unknown): Promise<void> => {
                activeSaves += 1;
                if (activeSaves > maxActiveSaves) {
                    maxActiveSaves = activeSaves;
                }
                const record: VaultDavSettings = data as VaultDavSettings;
                await Promise.resolve();
                savedUrls.push(record.url);
                activeSaves -= 1;
            }
        );

        plugin.settings.url = "https://first.example.com";
        const p1: Promise<void> = plugin.saveSettings();
        plugin.settings.url = "https://second.example.com";
        const p2: Promise<void> = plugin.saveSettings();
        await Promise.all([p1, p2]);

        expect(maxActiveSaves).toBe(1);
        expect(savedUrls).toEqual([
            "https://first.example.com",
            "https://second.example.com"
        ]);
    });

    it("does not schedule a leaked auto-sync timer when onunload() runs during an in-flight saveSettings() or onload()", async () => {
        vi.useFakeTimers();
        const { plugin } = createTestPlugin();
        const setIntervalSpy = vi.spyOn(window, "setInterval");

        // 1. Unload while saveSettings() is awaiting saveData()
        let resolveSave!: () => void;
        vi.spyOn(plugin, "saveData").mockImplementationOnce(
            (): Promise<void> =>
                new Promise<void>((resolve) => {
                    resolveSave = resolve;
                })
        );
        plugin.settings.syncInterval = 5;
        const savePromise: Promise<void> = plugin.saveSettings();
        await Promise.resolve();
        plugin.onunload();
        resolveSave();
        await savePromise;

        expect(setIntervalSpy).not.toHaveBeenCalled();

        // 2. Unload while onload() is awaiting loadSettings()
        let resolveLoad!: (value: unknown) => void;
        vi.spyOn(plugin, "loadData").mockImplementationOnce(
            (): Promise<unknown> =>
                new Promise<unknown>((resolve) => {
                    resolveLoad = resolve;
                })
        );
        const loadPromise: Promise<void> = plugin.onload();
        plugin.onunload();
        resolveLoad({ syncInterval: 10 });
        await loadPromise;

        expect(setIntervalSpy).not.toHaveBeenCalled();
    });

    it("opens and reveals SyncLogView and isolates history storage write failures from triggerSync()", async () => {
        const { app, plugin, secretStorage } = createTestPlugin("MyVault");
        const revealLeafSpy = vi.fn().mockResolvedValue(undefined);
        const createdLeaf: MockWorkspaceLeaf = new MockWorkspaceLeaf(app);
        const existingLeaves: MockWorkspaceLeaf[] = [];
        const getRightLeafSpy = vi.fn(() => {
            existingLeaves.push(createdLeaf);
            return createdLeaf;
        });
        Object.assign(app, {
            workspace: {
                getLeavesOfType: (): MockWorkspaceLeaf[] => existingLeaves,
                getRightLeaf: getRightLeafSpy,
                revealLeaf: revealLeafSpy
            }
        });

        await plugin.openSyncLogView();
        expect(getRightLeafSpy).toHaveBeenCalledWith(false);
        expect(createdLeaf.viewState).toEqual({
            active: true,
            type: SYNC_LOG_VIEW_TYPE
        });
        expect(revealLeafSpy).toHaveBeenCalledWith(createdLeaf);

        // Second call reuses existing leaf instead of creating another
        await plugin.openSyncLogView();
        expect(getRightLeafSpy).toHaveBeenCalledTimes(1);
        expect(revealLeafSpy).toHaveBeenCalledTimes(2);

        // Refreshing calls refresh() on mounted SyncLogView instances
        const mountedView: SyncLogView = new SyncLogView(
            createdLeaf as unknown as import("obsidian").WorkspaceLeaf,
            plugin
        );
        const refreshSpy = vi.spyOn(mountedView, "refresh").mockImplementation(
            (): void => undefined
        );
        createdLeaf.view = mountedView;
        plugin.refreshSyncLogViews();
        expect(refreshSpy).toHaveBeenCalledTimes(1);

        // History persistence error must not abort or fail triggerSync()
        const warnSpy = vi.spyOn(log, "warn").mockImplementation((): void => undefined);
        vi.spyOn(log, "notify").mockImplementation((): void => undefined);
        secretStorage.setSecret(DEFAULT_APP_PASSWORD_SECRET_ID, "app-password-123");
        plugin.settings = createConfiguredSettings();
        vi.spyOn(SyncHistoryStore.prototype, "recordRun").mockRejectedValueOnce(
            new Error("Disk full")
        );
        const okResult: SyncResult = {
            conflictsResolved: 0,
            deletedLocal: 0,
            deletedRemote: 0,
            downloaded: 0,
            errors: [],
            events: [],
            summary: createEmptyRunSummary(),
            timestamp: 1700000002000,
            uploaded: 0
        };
        vi.spyOn(SyncEngine.prototype, "runSync").mockResolvedValueOnce(okResult);

        const syncOut: SyncResult | null = await plugin.triggerSync();
        expect(syncOut).toEqual(okResult);
        expect(warnSpy).toHaveBeenCalledWith(
            "Failed to save sync history entry:",
            expect.any(Error)
        );
    });
});
