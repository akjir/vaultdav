import * as obsidian from "obsidian";
import type {
    App,
    PluginManifest,
    SettingDefinitionControl,
    SettingDefinitionGroup,
    SettingDefinitionItem,
    SettingDefinitionRender,
    SettingGroup as ObsidianSettingGroup
} from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";
import VaultDavPlugin from "../src/main";
import {
    createSettingGroup,
    DEFAULT_SETTINGS,
    hasEmbeddedUrlCredentials,
    MAX_CHUNK_SIZE_MB,
    MAX_CHUNKING_THRESHOLD_MB,
    MAX_SECRET_ID_LENGTH,
    MAX_SYNC_INTERVAL_MINUTES,
    MAX_SYNC_LOG_RETENTION_DAYS,
    MIN_SYNC_LOG_RETENTION_DAYS,
    sanitizeSecretId,
    VaultDavSettingTab
} from "../src/settings";
import {
    SecretComponent as MockSecretComponent,
    SecretStorage as MockSecretStorage,
    Setting as MockSetting,
    SettingGroup as MockSettingGroup
} from "./obsidian_mock";

function createTestPlugin(
    configDir: string = ".obsidian"
): { app: App; plugin: VaultDavPlugin; secretStorage: MockSecretStorage } {
    const secretStorage: MockSecretStorage = new MockSecretStorage();
    const mockApp: App = {
        secretStorage,
        vault: {
            adapter: {
                exists: async (): Promise<boolean> => false,
                mkdir: async (): Promise<void> => undefined,
                read: async (): Promise<string> => "{}",
                write: async (): Promise<void> => undefined
            },
            configDir,
            getName: (): string => "MyVault"
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

function getSettingByName(name: string): MockSetting {
    const found: MockSetting | undefined = MockSetting.instances.find(
        (item: MockSetting): boolean => item.name === name
    );
    if (found === undefined) {
        throw new Error(`Expected setting "${name}" to be rendered`);
    }
    return found;
}

describe("VaultDavSettingTab and DEFAULT_SETTINGS", () => {
    beforeEach(() => {
        MockSecretComponent.instances.length = 0;
        MockSetting.instances.length = 0;
        MockSettingGroup.instances.length = 0;
    });

    it("defines expected DEFAULT_SETTINGS keys without plaintext passwords and freezes the object against mutation", () => {
        expect(Object.keys(DEFAULT_SETTINGS).sort()).toEqual([
            "appPasswordSecret",
            "chunkSizeMB",
            "chunkingThresholdMB",
            "conflictStrategy",
            "remoteBaseDir",
            "syncInterval",
            "syncLogRetentionDays",
            "url",
            "username"
        ]);
        expect(DEFAULT_SETTINGS).toEqual({
            appPasswordSecret: "",
            chunkSizeMB: 10,
            chunkingThresholdMB: 90,
            conflictStrategy: "keep_both",
            remoteBaseDir: "",
            syncInterval: 0,
            syncLogRetentionDays: 30,
            url: "",
            username: ""
        });
        expect("appPassword" in DEFAULT_SETTINGS).toBe(false);
        expect(Object.isFrozen(DEFAULT_SETTINGS)).toBe(true);
        expect(() => {
            (DEFAULT_SETTINGS as { chunkSizeMB: number }).chunkSizeMB = 9999;
        }).toThrow();
    });

    it("clears containerEl via empty() without touching innerHTML, and falls back to replaceChildren()", () => {
        const { app, plugin } = createTestPlugin();
        const tab: VaultDavSettingTab = new VaultDavSettingTab(app, plugin);

        const emptySpy = vi.spyOn(tab.containerEl, "empty");
        let innerHtmlTouched: boolean = false;
        Object.defineProperty(tab.containerEl, "innerHTML", {
            configurable: true,
            get(): string {
                return "";
            },
            set(): void {
                innerHtmlTouched = true;
                throw new Error("innerHTML must not be used");
            }
        });

        tab.display();
        expect(emptySpy).toHaveBeenCalledTimes(1);
        expect(innerHtmlTouched).toBe(false);
        expect(tab.containerEl.children.length).toBe(4);

        const replaceChildrenSpy = vi.spyOn(tab.containerEl, "replaceChildren");
        (tab.containerEl as Partial<HTMLElement>).empty = undefined;
        tab.display();
        expect(replaceChildrenSpy).toHaveBeenCalledTimes(1);
        expect(tab.containerEl.children.length).toBe(4);
    });

    it("renders grouped settings with strict Obsidian Sentence case names and descriptions", () => {
        const { app, plugin } = createTestPlugin();
        const tab: VaultDavSettingTab = new VaultDavSettingTab(app, plugin);

        tab.display();

        expect(MockSettingGroup.instances.length).toBe(4);
        expect(
            MockSettingGroup.instances.map((group: MockSettingGroup) => ({
                heading: group.heading,
                names: group.settings.map((item: MockSetting): string => item.name)
            }))
        ).toEqual([
            {
                heading: "",
                names: [
                    "Server URL",
                    "Username",
                    "App password",
                    "Remote base directory"
                ]
            },
            {
                heading: "",
                names: ["Sync interval", "Conflict strategy"]
            },
            {
                heading: "",
                names: ["Test connection"]
            },
            {
                heading: "Advanced sync",
                names: ["Chunking threshold", "Chunk size", "Sync log retention"]
            }
        ]);

        const names: string[] = MockSetting.instances.map(
            (item: MockSetting): string => item.name
        );
        expect(names).toEqual([
            "Server URL",
            "Username",
            "App password",
            "Remote base directory",
            "Sync interval",
            "Conflict strategy",
            "Test connection",
            "Chunking threshold",
            "Chunk size",
            "Sync log retention"
        ]);

        expect(getSettingByName("Server URL").desc).toBe(
            "Nextcloud base URL or WebDAV endpoint (https://<domain>)."
        );
        expect(getSettingByName("Username").desc).toBe("Nextcloud account username.");
        expect(getSettingByName("Username").textComponent?.inputEl.placeholder).toBe(
            "Enter username"
        );
        expect(getSettingByName("App password").desc).toBe(
            "Select or create a secret for your Nextcloud app password."
        );
        expect(getSettingByName("App password").secretComponent).not.toBeNull();
        expect(getSettingByName("App password").textComponent).toBeNull();
        expect(getSettingByName("Remote base directory").desc).toBe(
            "Target remote folder path inside the Nextcloud user files root."
        );
        expect(getSettingByName("Sync interval").desc).toBe(
            "Automatic synchronization interval in minutes (0 to disable)."
        );
        expect(getSettingByName("Conflict strategy").desc).toBe(
            "Resolution mode for concurrent edits (keep_both or newest_wins)."
        );
        expect(getSettingByName("Test connection").desc).toBe(
            "Verify Nextcloud WebDAV credentials and remote directory access."
        );
        expect(
            getSettingByName("Test connection").buttonComponent?.buttonEl.textContent
        ).toBe("Test connection");
        expect(getSettingByName("Chunking threshold").desc).toBe(
            "Minimum file size in MB before switching to Nextcloud chunked uploads."
        );
        expect(getSettingByName("Chunk size").desc).toBe(
            "Target chunk size in MB for chunked uploads and parallel range downloads."
        );
        expect(getSettingByName("Sync log retention").desc).toBe(
            "Days to retain local sync history (1 to 365)."
        );
    });

    it("falls back to flat Setting items when SettingGroup is unavailable or requireApiVersion('1.11.0') is false", () => {
        const containerEl: HTMLElement = document.createElement("div");
        createSettingGroup(containerEl, null)
            .setHeading("Advanced sync")
            .addSetting((setting) => {
                setting.setName("Chunking threshold");
            })
            .addSetting((setting) => {
                setting.setName("Chunk size");
            });

        expect(MockSetting.instances.length).toBe(3);
        expect(MockSetting.instances[0]?.name).toBe("Advanced sync");
        expect(MockSetting.instances[0]?.isHeading).toBe(true);
        expect(MockSetting.instances[1]?.name).toBe("Chunking threshold");
        expect(MockSetting.instances[2]?.name).toBe("Chunk size");

        MockSetting.instances.length = 0;
        MockSettingGroup.instances.length = 0;
        const versionSpy = vi
            .spyOn(obsidian, "requireApiVersion")
            .mockReturnValueOnce(false);
        const oldContainerEl: HTMLElement = document.createElement("div");
        createSettingGroup(oldContainerEl)
            .setHeading("Advanced sync")
            .addSetting((setting) => {
                setting.setName("Chunk size");
            });
        expect(versionSpy).toHaveBeenCalledWith("1.11.0");
        expect(MockSettingGroup.instances.length).toBe(0);
        expect(MockSetting.instances.length).toBe(2);
        expect(MockSetting.instances[0]?.isHeading).toBe(true);
        versionSpy.mockRestore();
    });

    it("configures mobile input hygiene, SecretComponent binding, and input types/bounds on controls", () => {
        const { app, plugin } = createTestPlugin();
        plugin.settings.appPasswordSecret = "vaultdav-app-password";
        const tab: VaultDavSettingTab = new VaultDavSettingTab(app, plugin);

        tab.display();

        for (const label of ["Server URL", "Username", "Remote base directory"]) {
            const setting: MockSetting = getSettingByName(label);
            const inputEl: HTMLInputElement | undefined = setting.textComponent?.inputEl;
            expect(inputEl).toBeDefined();
            expect(inputEl?.autocapitalize).toBe("none");
            expect(inputEl?.spellcheck).toBe(false);
        }

        const appPasswordSetting: MockSetting = getSettingByName("App password");
        expect(appPasswordSetting.textComponent).toBeNull();
        expect(appPasswordSetting.secretComponent).not.toBeNull();
        expect(appPasswordSetting.secretComponent?.value).toBe("vaultdav-app-password");

        const intervalInput: HTMLInputElement | undefined =
            getSettingByName("Sync interval").textComponent?.inputEl;
        expect(intervalInput?.type).toBe("number");
        expect(intervalInput?.min).toBe("0");
        expect(intervalInput?.max).toBe(String(MAX_SYNC_INTERVAL_MINUTES));

        const thresholdInput: HTMLInputElement | undefined =
            getSettingByName("Chunking threshold").textComponent?.inputEl;
        expect(thresholdInput?.type).toBe("number");
        expect(thresholdInput?.min).toBe("1");
        expect(thresholdInput?.max).toBe(String(MAX_CHUNKING_THRESHOLD_MB));

        const chunkSizeInput: HTMLInputElement | undefined =
            getSettingByName("Chunk size").textComponent?.inputEl;
        expect(chunkSizeInput?.type).toBe("number");
        expect(chunkSizeInput?.min).toBe("1");
        expect(chunkSizeInput?.max).toBe(String(MAX_CHUNK_SIZE_MB));

        const retentionInput: HTMLInputElement | undefined =
            getSettingByName("Sync log retention").textComponent?.inputEl;
        expect(retentionInput?.type).toBe("number");
        expect(retentionInput?.min).toBe(String(MIN_SYNC_LOG_RETENTION_DAYS));
        expect(retentionInput?.max).toBe(String(MAX_SYNC_LOG_RETENTION_DAYS));
    });

    it("fails closed without plaintext password input when Obsidian 1.11.4 SecretComponent API is unavailable", () => {
        const { app, plugin } = createTestPlugin();
        const versionSpy = vi
            .spyOn(obsidian, "requireApiVersion")
            .mockImplementation((version: string): boolean => version !== "1.11.4");
        const tab: VaultDavSettingTab = new VaultDavSettingTab(app, plugin);

        tab.display();

        const appPasswordSetting: MockSetting = getSettingByName("App password");
        expect(appPasswordSetting.secretComponent).toBeNull();
        expect(appPasswordSetting.textComponent).toBeNull();
        expect(appPasswordSetting.desc).toBe(
            "Obsidian 1.11.4 or newer is required for secure password storage."
        );
        versionSpy.mockRestore();
    });

    it("normalizes and persists setting changes across all controls", async () => {
        const { app, plugin } = createTestPlugin();
        const saveSpy = vi.spyOn(plugin, "saveSettings").mockResolvedValue(undefined);
        const tab: VaultDavSettingTab = new VaultDavSettingTab(app, plugin);

        tab.display();

        await getSettingByName("Server URL").textOnChange?.("  https://nc.example.com/  ");
        expect(plugin.settings.url).toBe("https://nc.example.com/");

        await getSettingByName("Username").textOnChange?.("  alice  ");
        expect(plugin.settings.username).toBe("alice");

        await getSettingByName("App password").secretComponent?.onChangeHandler?.(
            "  vaultdav-app-password  "
        );
        expect(plugin.settings.appPasswordSecret).toBe("vaultdav-app-password");

        await getSettingByName("App password").secretComponent?.onChangeHandler?.(null);
        expect(plugin.settings.appPasswordSecret).toBe("");

        await getSettingByName("Remote base directory").textOnChange?.(
            "  /Notes//Subfolder/  "
        );
        expect(plugin.settings.remoteBaseDir).toBe("Notes/Subfolder");

        const intervalSetting: MockSetting = getSettingByName("Sync interval");
        await intervalSetting.textOnChange?.("15");
        expect(plugin.settings.syncInterval).toBe(15);

        await intervalSetting.textOnChange?.("15.8");
        expect(plugin.settings.syncInterval).toBe(15);

        await intervalSetting.textOnChange?.("15abc");
        expect(plugin.settings.syncInterval).toBe(0);

        await intervalSetting.textOnChange?.("-5");
        expect(plugin.settings.syncInterval).toBe(0);

        await intervalSetting.textOnChange?.("   ");
        expect(plugin.settings.syncInterval).toBe(0);

        const conflictSetting: MockSetting = getSettingByName("Conflict strategy");
        await conflictSetting.dropdownOnChange?.("newest_wins");
        expect(plugin.settings.conflictStrategy).toBe("newest_wins");

        await conflictSetting.dropdownOnChange?.("invalid_value");
        expect(plugin.settings.conflictStrategy).toBe("keep_both");

        const thresholdSetting: MockSetting = getSettingByName("Chunking threshold");
        await thresholdSetting.textOnChange?.("120.7");
        expect(plugin.settings.chunkingThresholdMB).toBe(120);

        await thresholdSetting.textOnChange?.("0");
        expect(plugin.settings.chunkingThresholdMB).toBe(90);

        await thresholdSetting.textOnChange?.("   ");
        expect(plugin.settings.chunkingThresholdMB).toBe(90);

        const chunkSizeSetting: MockSetting = getSettingByName("Chunk size");
        await chunkSizeSetting.textOnChange?.("25.4");
        expect(plugin.settings.chunkSizeMB).toBe(25);

        await chunkSizeSetting.textOnChange?.("-2");
        expect(plugin.settings.chunkSizeMB).toBe(10);

        await chunkSizeSetting.textOnChange?.("   ");
        expect(plugin.settings.chunkSizeMB).toBe(10);

        expect(saveSpy).toHaveBeenCalledTimes(18);
    });

    it("blocks red-team exploit inputs (32-bit timer overflow, OOM chunk sizes, excluded remoteBaseDir, embedded URL credentials, and control/colon injection)", async () => {
        const { app, plugin } = createTestPlugin();
        vi.spyOn(plugin, "saveSettings").mockResolvedValue(undefined);
        const tab: VaultDavSettingTab = new VaultDavSettingTab(app, plugin);

        tab.display();

        await getSettingByName("Sync interval").textOnChange?.("99999999");
        expect(plugin.settings.syncInterval).toBe(MAX_SYNC_INTERVAL_MINUTES);
        expect(plugin.settings.syncInterval * 60 * 1000).toBeLessThanOrEqual(
            2_147_483_647
        );

        await getSettingByName("Chunking threshold").textOnChange?.("999999");
        expect(MAX_CHUNKING_THRESHOLD_MB).toBe(512);
        expect(plugin.settings.chunkingThresholdMB).toBe(MAX_CHUNKING_THRESHOLD_MB);

        await getSettingByName("Chunk size").textOnChange?.("999999");
        expect(plugin.settings.chunkSizeMB).toBe(MAX_CHUNK_SIZE_MB);

        await getSettingByName("Remote base directory").textOnChange?.(
            ".obsidian"
        );
        expect(plugin.settings.remoteBaseDir).toBe("");

        await getSettingByName("Remote base directory").textOnChange?.(
            ".obsidian/plugins/vaultdav"
        );
        expect(plugin.settings.remoteBaseDir).toBe("");

        const { app: customApp, plugin: customPlugin } =
            createTestPlugin("custom-config");
        vi.spyOn(customPlugin, "saveSettings").mockResolvedValue(undefined);
        MockSetting.instances.length = 0;
        const customTab: VaultDavSettingTab = new VaultDavSettingTab(
            customApp,
            customPlugin
        );
        customTab.display();
        await getSettingByName("Remote base directory").textOnChange?.(
            "custom-config"
        );
        expect(customPlugin.settings.remoteBaseDir).toBe("");
        await getSettingByName("Remote base directory").textOnChange?.(
            "custom-config/plugins/vaultdav"
        );
        expect(customPlugin.settings.remoteBaseDir).toBe("");
        MockSetting.instances.length = 0;
        tab.display();

        await getSettingByName("Remote base directory").textOnChange?.(".trash");
        expect(plugin.settings.remoteBaseDir).toBe("");

        await getSettingByName("Remote base directory").textOnChange?.(".git/hooks");
        expect(plugin.settings.remoteBaseDir).toBe("");

        await getSettingByName("Server URL").textOnChange?.(
            "  https://alice:super-secret@cloud.example.com/remote.php/dav  "
        );
        expect(plugin.settings.url).toBe(
            "https://cloud.example.com/remote.php/dav"
        );

        await getSettingByName("Server URL").textOnChange?.(
            "  https://alice@domain.com:p@ss@cloud.example.com/remote.php/dav  "
        );
        expect(plugin.settings.url).toBe(
            "https://cloud.example.com/remote.php/dav"
        );

        await getSettingByName("Server URL").textOnChange?.(
            "https://cloud.example.com?email=user@example.org"
        );
        expect(plugin.settings.url).toBe(
            "https://cloud.example.com?email=user@example.org"
        );

        await getSettingByName("Server URL").textOnChange?.(
            "https://cloud.example.com\r\nX-Injected: true"
        );
        expect(plugin.settings.url).toBe("");

        await getSettingByName("Username").textOnChange?.("alice:injected");
        expect(plugin.settings.username).toBe("");

        await getSettingByName("Username").textOnChange?.("alice/../../root");
        expect(plugin.settings.username).toBe("");

        await getSettingByName("Username").textOnChange?.("alice\x00admin");
        expect(plugin.settings.username).toBe("");

        await getSettingByName("App password").secretComponent?.onChangeHandler?.(
            "token\r\ninjected"
        );
        expect(plugin.settings.appPasswordSecret).toBe("");

        for (const badSecretId of [
            "",
            "   ",
            "UPPERCASE",
            "has spaces",
            "bad_underscore",
            "../traversal",
            "a".repeat(MAX_SECRET_ID_LENGTH + 1),
            null,
            123
        ]) {
            expect(sanitizeSecretId(badSecretId)).toBe("");
        }
        expect(sanitizeSecretId("  vaultdav-app-password-2  ")).toBe(
            "vaultdav-app-password-2"
        );
        expect(
            hasEmbeddedUrlCredentials(
                "https://alice:secret@cloud.example.com/remote.php/dav"
            )
        ).toBe(true);
        expect(
            hasEmbeddedUrlCredentials(
                "https://alice:secret@cloud.example.com\r\nX-Injected: true"
            )
        ).toBe(true);
        expect(
            hasEmbeddedUrlCredentials(
                "https://cloud.example.com?email=user@example.org"
            )
        ).toBe(false);
    });

    it("disables Test connection button during execution and restores state in finally", async () => {
        const { app, plugin } = createTestPlugin();
        let resolveTest: (value: boolean) => void = (): void => undefined;
        vi.spyOn(plugin, "testConnection").mockImplementation(
            (): Promise<boolean> =>
                new Promise<boolean>((resolve: (value: boolean) => void) => {
                    resolveTest = resolve;
                })
        );

        const tab: VaultDavSettingTab = new VaultDavSettingTab(app, plugin);
        tab.display();

        const testSetting: MockSetting = getSettingByName("Test connection");
        const buttonComp = testSetting.buttonComponent;
        expect(buttonComp).not.toBeNull();
        expect(buttonComp?.disabled).toBe(false);
        expect(buttonComp?.buttonEl.textContent).toBe("Test connection");

        const clickPromise: Promise<unknown> = Promise.resolve(
            testSetting.buttonOnClick?.()
        );
        expect(buttonComp?.disabled).toBe(true);
        expect(buttonComp?.buttonEl.textContent).toBe("Testing...");

        resolveTest(true);
        await clickPromise;

        expect(buttonComp?.disabled).toBe(false);
        expect(buttonComp?.buttonEl.textContent).toBe("Test connection");

        vi.spyOn(plugin, "testConnection").mockRejectedValueOnce(
            new Error("Network error")
        );
        await expect(
            Promise.resolve(testSetting.buttonOnClick?.())
        ).rejects.toThrow("Network error");
        expect(buttonComp?.disabled).toBe(false);
        expect(buttonComp?.buttonEl.textContent).toBe("Test connection");
    });

    it("returns declarative SettingDefinitionItem groups matching display() for Obsidian 1.13+ settings search", () => {
        const { app, plugin } = createTestPlugin();
        const tab: VaultDavSettingTab = new VaultDavSettingTab(app, plugin);

        const definitions: SettingDefinitionItem[] = tab.getSettingDefinitions();
        expect(definitions.length).toBe(4);

        const groups: SettingDefinitionGroup[] = definitions as SettingDefinitionGroup[];
        expect(
            groups.map((group: SettingDefinitionGroup) => ({
                heading: group.heading ?? "",
                names: (group.items ?? []).map((item) => item.name),
                type: group.type
            }))
        ).toEqual([
            {
                heading: "",
                names: [
                    "Server URL",
                    "Username",
                    "App password",
                    "Remote base directory"
                ],
                type: "group"
            },
            {
                heading: "",
                names: ["Sync interval", "Conflict strategy"],
                type: "group"
            },
            {
                heading: "",
                names: ["Test connection"],
                type: "group"
            },
            {
                heading: "Advanced sync",
                names: [
                    "Chunking threshold",
                    "Chunk size",
                    "Sync log retention"
                ],
                type: "group"
            }
        ]);

        const connectionItems = groups[0]?.items ?? [];
        expect(connectionItems[0]).toEqual({
            control: {
                defaultValue: "",
                key: "url",
                placeholder: "https://cloud.example.com",
                type: "text"
            },
            desc: "Nextcloud base URL or WebDAV endpoint (https://<domain>).",
            name: "Server URL"
        });
        expect(connectionItems[1]).toEqual({
            control: {
                defaultValue: "",
                key: "username",
                placeholder: "Enter username",
                type: "text"
            },
            desc: "Nextcloud account username.",
            name: "Username"
        });
        expect(connectionItems[2]).toEqual({
            control: {
                defaultValue: "",
                key: "appPasswordSecret",
                type: "secret"
            },
            desc: "Select or create a secret for your Nextcloud app password.",
            name: "App password"
        });
        expect(connectionItems[3]).toEqual({
            control: {
                defaultValue: "",
                key: "remoteBaseDir",
                placeholder: "MyVault",
                type: "text"
            },
            desc: "Target remote folder path inside the Nextcloud user files root.",
            name: "Remote base directory"
        });

        const syncItems = groups[1]?.items ?? [];
        expect(syncItems[0]).toEqual({
            control: {
                defaultValue: 0,
                key: "syncInterval",
                max: MAX_SYNC_INTERVAL_MINUTES,
                min: 0,
                placeholder: "0",
                step: 1,
                type: "number"
            },
            desc: "Automatic synchronization interval in minutes (0 to disable).",
            name: "Sync interval"
        });
        expect(syncItems[1]).toEqual({
            control: {
                defaultValue: "keep_both",
                key: "conflictStrategy",
                options: {
                    keep_both: "Keep both (create conflict copy)",
                    newest_wins: "Newest wins"
                },
                type: "dropdown"
            },
            desc: "Resolution mode for concurrent edits (keep_both or newest_wins).",
            name: "Conflict strategy"
        });

        const advancedItems = groups[3]?.items ?? [];
        expect(advancedItems[0]).toEqual({
            control: {
                defaultValue: 90,
                key: "chunkingThresholdMB",
                max: MAX_CHUNKING_THRESHOLD_MB,
                min: 1,
                placeholder: "90",
                step: 1,
                type: "number"
            },
            desc: "Minimum file size in MB before switching to Nextcloud chunked uploads.",
            name: "Chunking threshold"
        });
        expect(advancedItems[1]).toEqual({
            control: {
                defaultValue: 10,
                key: "chunkSizeMB",
                max: MAX_CHUNK_SIZE_MB,
                min: 1,
                placeholder: "10",
                step: 1,
                type: "number"
            },
            desc: "Target chunk size in MB for chunked uploads and parallel range downloads.",
            name: "Chunk size"
        });
        expect(advancedItems[2]).toEqual({
            control: {
                defaultValue: 30,
                key: "syncLogRetentionDays",
                max: MAX_SYNC_LOG_RETENTION_DAYS,
                min: MIN_SYNC_LOG_RETENTION_DAYS,
                placeholder: "30",
                step: 1,
                type: "number"
            },
            desc: "Days to retain local sync history (1 to 365).",
            name: "Sync log retention"
        });
    });

    it("falls back to SecretComponent render callback for App password on Obsidian 1.13.0-1.13.1 and renders Test connection declaratively", async () => {
        const { app, plugin } = createTestPlugin();
        plugin.settings.appPasswordSecret = "vaultdav-app-password";
        const saveSpy = vi.spyOn(plugin, "saveSettings").mockResolvedValue(undefined);
        const versionSpy = vi
            .spyOn(obsidian, "requireApiVersion")
            .mockImplementation((version: string): boolean => version !== "1.13.2");

        const tab: VaultDavSettingTab = new VaultDavSettingTab(app, plugin);
        const groups: SettingDefinitionGroup[] =
            tab.getSettingDefinitions() as SettingDefinitionGroup[];

        const appPasswordItem: SettingDefinitionRender | undefined = groups[0]
            ?.items?.[2] as SettingDefinitionRender | undefined;
        expect(appPasswordItem?.name).toBe("App password");
        expect(typeof appPasswordItem?.render).toBe("function");
        expect(
            (appPasswordItem as unknown as SettingDefinitionControl).control
        ).toBeUndefined();

        const containerEl: HTMLElement = document.createElement("div");
        const mockGroup: ObsidianSettingGroup = new MockSettingGroup(
            containerEl
        ) as unknown as ObsidianSettingGroup;
        const appPasswordSetting: MockSetting = new MockSetting(containerEl);
        appPasswordItem?.render(
            appPasswordSetting as unknown as obsidian.Setting,
            mockGroup
        );
        expect(appPasswordSetting.secretComponent).not.toBeNull();
        expect(appPasswordSetting.secretComponent?.value).toBe(
            "vaultdav-app-password"
        );
        await appPasswordSetting.secretComponent?.onChangeHandler?.(
            "  vaultdav-next-secret  "
        );
        expect(plugin.settings.appPasswordSecret).toBe("vaultdav-next-secret");
        expect(saveSpy).toHaveBeenCalledTimes(1);

        versionSpy.mockRestore();

        let resolveTest: (value: boolean) => void = (): void => undefined;
        vi.spyOn(plugin, "testConnection").mockImplementation(
            (): Promise<boolean> =>
                new Promise<boolean>((resolve: (value: boolean) => void) => {
                    resolveTest = resolve;
                })
        );
        const testItem: SettingDefinitionRender | undefined = groups[2]
            ?.items?.[0] as SettingDefinitionRender | undefined;
        expect(testItem?.name).toBe("Test connection");
        expect(testItem?.desc).toBe(
            "Verify Nextcloud WebDAV credentials and remote directory access."
        );
        const testSetting: MockSetting = new MockSetting(containerEl);
        testItem?.render(testSetting as unknown as obsidian.Setting, mockGroup);
        const buttonComp = testSetting.buttonComponent;
        expect(buttonComp).not.toBeNull();
        expect(buttonComp?.buttonEl.textContent).toBe("Test connection");

        const clickPromise: Promise<unknown> = Promise.resolve(
            testSetting.buttonOnClick?.()
        );
        expect(buttonComp?.disabled).toBe(true);
        expect(buttonComp?.buttonEl.textContent).toBe("Testing...");
        resolveTest(true);
        await clickPromise;
        expect(buttonComp?.disabled).toBe(false);
        expect(buttonComp?.buttonEl.textContent).toBe("Test connection");
    });

    it("reads and sanitizes all setting values through getControlValue() and setControlValue()", async () => {
        const { app, plugin } = createTestPlugin("custom-config");
        const saveSpy = vi.spyOn(plugin, "saveSettings").mockResolvedValue(undefined);
        const tab: VaultDavSettingTab = new VaultDavSettingTab(app, plugin);

        expect(tab.getControlValue("url")).toBe("");
        expect(tab.getControlValue("username")).toBe("");
        expect(tab.getControlValue("appPasswordSecret")).toBe("");
        expect(tab.getControlValue("remoteBaseDir")).toBe("");
        expect(tab.getControlValue("syncInterval")).toBe(0);
        expect(tab.getControlValue("conflictStrategy")).toBe("keep_both");
        expect(tab.getControlValue("chunkingThresholdMB")).toBe(90);
        expect(tab.getControlValue("chunkSizeMB")).toBe(10);
        expect(tab.getControlValue("syncLogRetentionDays")).toBe(30);
        expect(tab.getControlValue("unknown")).toBeUndefined();
        expect(tab.getControlValue("__proto__")).toBeUndefined();
        expect(tab.getControlValue("constructor")).toBeUndefined();

        await tab.setControlValue(
            "url",
            "  https://alice:secret@cloud.example.com/remote.php/dav  "
        );
        expect(tab.getControlValue("url")).toBe(
            "https://cloud.example.com/remote.php/dav"
        );

        await tab.setControlValue("username", "  alice  ");
        expect(tab.getControlValue("username")).toBe("alice");
        await tab.setControlValue("username", "alice:bad");
        expect(tab.getControlValue("username")).toBe("");

        await tab.setControlValue("appPasswordSecret", "  vaultdav-secret-1  ");
        expect(tab.getControlValue("appPasswordSecret")).toBe("vaultdav-secret-1");
        await tab.setControlValue("appPasswordSecret", "INVALID_SECRET");
        expect(tab.getControlValue("appPasswordSecret")).toBe("");

        await tab.setControlValue("remoteBaseDir", "  /Notes//Sub/  ");
        expect(tab.getControlValue("remoteBaseDir")).toBe("Notes/Sub");
        await tab.setControlValue("remoteBaseDir", "custom-config/plugins/vaultdav");
        expect(tab.getControlValue("remoteBaseDir")).toBe("");

        await tab.setControlValue("syncInterval", 15.9);
        expect(tab.getControlValue("syncInterval")).toBe(15);
        await tab.setControlValue("syncInterval", 99999999);
        expect(tab.getControlValue("syncInterval")).toBe(MAX_SYNC_INTERVAL_MINUTES);
        await tab.setControlValue("syncInterval", Number.NaN);
        expect(tab.getControlValue("syncInterval")).toBe(0);

        await tab.setControlValue("conflictStrategy", "newest_wins");
        expect(tab.getControlValue("conflictStrategy")).toBe("newest_wins");
        await tab.setControlValue("conflictStrategy", "invalid");
        expect(tab.getControlValue("conflictStrategy")).toBe("keep_both");

        await tab.setControlValue("chunkingThresholdMB", 150.4);
        expect(tab.getControlValue("chunkingThresholdMB")).toBe(150);
        await tab.setControlValue("chunkingThresholdMB", 9999);
        expect(tab.getControlValue("chunkingThresholdMB")).toBe(
            MAX_CHUNKING_THRESHOLD_MB
        );
        await tab.setControlValue("chunkingThresholdMB", 0);
        expect(tab.getControlValue("chunkingThresholdMB")).toBe(90);

        await tab.setControlValue("chunkSizeMB", 20.8);
        expect(tab.getControlValue("chunkSizeMB")).toBe(20);
        await tab.setControlValue("chunkSizeMB", -4);
        expect(tab.getControlValue("chunkSizeMB")).toBe(10);

        await tab.setControlValue("syncLogRetentionDays", 45.7);
        expect(tab.getControlValue("syncLogRetentionDays")).toBe(45);
        await tab.setControlValue("syncLogRetentionDays", 999);
        expect(tab.getControlValue("syncLogRetentionDays")).toBe(
            MAX_SYNC_LOG_RETENTION_DAYS
        );
        await tab.setControlValue("syncLogRetentionDays", 0);
        expect(tab.getControlValue("syncLogRetentionDays")).toBe(30);

        const saveCountBeforeUnknown: number = saveSpy.mock.calls.length;
        await tab.setControlValue("unknown", "ignored");
        await tab.setControlValue("__proto__", "polluted");
        expect(saveSpy.mock.calls.length).toBe(saveCountBeforeUnknown);
    });
});
