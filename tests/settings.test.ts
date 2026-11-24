import type {
    App,
    PluginManifest,
    Setting as ObsidianSetting,
    SettingDefinitionGroup,
    SettingDefinitionItem,
    SettingDefinitionRender,
    SettingGroup as ObsidianSettingGroup
} from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";
import VaultDavPlugin from "../src/main";
import {
    DEFAULT_SETTINGS,
    hasEmbeddedUrlCredentials,
    MAX_CHUNK_SIZE_MB,
    MAX_CHUNKING_THRESHOLD_MB,
    MAX_SECRET_ID_LENGTH,
    MAX_SYNC_INTERVAL_MINUTES,
    MAX_SYNC_LOG_RETENTION_DAYS,
    MIN_SYNC_LOG_RETENTION_DAYS,
    resolveRemoteBaseDir,
    resolveWebDavUrlPreview,
    sanitizeSecretId,
    sanitizeServerUrl,
    VaultDavSettingTab
} from "../src/settings";
import {
    SecretStorage as MockSecretStorage,
    Setting as MockSetting,
    SettingGroup as MockSettingGroup
} from "./obsidian_mock";

interface RenderedDeclarativeTab {
    cleanups: Array<() => void>;
    groups: SettingDefinitionGroup[];
}

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
        minAppVersion: "1.13.2",
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

function renderDeclarativeTab(tab: VaultDavSettingTab): RenderedDeclarativeTab {
    const definitions: SettingDefinitionItem[] = tab.getSettingDefinitions();
    const groups: SettingDefinitionGroup[] =
        definitions as SettingDefinitionGroup[];
    const cleanups: Array<() => void> = [];
    const containerEl: HTMLElement = document.createElement("div");

    for (const group of groups) {
        const mockGroup: MockSettingGroup = new MockSettingGroup(containerEl);
        if (group.heading !== undefined) {
            mockGroup.setHeading(group.heading);
        }
        for (const item of group.items ?? []) {
            if ("render" in item && typeof item.render === "function") {
                const renderItem: SettingDefinitionRender = item;
                const mockSetting: MockSetting = new MockSetting(mockGroup.listEl);
                mockSetting.setName(renderItem.name);
                if (typeof renderItem.desc === "string") {
                    mockSetting.setDesc(renderItem.desc);
                }
                const cleanup = renderItem.render(
                    mockSetting as unknown as ObsidianSetting,
                    mockGroup as unknown as ObsidianSettingGroup
                );
                if (typeof cleanup === "function") {
                    cleanups.push(cleanup);
                }
            }
        }
    }

    return { cleanups, groups };
}

describe("VaultDavSettingTab and DEFAULT_SETTINGS", () => {
    beforeEach(() => {
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

    it("returns declarative SettingDefinitionItem groups with strict Obsidian Sentence case names, controls, and mobile input hygiene", () => {
        const { app, plugin } = createTestPlugin();
        const tab: VaultDavSettingTab = new VaultDavSettingTab(app, plugin);

        const { cleanups, groups } = renderDeclarativeTab(tab);
        expect(groups.length).toBe(4);
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
                    "Remote base directory",
                    "Resolved WebDAV URL"
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
        const urlItem: SettingDefinitionRender | undefined =
            connectionItems[0] as SettingDefinitionRender | undefined;
        const usernameItem: SettingDefinitionRender | undefined =
            connectionItems[1] as SettingDefinitionRender | undefined;
        const remoteDirItem: SettingDefinitionRender | undefined =
            connectionItems[3] as SettingDefinitionRender | undefined;
        const previewItem: SettingDefinitionRender | undefined =
            connectionItems[4] as SettingDefinitionRender | undefined;

        expect(urlItem?.name).toBe("Server URL");
        expect(urlItem?.desc).toBe(
            "Nextcloud host or WebDAV URL (uses https:// if omitted; only http:// and https:// allowed)."
        );
        expect(typeof urlItem?.render).toBe("function");

        expect(usernameItem?.name).toBe("Username");
        expect(usernameItem?.desc).toBe("Nextcloud account username.");
        expect(typeof usernameItem?.render).toBe("function");

        expect(connectionItems[2]).toEqual({
            control: {
                defaultValue: "",
                key: "appPasswordSecret",
                type: "secret"
            },
            desc: "Select or create a secret for your Nextcloud app password.",
            name: "App password"
        });

        expect(remoteDirItem?.name).toBe("Remote base directory");
        expect(remoteDirItem?.desc).toBe(
            "Target remote folder path inside the Nextcloud user files root."
        );
        expect(typeof remoteDirItem?.render).toBe("function");

        expect(previewItem?.name).toBe("Resolved WebDAV URL");
        expect(previewItem?.desc).toBe(
            "Full WebDAV endpoint constructed from server URL, username, and remote base directory."
        );
        expect(typeof previewItem?.render).toBe("function");

        for (const label of ["Server URL", "Username", "Remote base directory"]) {
            const setting: MockSetting = getSettingByName(label);
            const inputEl: HTMLInputElement | undefined =
                setting.textComponent?.inputEl;
            expect(inputEl).toBeDefined();
            expect(inputEl?.autocapitalize).toBe("none");
            expect(inputEl?.getAttribute("autocapitalize")).toBe("none");
            expect(inputEl?.getAttribute("autocorrect")).toBe("off");
            expect(inputEl?.autocomplete).toBe("off");
            expect(inputEl?.spellcheck).toBe(false);
        }
        expect(
            getSettingByName("Server URL").textComponent?.inputEl.getAttribute(
                "inputmode"
            )
        ).toBe("url");
        expect(
            getSettingByName("Server URL").textComponent?.inputEl.placeholder
        ).toBe("https://cloud.example.com");
        expect(
            getSettingByName("Username").textComponent?.inputEl.placeholder
        ).toBe("Enter username");
        expect(
            getSettingByName("Remote base directory").textComponent?.inputEl
                .placeholder
        ).toBe("MyVault");

        const previewEl: HTMLElement | null = getSettingByName(
            "Resolved WebDAV URL"
        ).descEl.querySelector(".vaultdav-settings-endpoint-preview");
        expect(previewEl?.textContent).toBe(
            "Enter server URL and username to preview the WebDAV URL."
        );

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

        const testItem: SettingDefinitionRender | undefined = groups[2]
            ?.items?.[0] as SettingDefinitionRender | undefined;
        expect(testItem?.name).toBe("Test connection");
        expect(testItem?.desc).toBe(
            "Verify Nextcloud WebDAV credentials and remote directory access."
        );
        expect(
            getSettingByName("Test connection").buttonComponent?.buttonEl
                .textContent
        ).toBe("Test connection");

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

        expect(cleanups.length).toBe(4);
        for (const cleanup of cleanups) {
            cleanup();
        }
    });

    it("normalizes and persists setting changes across rendered controls and getControlValue/setControlValue", async () => {
        const { app, plugin } = createTestPlugin("custom-config");
        const saveSpy = vi
            .spyOn(plugin, "saveSettings")
            .mockResolvedValue(undefined);
        const tab: VaultDavSettingTab = new VaultDavSettingTab(app, plugin);

        renderDeclarativeTab(tab);

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

        await getSettingByName("Server URL").textOnChange?.(
            "  https://nc.example.com/  "
        );
        expect(tab.getControlValue("url")).toBe("https://nc.example.com/");

        await getSettingByName("Username").textOnChange?.("  alice  ");
        expect(tab.getControlValue("username")).toBe("alice");

        await tab.setControlValue(
            "appPasswordSecret",
            "  vaultdav-app-password  "
        );
        expect(tab.getControlValue("appPasswordSecret")).toBe(
            "vaultdav-app-password"
        );
        await tab.setControlValue("appPasswordSecret", null);
        expect(tab.getControlValue("appPasswordSecret")).toBe("");

        await getSettingByName("Remote base directory").textOnChange?.(
            "  /Notes//Subfolder/  "
        );
        expect(tab.getControlValue("remoteBaseDir")).toBe("Notes/Subfolder");

        await tab.setControlValue("syncInterval", "15");
        expect(tab.getControlValue("syncInterval")).toBe(15);
        await tab.setControlValue("syncInterval", 15.9);
        expect(tab.getControlValue("syncInterval")).toBe(15);
        await tab.setControlValue("syncInterval", "15abc");
        expect(tab.getControlValue("syncInterval")).toBe(0);
        await tab.setControlValue("syncInterval", "-5");
        expect(tab.getControlValue("syncInterval")).toBe(0);
        await tab.setControlValue("syncInterval", "   ");
        expect(tab.getControlValue("syncInterval")).toBe(0);
        await tab.setControlValue("syncInterval", Number.NaN);
        expect(tab.getControlValue("syncInterval")).toBe(0);

        await tab.setControlValue("conflictStrategy", "newest_wins");
        expect(tab.getControlValue("conflictStrategy")).toBe("newest_wins");
        await tab.setControlValue("conflictStrategy", "invalid_value");
        expect(tab.getControlValue("conflictStrategy")).toBe("keep_both");

        await tab.setControlValue("chunkingThresholdMB", 120.7);
        expect(tab.getControlValue("chunkingThresholdMB")).toBe(120);
        await tab.setControlValue("chunkingThresholdMB", 0);
        expect(tab.getControlValue("chunkingThresholdMB")).toBe(90);
        await tab.setControlValue("chunkingThresholdMB", "   ");
        expect(tab.getControlValue("chunkingThresholdMB")).toBe(90);

        await tab.setControlValue("chunkSizeMB", 25.4);
        expect(tab.getControlValue("chunkSizeMB")).toBe(25);
        await tab.setControlValue("chunkSizeMB", -2);
        expect(tab.getControlValue("chunkSizeMB")).toBe(10);
        await tab.setControlValue("chunkSizeMB", "   ");
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
        expect(saveCountBeforeUnknown).toBe(22);
        await tab.setControlValue("unknown", "ignored");
        await tab.setControlValue("__proto__", "polluted");
        expect(saveSpy.mock.calls.length).toBe(saveCountBeforeUnknown);
    });

    it("blocks red-team exploit inputs (32-bit timer overflow, OOM chunk sizes, excluded remoteBaseDir, embedded URL credentials, and control/colon injection)", async () => {
        const { app, plugin } = createTestPlugin();
        vi.spyOn(plugin, "saveSettings").mockResolvedValue(undefined);
        const tab: VaultDavSettingTab = new VaultDavSettingTab(app, plugin);

        renderDeclarativeTab(tab);

        await tab.setControlValue("syncInterval", "99999999");
        expect(plugin.settings.syncInterval).toBe(MAX_SYNC_INTERVAL_MINUTES);
        expect(plugin.settings.syncInterval * 60 * 1000).toBeLessThanOrEqual(
            2_147_483_647
        );

        await tab.setControlValue("chunkingThresholdMB", "999999");
        expect(MAX_CHUNKING_THRESHOLD_MB).toBe(512);
        expect(plugin.settings.chunkingThresholdMB).toBe(
            MAX_CHUNKING_THRESHOLD_MB
        );

        await tab.setControlValue("chunkSizeMB", "999999");
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
        renderDeclarativeTab(customTab);
        await getSettingByName("Remote base directory").textOnChange?.(
            "custom-config"
        );
        expect(customPlugin.settings.remoteBaseDir).toBe("");
        await getSettingByName("Remote base directory").textOnChange?.(
            "custom-config/plugins/vaultdav"
        );
        expect(customPlugin.settings.remoteBaseDir).toBe("");
        MockSetting.instances.length = 0;
        renderDeclarativeTab(tab);

        await getSettingByName("Remote base directory").textOnChange?.(".trash");
        expect(plugin.settings.remoteBaseDir).toBe("");

        await getSettingByName("Remote base directory").textOnChange?.(
            ".git/hooks"
        );
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
            "https://cloud.example.com/users/alice@example.com"
        );
        expect(plugin.settings.url).toBe(
            "https://cloud.example.com/users/alice@example.com"
        );

        await getSettingByName("Server URL").textOnChange?.(
            "https://cloud.example.com?email=user@example.org"
        );
        expect(plugin.settings.url).toBe("");

        await getSettingByName("Server URL").textOnChange?.(
            "https://cloud.example.com#secret-fragment"
        );
        expect(plugin.settings.url).toBe("");

        await getSettingByName("Server URL").textOnChange?.(
            "https://cloud.example.com:0"
        );
        expect(plugin.settings.url).toBe("");

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

        await tab.setControlValue("appPasswordSecret", "token\r\ninjected");
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
        expect(
            hasEmbeddedUrlCredentials(
                "https://alice:my secret@cloud.example.com/remote.php/dav"
            )
        ).toBe(true);
        expect(
            hasEmbeddedUrlCredentials("alice:my secret@cloud.example.com")
        ).toBe(true);
        expect(
            hasEmbeddedUrlCredentials(
                "https://alice:pass\tword@cloud.example.com/dav"
            )
        ).toBe(true);
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
        renderDeclarativeTab(tab);

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

    it("auto-prepends https:// for bare hosts, allows only http:// and https://, updates the resolved WebDAV URL preview live, and normalizes on blur", async () => {
        const { app, plugin } = createTestPlugin();
        vi.spyOn(plugin, "saveSettings").mockResolvedValue(undefined);

        expect(sanitizeServerUrl("example.com")).toBe("https://example.com");
        expect(sanitizeServerUrl("  example.com/nextcloud  ")).toBe(
            "https://example.com/nextcloud"
        );
        expect(sanitizeServerUrl("example.com:8443/nextcloud")).toBe(
            "https://example.com:8443/nextcloud"
        );
        expect(sanitizeServerUrl("http://192.168.1.50:8080/nextcloud")).toBe(
            "http://192.168.1.50:8080/nextcloud"
        );
        expect(sanitizeServerUrl("HTTP://192.168.1.50/")).toBe(
            "http://192.168.1.50/"
        );
        expect(sanitizeServerUrl("http://alice:secret@192.168.1.50/dav")).toBe(
            "http://192.168.1.50/dav"
        );
        expect(sanitizeServerUrl("ftp://example.com")).toBe("");
        expect(sanitizeServerUrl("file:///etc/passwd")).toBe("");
        expect(sanitizeServerUrl("javascript:alert(1)")).toBe("");
        expect(sanitizeServerUrl("davs://example.com")).toBe("");
        expect(sanitizeServerUrl("ws://example.com")).toBe("");
        expect(sanitizeServerUrl("http:example.com")).toBe("");
        expect(sanitizeServerUrl("//example.com")).toBe("");
        expect(sanitizeServerUrl("/remote.php/dav")).toBe("");
        expect(sanitizeServerUrl("alice:secret@example.com")).toBe("");
        expect(hasEmbeddedUrlCredentials("alice:secret@example.com")).toBe(true);
        expect(hasEmbeddedUrlCredentials("http://alice:secret@192.168.1.50")).toBe(
            true
        );
        expect(hasEmbeddedUrlCredentials("example.com/user@domain")).toBe(false);

        expect(resolveRemoteBaseDir("", "MyVault", ".obsidian")).toBe("MyVault");
        expect(resolveRemoteBaseDir("  /Vault/Notes/ ", "MyVault", ".obsidian")).toBe(
            "Vault/Notes"
        );
        expect(resolveRemoteBaseDir(".obsidian", ".obsidian", ".obsidian")).toBe(
            "VaultDAV"
        );

        expect(
            resolveWebDavUrlPreview("", "", "", "MyVault", ".obsidian")
        ).toEqual({
            isError: false,
            isReady: false,
            text: "Enter server URL and username to preview the WebDAV URL."
        });
        expect(
            resolveWebDavUrlPreview("example.com", "", "", "MyVault", ".obsidian")
        ).toEqual({
            isError: false,
            isReady: false,
            text: "Enter username to preview the WebDAV URL."
        });
        expect(
            resolveWebDavUrlPreview(
                "example.com",
                "stefan",
                "",
                "Vault",
                ".obsidian"
            )
        ).toEqual({
            isError: false,
            isReady: true,
            text: "https://example.com/remote.php/dav/files/stefan/Vault/"
        });
        expect(
            resolveWebDavUrlPreview(
                "http://192.168.1.50:8080/nextcloud",
                "stefan",
                "Notes/Work",
                "Vault",
                ".obsidian"
            )
        ).toEqual({
            isError: false,
            isReady: true,
            text: "http://192.168.1.50:8080/nextcloud/remote.php/dav/files/stefan/Notes/Work/"
        });
        expect(
            resolveWebDavUrlPreview(
                "ftp://example.com",
                "stefan",
                "Vault",
                "Vault",
                ".obsidian"
            )
        ).toEqual({
            isError: true,
            isReady: false,
            text: "Server URL must use http:// or https://."
        });
        expect(
            resolveWebDavUrlPreview(
                "https://example.com?foo=bar",
                "stefan",
                "Vault",
                "Vault",
                ".obsidian"
            )
        ).toEqual({
            isError: true,
            isReady: false,
            text: "Server URL must not contain query or hash parameters."
        });
        expect(
            resolveWebDavUrlPreview(
                "https://stefan:supersecret@example.com",
                "stefan",
                "Vault",
                "Vault",
                ".obsidian"
            )
        ).toEqual({
            isError: false,
            isReady: true,
            text: "https://example.com/remote.php/dav/files/stefan/Vault/"
        });
        expect(
            resolveWebDavUrlPreview(
                "example.com",
                "stefan:bad",
                "Vault",
                "Vault",
                ".obsidian"
            )
        ).toEqual({
            isError: true,
            isReady: false,
            text: "Username must not contain colons, slashes, or control characters."
        });
        expect(
            resolveWebDavUrlPreview(
                "example.com",
                "stefan",
                ".obsidian",
                "Vault",
                ".obsidian"
            )
        ).toEqual({
            isError: true,
            isReady: false,
            text: "Remote base directory cannot use excluded or invalid paths."
        });

        // Live UI updates in declarative render callbacks
        const tab: VaultDavSettingTab = new VaultDavSettingTab(app, plugin);
        const { cleanups } = renderDeclarativeTab(tab);

        const urlSetting: MockSetting = getSettingByName("Server URL");
        const userSetting: MockSetting = getSettingByName("Username");
        const dirSetting: MockSetting = getSettingByName("Remote base directory");
        const previewSetting: MockSetting = getSettingByName(
            "Resolved WebDAV URL"
        );
        const previewEl: HTMLElement | null =
            previewSetting.descEl.querySelector(
                ".vaultdav-settings-endpoint-preview"
            );
        expect(previewEl).not.toBeNull();
        expect(previewEl?.classList.contains("is-placeholder")).toBe(true);
        expect(previewEl?.textContent).toBe(
            "Enter server URL and username to preview the WebDAV URL."
        );

        // Bare domain automatically assumes https:// and updates preview live
        if (urlSetting.textComponent !== null) {
            urlSetting.textComponent.inputEl.value = "example.com";
        }
        await urlSetting.textOnChange?.("example.com");
        expect(plugin.settings.url).toBe("https://example.com");
        expect(previewEl?.textContent).toBe(
            "Enter username to preview the WebDAV URL."
        );

        // Blurring Server URL updates input field to normalized https:// URL
        urlSetting.textComponent?.inputEl.dispatchEvent(new Event("blur"));
        expect(urlSetting.textComponent?.inputEl.value).toBe(
            "https://example.com"
        );

        await userSetting.textOnChange?.("stefan");
        expect(previewEl?.classList.contains("is-placeholder")).toBe(false);
        expect(previewEl?.classList.contains("is-error")).toBe(false);
        expect(previewEl?.textContent).toBe(
            "https://example.com/remote.php/dav/files/stefan/MyVault/"
        );

        await dirSetting.textOnChange?.("Vault");
        expect(previewEl?.textContent).toBe(
            "https://example.com/remote.php/dav/files/stefan/Vault/"
        );

        // Switching to explicit http:// updates preview live
        await urlSetting.textOnChange?.("http://192.168.1.50:8080/nextcloud");
        expect(plugin.settings.url).toBe("http://192.168.1.50:8080/nextcloud");
        expect(previewEl?.textContent).toBe(
            "http://192.168.1.50:8080/nextcloud/remote.php/dav/files/stefan/Vault/"
        );

        // Entering forbidden scheme rejects persistence and shows inline error without wiping raw input on blur
        if (urlSetting.textComponent !== null) {
            urlSetting.textComponent.inputEl.value = "ftp://example.com";
        }
        await urlSetting.textOnChange?.("ftp://example.com");
        expect(plugin.settings.url).toBe("");
        expect(previewEl?.classList.contains("is-error")).toBe(true);
        expect(previewEl?.textContent).toBe(
            "Server URL must use http:// or https://."
        );
        urlSetting.textComponent?.inputEl.dispatchEvent(new Event("blur"));
        expect(urlSetting.textComponent?.inputEl.value).toBe("ftp://example.com");

        // Cleanup callbacks detach blur listener and hide() clears transient state safely
        for (const cleanup of cleanups) {
            cleanup();
        }
        if (urlSetting.textComponent !== null) {
            urlSetting.textComponent.inputEl.value = "example.org";
            urlSetting.textComponent.inputEl.dispatchEvent(new Event("blur"));
            expect(urlSetting.textComponent.inputEl.value).toBe("example.org");
        }
        tab.hide();
        await tab.setControlValue("url", "example.org");
        expect(plugin.settings.url).toBe("https://example.org");
    });
});
