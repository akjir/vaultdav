import type { App, PluginManifest } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";
import VaultDavPlugin from "../src/main";
import {
    createSettingGroup,
    DEFAULT_SETTINGS,
    MAX_CHUNK_SIZE_MB,
    MAX_CHUNKING_THRESHOLD_MB,
    MAX_SYNC_INTERVAL_MINUTES,
    VaultDavSettingTab
} from "../src/settings";
import {
    Setting as MockSetting,
    SettingGroup as MockSettingGroup
} from "./obsidian_mock";

function createTestPlugin(): { app: App; plugin: VaultDavPlugin } {
    const mockApp: App = {
        vault: {
            adapter: {
                exists: async (): Promise<boolean> => false,
                mkdir: async (): Promise<void> => undefined,
                read: async (): Promise<string> => "{}",
                write: async (): Promise<void> => undefined
            },
            getName: (): string => "MyVault"
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
        MockSetting.instances.length = 0;
        MockSettingGroup.instances.length = 0;
    });

    it("defines expected DEFAULT_SETTINGS keys, default values, and freezes the object against mutation", () => {
        expect(Object.keys(DEFAULT_SETTINGS).sort()).toEqual([
            "appPassword",
            "chunkSizeMB",
            "chunkingThresholdMB",
            "conflictStrategy",
            "remoteBaseDir",
            "syncInterval",
            "url",
            "username"
        ]);
        expect(DEFAULT_SETTINGS).toEqual({
            appPassword: "",
            chunkSizeMB: 10,
            chunkingThresholdMB: 90,
            conflictStrategy: "keep_both",
            remoteBaseDir: "",
            syncInterval: 0,
            url: "",
            username: ""
        });
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
                names: ["Chunking threshold", "Chunk size"]
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
            "Chunk size"
        ]);

        expect(getSettingByName("Server URL").desc).toBe(
            "Nextcloud base URL or WebDAV endpoint (https://<domain>)."
        );
        expect(getSettingByName("Username").desc).toBe("Nextcloud account username.");
        expect(getSettingByName("App password").desc).toBe(
            "Nextcloud app password for HTTP Basic authentication."
        );
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
    });

    it("falls back to flat Setting items when SettingGroup is unavailable", () => {
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
    });

    it("configures mobile input hygiene and input types/bounds on text controls", () => {
        const { app, plugin } = createTestPlugin();
        const tab: VaultDavSettingTab = new VaultDavSettingTab(app, plugin);

        tab.display();

        for (const label of [
            "Server URL",
            "Username",
            "App password",
            "Remote base directory"
        ]) {
            const setting: MockSetting = getSettingByName(label);
            const inputEl: HTMLInputElement | undefined = setting.textComponent?.inputEl;
            expect(inputEl).toBeDefined();
            expect(inputEl?.autocapitalize).toBe("none");
            expect(inputEl?.spellcheck).toBe(false);
        }

        const passwordInput: HTMLInputElement | undefined =
            getSettingByName("App password").textComponent?.inputEl;
        expect(passwordInput?.type).toBe("password");

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

        await getSettingByName("App password").textOnChange?.("  secret-token  ");
        expect(plugin.settings.appPassword).toBe("secret-token");

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

        expect(saveSpy).toHaveBeenCalledTimes(17);
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
        expect(plugin.settings.chunkingThresholdMB).toBe(MAX_CHUNKING_THRESHOLD_MB);

        await getSettingByName("Chunk size").textOnChange?.("999999");
        expect(plugin.settings.chunkSizeMB).toBe(MAX_CHUNK_SIZE_MB);

        await getSettingByName("Remote base directory").textOnChange?.(
            ".obsidian/plugins/vaultdav"
        );
        expect(plugin.settings.remoteBaseDir).toBe("");

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
            "https://cloud.example.com\r\nX-Injected: true"
        );
        expect(plugin.settings.url).toBe("");

        await getSettingByName("Username").textOnChange?.("alice:injected");
        expect(plugin.settings.username).toBe("");

        await getSettingByName("Username").textOnChange?.("alice/../../root");
        expect(plugin.settings.username).toBe("");

        await getSettingByName("Username").textOnChange?.("alice\x00admin");
        expect(plugin.settings.username).toBe("");

        await getSettingByName("App password").textOnChange?.("token\r\ninjected");
        expect(plugin.settings.appPassword).toBe("");
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
});
