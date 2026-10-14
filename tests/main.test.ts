import type { App, Command, PluginManifest } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { log } from "../src/log";
import VaultDavPlugin from "../src/main";
import { DEFAULT_SETTINGS, VaultDavSettingTab } from "../src/settings";
import { SyncEngine } from "../src/sync/engine";
import type { SyncResult, VaultDavSettings } from "../src/types";
import { WebDavClient } from "../src/webdav/client";

function createConfiguredSettings(
    overrides: Partial<VaultDavSettings> = {}
): VaultDavSettings {
    return {
        ...DEFAULT_SETTINGS,
        appPassword: "app-password-123",
        remoteBaseDir: "ObsidianVault",
        url: "https://cloud.example.com",
        username: "alice",
        ...overrides
    };
}

function createTestPlugin(vaultName: string = "MyVault"): {
    app: App;
    plugin: VaultDavPlugin;
} {
    const mockApp: App = {
        vault: {
            adapter: {
                exists: async (): Promise<boolean> => false,
                mkdir: async (): Promise<void> => undefined,
                read: async (): Promise<string> => "{}",
                write: async (): Promise<void> => undefined
            },
            getName: (): string => vaultName
        }
    } as unknown as App;

    const mockManifest: PluginManifest = {
        author: "Test",
        description: "Test",
        id: "vaultdav",
        isDesktopOnly: false,
        minAppVersion: "1.5.0",
        name: "VaultDAV",
        version: "0.1.0"
    };

    const plugin: VaultDavPlugin = new VaultDavPlugin(mockApp, mockManifest);
    return { app: mockApp, plugin };
}

describe("VaultDavPlugin lifecycle, settings, and actions", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("falls back safely in loadSettings() when loadData() returns null, primitives, or malformed fields", async () => {
        const { plugin } = createTestPlugin();

        vi.spyOn(plugin, "loadData").mockResolvedValueOnce(null);
        await plugin.loadSettings();
        expect(plugin.settings).toEqual(DEFAULT_SETTINGS);

        vi.spyOn(plugin, "loadData").mockResolvedValueOnce("primitive-string");
        await plugin.loadSettings();
        expect(plugin.settings).toEqual(DEFAULT_SETTINGS);

        vi.spyOn(plugin, "loadData").mockResolvedValueOnce(42);
        await plugin.loadSettings();
        expect(plugin.settings).toEqual(DEFAULT_SETTINGS);

        vi.spyOn(plugin, "loadData").mockResolvedValueOnce({
            appPassword: 999,
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

        vi.spyOn(plugin, "loadData").mockResolvedValueOnce({
            appPassword: "  secret  ",
            conflictStrategy: "newest_wins",
            remoteBaseDir: 123,
            syncInterval: "invalid",
            url: "  https://nc.example.com  ",
            username: "  bob  "
        });
        await plugin.loadSettings();
        expect(plugin.settings).toEqual({
            appPassword: "secret",
            conflictStrategy: "newest_wins",
            remoteBaseDir: "",
            syncInterval: 0,
            url: "https://nc.example.com",
            username: "bob"
        });

        vi.spyOn(plugin, "loadData").mockResolvedValueOnce({
            conflictStrategy: "keep_both",
            syncInterval: 12.9
        });
        await plugin.loadSettings();
        expect(plugin.settings.conflictStrategy).toBe("keep_both");
        expect(plugin.settings.syncInterval).toBe(12);
    });

    it("checks credentials in isConfigured()", () => {
        const { plugin } = createTestPlugin();
        expect(plugin.isConfigured()).toBe(false);

        plugin.settings = createConfiguredSettings({ url: "   " });
        expect(plugin.isConfigured()).toBe(false);

        plugin.settings = createConfiguredSettings({ username: "   " });
        expect(plugin.isConfigured()).toBe(false);

        plugin.settings = createConfiguredSettings({ appPassword: "   " });
        expect(plugin.isConfigured()).toBe(false);

        plugin.settings = createConfiguredSettings();
        expect(plugin.isConfigured()).toBe(true);
    });

    it("registers ribbon icon, commands, setting tab, and auto-sync in onload(), and cleans up in onunload()", async () => {
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

        await plugin.onload();

        expect(ribbonSpy).toHaveBeenCalledWith(
            "refresh-cw",
            "Synchronize with Nextcloud",
            expect.any(Function)
        );
        expect(commandSpy).toHaveBeenCalledTimes(2);
        expect(registeredCommands.map((cmd: Command) => cmd.id)).toEqual([
            "sync-now",
            "test-connection"
        ]);
        expect(registeredCommands.map((cmd: Command) => cmd.name)).toEqual([
            "Synchronize now",
            "Test Nextcloud WebDAV connection"
        ]);
        expect(settingTabSpy).toHaveBeenCalledTimes(1);
        expect(settingTabSpy.mock.calls[0]?.[0]).toBeInstanceOf(VaultDavSettingTab);
        expect(registerIntervalSpy).toHaveBeenCalledTimes(1);

        const ribbonCallback: ((evt: MouseEvent) => unknown) | undefined =
            ribbonSpy.mock.calls[0]?.[2];
        ribbonCallback?.(new MouseEvent("click"));
        expect(triggerSyncSpy).toHaveBeenCalledTimes(1);

        registeredCommands[0]?.callback?.();
        expect(triggerSyncSpy).toHaveBeenCalledTimes(2);

        registeredCommands[1]?.callback?.();
        expect(testConnectionSpy).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(10 * 60 * 1000);
        expect(triggerSyncSpy).toHaveBeenCalledTimes(3);

        plugin.onunload();
        expect(clearIntervalSpy).toHaveBeenCalledTimes(1);

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

    it("handles unconfigured state, fallback remoteBaseDir, success, failure, and thrown errors in testConnection()", async () => {
        const { plugin } = createTestPlugin("  /FallbackVault/  ");
        const notifySpy = vi.spyOn(log, "notify").mockImplementation((): void => undefined);
        const errorSpy = vi.spyOn(log, "error").mockImplementation((): void => undefined);

        const unconfiguredResult: boolean = await plugin.testConnection();
        expect(unconfiguredResult).toBe(false);
        expect(notifySpy).toHaveBeenLastCalledWith(
            "Configure server URL, username, and app password first."
        );

        plugin.settings = createConfiguredSettings({ remoteBaseDir: "   " });
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
    });

    it("guards concurrent runs, checks configuration, reports SyncResult summaries, and resets isSyncing in triggerSync()", async () => {
        const { plugin } = createTestPlugin("MyVault");
        const notifySpy = vi.spyOn(log, "notify").mockImplementation((): void => undefined);
        const errorSpy = vi.spyOn(log, "error").mockImplementation((): void => undefined);

        plugin.isSyncing = true;
        const concurrentResult: SyncResult | null = await plugin.triggerSync();
        expect(concurrentResult).toBeNull();
        expect(notifySpy).toHaveBeenLastCalledWith(
            "Synchronization is already in progress."
        );
        plugin.isSyncing = false;

        const unconfiguredResult: SyncResult | null = await plugin.triggerSync();
        expect(unconfiguredResult).toBeNull();
        expect(notifySpy).toHaveBeenLastCalledWith(
            "Configure Nextcloud WebDAV settings before syncing."
        );

        plugin.settings = createConfiguredSettings({ remoteBaseDir: "" });
        const cleanSyncResult: SyncResult = {
            conflictsResolved: 1,
            deletedLocal: 2,
            deletedRemote: 3,
            downloaded: 4,
            errors: [],
            timestamp: 1700000000000,
            uploaded: 5
        };
        const runSyncSpy = vi
            .spyOn(SyncEngine.prototype, "runSync")
            .mockImplementationOnce(async (): Promise<SyncResult> => {
                expect(plugin.isSyncing).toBe(true);
                return cleanSyncResult;
            });

        const firstResult: SyncResult | null = await plugin.triggerSync();
        expect(firstResult).toEqual(cleanSyncResult);
        expect(plugin.isSyncing).toBe(false);
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
            timestamp: 1700000001000,
            uploaded: 2
        };
        runSyncSpy.mockResolvedValueOnce(partialErrorResult);

        const secondResult: SyncResult | null = await plugin.triggerSync();
        expect(secondResult).toEqual(partialErrorResult);
        expect(plugin.isSyncing).toBe(false);
        expect(notifySpy).toHaveBeenLastCalledWith(
            "Sync completed with 1 error(s). Uploaded 2, downloaded 1."
        );

        runSyncSpy.mockRejectedValueOnce(new Error("Network timeout"));
        const thrownResult: SyncResult | null = await plugin.triggerSync();
        expect(thrownResult).toBeNull();
        expect(plugin.isSyncing).toBe(false);
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
    });
});
