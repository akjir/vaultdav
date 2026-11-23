import {
    type App,
    PluginSettingTab,
    requireApiVersion,
    SecretComponent,
    Setting,
    SettingGroup
} from "obsidian";
import type VaultDavPlugin from "./main";
import type { ConflictStrategy, VaultDavSettings } from "./types";
import { util } from "./utilities";

export interface SettingGroupBuilder {
    addSetting: (cb: (setting: Setting) => void) => SettingGroupBuilder;
    setHeading: (text: string) => SettingGroupBuilder;
}

export type SettingGroupConstructor = new (
    containerEl: HTMLElement
) => SettingGroupBuilder;

export const DEFAULT_APP_PASSWORD_SECRET_ID: string = "vaultdav-app-password";
export const DEFAULT_SETTINGS: Readonly<VaultDavSettings> =
    Object.freeze<VaultDavSettings>({
        appPasswordSecret: "",
        chunkSizeMB: 10,
        chunkingThresholdMB: 90,
        conflictStrategy: "keep_both",
        remoteBaseDir: "",
        syncInterval: 0,
        url: "",
        username: ""
    });
export const MAX_CHUNK_SIZE_MB: number = 512;
export const MAX_CHUNKING_THRESHOLD_MB: number = 512;
export const MAX_SECRET_ID_LENGTH: number = 64;
export const MAX_SYNC_INTERVAL_MINUTES: number = 10080;

const SECRET_ID_REGEX: RegExp = /^[a-z0-9-]+$/;
const URL_USERINFO_REGEX: RegExp = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/\s?#]+@/i;

export function createSettingGroup(
    containerEl: HTMLElement,
    groupConstructor?: SettingGroupConstructor | null
): SettingGroupBuilder {
    if (groupConstructor !== undefined) {
        if (typeof groupConstructor === "function") {
            return new groupConstructor(containerEl);
        }
    } else if (
        requireApiVersion("1.11.0") &&
        typeof SettingGroup === "function"
    ) {
        return new SettingGroup(containerEl);
    }
    const fallbackGroup: SettingGroupBuilder = {
        addSetting: (cb: (setting: Setting) => void): SettingGroupBuilder => {
            cb(new Setting(containerEl));
            return fallbackGroup;
        },
        setHeading: (text: string): SettingGroupBuilder => {
            new Setting(containerEl).setName(text).setHeading();
            return fallbackGroup;
        }
    };
    return fallbackGroup;
}

export function hasEmbeddedUrlCredentials(value: string): boolean {
    return URL_USERINFO_REGEX.test(value.trim());
}

export function sanitizeAppPassword(value: string): string {
    if (util.hasControlChars(value)) {
        return "";
    }
    return value.trim();
}

export function sanitizeChunkSizeMB(value: unknown): number {
    if (
        typeof value === "number" &&
        Number.isFinite(value) &&
        value >= 1
    ) {
        return Math.min(MAX_CHUNK_SIZE_MB, Math.floor(value));
    }
    return DEFAULT_SETTINGS.chunkSizeMB;
}

export function sanitizeChunkingThresholdMB(value: unknown): number {
    if (
        typeof value === "number" &&
        Number.isFinite(value) &&
        value >= 1
    ) {
        return Math.min(MAX_CHUNKING_THRESHOLD_MB, Math.floor(value));
    }
    return DEFAULT_SETTINGS.chunkingThresholdMB;
}

export function sanitizeRemoteBaseDir(value: string, configDir: string): string {
    const normalized: string = util.normalizeVaultPath(value);
    return normalized !== "" && util.isExcludedPath(normalized, configDir)
        ? ""
        : normalized;
}

export function sanitizeSecretId(value: unknown): string {
    if (typeof value !== "string" || util.hasControlChars(value)) {
        return "";
    }
    const trimmed: string = value.trim();
    if (
        trimmed === "" ||
        trimmed.length > MAX_SECRET_ID_LENGTH ||
        !SECRET_ID_REGEX.test(trimmed)
    ) {
        return "";
    }
    return trimmed;
}

export function sanitizeServerUrl(value: string): string {
    if (util.hasControlChars(value)) {
        return "";
    }
    return value.trim().replace(URL_USERINFO_REGEX, "$1");
}

export function sanitizeSyncInterval(value: unknown): number {
    if (
        typeof value === "number" &&
        Number.isFinite(value) &&
        value >= 0
    ) {
        return Math.min(MAX_SYNC_INTERVAL_MINUTES, Math.floor(value));
    }
    return DEFAULT_SETTINGS.syncInterval;
}

export function sanitizeUsername(value: string): string {
    if (util.hasControlChars(value)) {
        return "";
    }
    const trimmed: string = value.normalize("NFC").trim();
    if (
        trimmed.includes(":") ||
        trimmed.includes("/") ||
        trimmed.includes("\\")
    ) {
        return "";
    }
    return trimmed;
}

export class VaultDavSettingTab extends PluginSettingTab {
    private readonly pluginInstance: VaultDavPlugin;

    public constructor(app: App, plugin: VaultDavPlugin) {
        super(app, plugin);
        this.pluginInstance = plugin;
    }

    public display(): void {
        const { containerEl } = this;
        if (typeof containerEl.empty === "function") {
            containerEl.empty();
        } else {
            containerEl.replaceChildren();
        }

        createSettingGroup(containerEl)
            .addSetting((setting: Setting): void => {
                setting
                    .setName("Server URL")
                    .setDesc(
                        "Nextcloud base URL or WebDAV endpoint (https://<domain>)."
                    )
                    .addText((text) => {
                        text.inputEl.autocapitalize = "none";
                        text.inputEl.spellcheck = false;
                        return text
                            .setPlaceholder("https://cloud.example.com")
                            .setValue(this.pluginInstance.settings.url)
                            .onChange(async (value: string): Promise<void> => {
                                this.pluginInstance.settings.url =
                                    sanitizeServerUrl(value);
                                await this.pluginInstance.saveSettings();
                            });
                    });
            })
            .addSetting((setting: Setting): void => {
                setting
                    .setName("Username")
                    .setDesc("Nextcloud account username.")
                    .addText((text) => {
                        text.inputEl.autocapitalize = "none";
                        text.inputEl.spellcheck = false;
                        return text
                            .setPlaceholder("Enter username")
                            .setValue(this.pluginInstance.settings.username)
                            .onChange(async (value: string): Promise<void> => {
                                this.pluginInstance.settings.username =
                                    sanitizeUsername(value);
                                await this.pluginInstance.saveSettings();
                            });
                    });
            })
            .addSetting((setting: Setting): void => {
                setting
                    .setName("App password")
                    .setDesc(
                        "Select or create a secret for your Nextcloud app password."
                    );
                if (
                    requireApiVersion("1.11.4") &&
                    typeof SecretComponent === "function" &&
                    typeof setting.addComponent === "function"
                ) {
                    setting.addComponent((el: HTMLElement): SecretComponent =>
                        new SecretComponent(this.app, el)
                            .setValue(
                                this.pluginInstance.settings.appPasswordSecret
                            )
                            .onChange(
                                async (value: string | null): Promise<void> => {
                                    this.pluginInstance.settings.appPasswordSecret =
                                        sanitizeSecretId(value);
                                    await this.pluginInstance.saveSettings();
                                }
                            )
                    );
                } else {
                    setting.setDesc(
                        "Obsidian 1.11.4 or newer is required for secure password storage."
                    );
                }
            })
            .addSetting((setting: Setting): void => {
                setting
                    .setName("Remote base directory")
                    .setDesc(
                        "Target remote folder path inside the Nextcloud user files root."
                    )
                    .addText((text) => {
                        text.inputEl.autocapitalize = "none";
                        text.inputEl.spellcheck = false;
                        return text
                            .setPlaceholder(this.app.vault.getName())
                            .setValue(
                                this.pluginInstance.settings.remoteBaseDir
                            )
                            .onChange(async (value: string): Promise<void> => {
                                this.pluginInstance.settings.remoteBaseDir =
                                    sanitizeRemoteBaseDir(
                                        value,
                                        this.app.vault.configDir
                                    );
                                await this.pluginInstance.saveSettings();
                            });
                    });
            });

        createSettingGroup(containerEl)
            .addSetting((setting: Setting): void => {
                setting
                    .setName("Sync interval")
                    .setDesc(
                        "Automatic synchronization interval in minutes (0 to disable)."
                    )
                    .addText((text) => {
                        text.inputEl.type = "number";
                        text.inputEl.min = "0";
                        text.inputEl.max = String(MAX_SYNC_INTERVAL_MINUTES);
                        return text
                            .setPlaceholder("0")
                            .setValue(
                                String(
                                    this.pluginInstance.settings.syncInterval
                                )
                            )
                            .onChange(async (value: string): Promise<void> => {
                                const trimmed: string = value.trim();
                                const parsed: number =
                                    trimmed === ""
                                        ? Number.NaN
                                        : Number(trimmed);
                                this.pluginInstance.settings.syncInterval =
                                    !Number.isFinite(parsed) || parsed < 0
                                        ? 0
                                        : Math.min(
                                              MAX_SYNC_INTERVAL_MINUTES,
                                              Math.floor(parsed)
                                          );
                                await this.pluginInstance.saveSettings();
                            });
                    });
            })
            .addSetting((setting: Setting): void => {
                setting
                    .setName("Conflict strategy")
                    .setDesc(
                        "Resolution mode for concurrent edits (keep_both or newest_wins)."
                    )
                    .addDropdown((dropdown) =>
                        dropdown
                            .addOption(
                                "keep_both",
                                "Keep both (create conflict copy)"
                            )
                            .addOption("newest_wins", "Newest wins")
                            .setValue(
                                this.pluginInstance.settings.conflictStrategy
                            )
                            .onChange(async (value: string): Promise<void> => {
                                const strategy: ConflictStrategy =
                                    value === "newest_wins"
                                        ? "newest_wins"
                                        : "keep_both";
                                this.pluginInstance.settings.conflictStrategy =
                                    strategy;
                                await this.pluginInstance.saveSettings();
                            })
                    );
            });

        createSettingGroup(containerEl).addSetting(
            (setting: Setting): void => {
                setting
                    .setName("Test connection")
                    .setDesc(
                        "Verify Nextcloud WebDAV credentials and remote directory access."
                    )
                    .addButton((button) =>
                        button
                            .setButtonText("Test connection")
                            .setCta()
                            .onClick(async (): Promise<void> => {
                                button.setDisabled(true);
                                button.setButtonText("Testing...");
                                try {
                                    await this.pluginInstance.testConnection();
                                } finally {
                                    button.setDisabled(false);
                                    button.setButtonText("Test connection");
                                }
                            })
                    );
            }
        );

        const advancedGroup: SettingGroupBuilder =
            createSettingGroup(containerEl);
        advancedGroup
            .setHeading("Advanced sync")
            .addSetting((setting: Setting): void => {
                setting
                    .setName("Chunking threshold")
                    .setDesc(
                        "Minimum file size in MB before switching to Nextcloud chunked uploads."
                    )
                    .addText((text) => {
                        text.inputEl.type = "number";
                        text.inputEl.min = "1";
                        text.inputEl.max = String(MAX_CHUNKING_THRESHOLD_MB);
                        return text
                            .setPlaceholder("90")
                            .setValue(
                                String(
                                    this.pluginInstance.settings
                                        .chunkingThresholdMB
                                )
                            )
                            .onChange(async (value: string): Promise<void> => {
                                const trimmed: string = value.trim();
                                const parsed: number =
                                    trimmed === ""
                                        ? Number.NaN
                                        : Number(trimmed);
                                this.pluginInstance.settings.chunkingThresholdMB =
                                    !Number.isFinite(parsed) || parsed < 1
                                        ? DEFAULT_SETTINGS.chunkingThresholdMB
                                        : Math.min(
                                              MAX_CHUNKING_THRESHOLD_MB,
                                              Math.floor(parsed)
                                          );
                                await this.pluginInstance.saveSettings();
                            });
                    });
            })
            .addSetting((setting: Setting): void => {
                setting
                    .setName("Chunk size")
                    .setDesc(
                        "Target chunk size in MB for chunked uploads and parallel range downloads."
                    )
                    .addText((text) => {
                        text.inputEl.type = "number";
                        text.inputEl.min = "1";
                        text.inputEl.max = String(MAX_CHUNK_SIZE_MB);
                        return text
                            .setPlaceholder("10")
                            .setValue(
                                String(this.pluginInstance.settings.chunkSizeMB)
                            )
                            .onChange(async (value: string): Promise<void> => {
                                const trimmed: string = value.trim();
                                const parsed: number =
                                    trimmed === ""
                                        ? Number.NaN
                                        : Number(trimmed);
                                this.pluginInstance.settings.chunkSizeMB =
                                    !Number.isFinite(parsed) || parsed < 1
                                        ? DEFAULT_SETTINGS.chunkSizeMB
                                        : Math.min(
                                              MAX_CHUNK_SIZE_MB,
                                              Math.floor(parsed)
                                          );
                                await this.pluginInstance.saveSettings();
                            });
                    });
            });
    }
}
