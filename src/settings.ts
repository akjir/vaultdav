import {
    type App,
    PluginSettingTab,
    requireApiVersion,
    SecretComponent,
    Setting,
    type SettingDefinition,
    type SettingDefinitionItem,
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
        syncLogRetentionDays: 30,
        url: "",
        username: ""
    });
export const MAX_CHUNK_SIZE_MB: number = 512;
export const MAX_CHUNKING_THRESHOLD_MB: number = 512;
export const MAX_SECRET_ID_LENGTH: number = 64;
export const MAX_SYNC_INTERVAL_MINUTES: number = 10080;
export const MAX_SYNC_LOG_RETENTION_DAYS: number = 365;
export const MIN_SYNC_LOG_RETENTION_DAYS: number = 1;

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

function parseNumericInput(value: unknown): number {
    if (typeof value === "number") {
        return value;
    }
    if (typeof value === "string") {
        const trimmed: string = value.trim();
        return trimmed === "" ? Number.NaN : Number(trimmed);
    }
    return Number.NaN;
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

export function sanitizeSyncLogRetentionDays(value: unknown): number {
    if (
        typeof value === "number" &&
        Number.isFinite(value) &&
        value >= MIN_SYNC_LOG_RETENTION_DAYS
    ) {
        return Math.min(MAX_SYNC_LOG_RETENTION_DAYS, Math.floor(value));
    }
    return DEFAULT_SETTINGS.syncLogRetentionDays;
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

    private attachAppPasswordControl(setting: Setting): void {
        if (
            requireApiVersion("1.11.4") &&
            typeof SecretComponent === "function" &&
            typeof setting.addComponent === "function"
        ) {
            setting.addComponent((el: HTMLElement): SecretComponent =>
                new SecretComponent(this.app, el)
                    .setValue(this.pluginInstance.settings.appPasswordSecret)
                    .onChange(async (value: string | null): Promise<void> => {
                        await this.setControlValue("appPasswordSecret", value);
                    })
            );
        } else {
            setting.setDesc(
                "Obsidian 1.11.4 or newer is required for secure password storage."
            );
        }
    }

    private attachTestConnectionButton(setting: Setting): void {
        setting.addButton((button) =>
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
                                await this.setControlValue("url", value);
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
                                await this.setControlValue("username", value);
                            });
                    });
            })
            .addSetting((setting: Setting): void => {
                setting
                    .setName("App password")
                    .setDesc(
                        "Select or create a secret for your Nextcloud app password."
                    );
                this.attachAppPasswordControl(setting);
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
                                await this.setControlValue(
                                    "remoteBaseDir",
                                    value
                                );
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
                                await this.setControlValue(
                                    "syncInterval",
                                    value
                                );
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
                                await this.setControlValue(
                                    "conflictStrategy",
                                    value
                                );
                            })
                    );
            });

        createSettingGroup(containerEl).addSetting(
            (setting: Setting): void => {
                setting
                    .setName("Test connection")
                    .setDesc(
                        "Verify Nextcloud WebDAV credentials and remote directory access."
                    );
                this.attachTestConnectionButton(setting);
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
                                await this.setControlValue(
                                    "chunkingThresholdMB",
                                    value
                                );
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
                                await this.setControlValue(
                                    "chunkSizeMB",
                                    value
                                );
                            });
                    });
            })
            .addSetting((setting: Setting): void => {
                setting
                    .setName("Sync log retention")
                    .setDesc("Days to retain local sync history (1 to 365).")
                    .addText((text) => {
                        text.inputEl.type = "number";
                        text.inputEl.min = String(MIN_SYNC_LOG_RETENTION_DAYS);
                        text.inputEl.max = String(MAX_SYNC_LOG_RETENTION_DAYS);
                        return text
                            .setPlaceholder("30")
                            .setValue(
                                String(
                                    this.pluginInstance.settings
                                        .syncLogRetentionDays
                                )
                            )
                            .onChange(async (value: string): Promise<void> => {
                                await this.setControlValue(
                                    "syncLogRetentionDays",
                                    value
                                );
                            });
                    });
            });
    }

    public getControlValue(key: string): unknown {
        switch (key) {
            case "appPasswordSecret":
                return this.pluginInstance.settings.appPasswordSecret;
            case "chunkSizeMB":
                return this.pluginInstance.settings.chunkSizeMB;
            case "chunkingThresholdMB":
                return this.pluginInstance.settings.chunkingThresholdMB;
            case "conflictStrategy":
                return this.pluginInstance.settings.conflictStrategy;
            case "remoteBaseDir":
                return this.pluginInstance.settings.remoteBaseDir;
            case "syncInterval":
                return this.pluginInstance.settings.syncInterval;
            case "syncLogRetentionDays":
                return this.pluginInstance.settings.syncLogRetentionDays;
            case "url":
                return this.pluginInstance.settings.url;
            case "username":
                return this.pluginInstance.settings.username;
            default:
                return undefined;
        }
    }

    public getSettingDefinitions(): SettingDefinitionItem[] {
        const appPasswordDefinition: SettingDefinition<keyof VaultDavSettings> =
            requireApiVersion("1.13.2")
                ? {
                      control: {
                          defaultValue: DEFAULT_SETTINGS.appPasswordSecret,
                          key: "appPasswordSecret",
                          type: "secret"
                      },
                      desc: "Select or create a secret for your Nextcloud app password.",
                      name: "App password"
                  }
                : {
                      desc: "Select or create a secret for your Nextcloud app password.",
                      name: "App password",
                      render: (setting: Setting): void => {
                          this.attachAppPasswordControl(setting);
                      }
                  };

        const definitions: SettingDefinitionItem<keyof VaultDavSettings>[] = [
            {
                items: [
                    {
                        control: {
                            defaultValue: DEFAULT_SETTINGS.url,
                            key: "url",
                            placeholder: "https://cloud.example.com",
                            type: "text"
                        },
                        desc: "Nextcloud base URL or WebDAV endpoint (https://<domain>).",
                        name: "Server URL"
                    },
                    {
                        control: {
                            defaultValue: DEFAULT_SETTINGS.username,
                            key: "username",
                            placeholder: "Enter username",
                            type: "text"
                        },
                        desc: "Nextcloud account username.",
                        name: "Username"
                    },
                    appPasswordDefinition,
                    {
                        control: {
                            defaultValue: DEFAULT_SETTINGS.remoteBaseDir,
                            key: "remoteBaseDir",
                            placeholder: this.app.vault.getName(),
                            type: "text"
                        },
                        desc: "Target remote folder path inside the Nextcloud user files root.",
                        name: "Remote base directory"
                    }
                ],
                type: "group"
            },
            {
                items: [
                    {
                        control: {
                            defaultValue: DEFAULT_SETTINGS.syncInterval,
                            key: "syncInterval",
                            max: MAX_SYNC_INTERVAL_MINUTES,
                            min: 0,
                            placeholder: "0",
                            step: 1,
                            type: "number"
                        },
                        desc: "Automatic synchronization interval in minutes (0 to disable).",
                        name: "Sync interval"
                    },
                    {
                        control: {
                            defaultValue: DEFAULT_SETTINGS.conflictStrategy,
                            key: "conflictStrategy",
                            options: {
                                keep_both: "Keep both (create conflict copy)",
                                newest_wins: "Newest wins"
                            },
                            type: "dropdown"
                        },
                        desc: "Resolution mode for concurrent edits (keep_both or newest_wins).",
                        name: "Conflict strategy"
                    }
                ],
                type: "group"
            },
            {
                items: [
                    {
                        desc: "Verify Nextcloud WebDAV credentials and remote directory access.",
                        name: "Test connection",
                        render: (setting: Setting): void => {
                            this.attachTestConnectionButton(setting);
                        }
                    }
                ],
                type: "group"
            },
            {
                heading: "Advanced sync",
                items: [
                    {
                        control: {
                            defaultValue: DEFAULT_SETTINGS.chunkingThresholdMB,
                            key: "chunkingThresholdMB",
                            max: MAX_CHUNKING_THRESHOLD_MB,
                            min: 1,
                            placeholder: "90",
                            step: 1,
                            type: "number"
                        },
                        desc: "Minimum file size in MB before switching to Nextcloud chunked uploads.",
                        name: "Chunking threshold"
                    },
                    {
                        control: {
                            defaultValue: DEFAULT_SETTINGS.chunkSizeMB,
                            key: "chunkSizeMB",
                            max: MAX_CHUNK_SIZE_MB,
                            min: 1,
                            placeholder: "10",
                            step: 1,
                            type: "number"
                        },
                        desc: "Target chunk size in MB for chunked uploads and parallel range downloads.",
                        name: "Chunk size"
                    },
                    {
                        control: {
                            defaultValue: DEFAULT_SETTINGS.syncLogRetentionDays,
                            key: "syncLogRetentionDays",
                            max: MAX_SYNC_LOG_RETENTION_DAYS,
                            min: MIN_SYNC_LOG_RETENTION_DAYS,
                            placeholder: "30",
                            step: 1,
                            type: "number"
                        },
                        desc: "Days to retain local sync history (1 to 365).",
                        name: "Sync log retention"
                    }
                ],
                type: "group"
            }
        ];

        return definitions;
    }

    public async setControlValue(key: string, value: unknown): Promise<void> {
        switch (key) {
            case "appPasswordSecret":
                this.pluginInstance.settings.appPasswordSecret =
                    sanitizeSecretId(value);
                break;
            case "chunkSizeMB":
                this.pluginInstance.settings.chunkSizeMB = sanitizeChunkSizeMB(
                    parseNumericInput(value)
                );
                break;
            case "chunkingThresholdMB":
                this.pluginInstance.settings.chunkingThresholdMB =
                    sanitizeChunkingThresholdMB(parseNumericInput(value));
                break;
            case "conflictStrategy": {
                const strategy: ConflictStrategy =
                    value === "newest_wins" ? "newest_wins" : "keep_both";
                this.pluginInstance.settings.conflictStrategy = strategy;
                break;
            }
            case "remoteBaseDir":
                this.pluginInstance.settings.remoteBaseDir =
                    sanitizeRemoteBaseDir(
                        typeof value === "string" ? value : "",
                        this.app.vault.configDir
                    );
                break;
            case "syncInterval":
                this.pluginInstance.settings.syncInterval =
                    sanitizeSyncInterval(parseNumericInput(value));
                break;
            case "syncLogRetentionDays":
                this.pluginInstance.settings.syncLogRetentionDays =
                    sanitizeSyncLogRetentionDays(parseNumericInput(value));
                break;
            case "url":
                this.pluginInstance.settings.url = sanitizeServerUrl(
                    typeof value === "string" ? value : ""
                );
                break;
            case "username":
                this.pluginInstance.settings.username = sanitizeUsername(
                    typeof value === "string" ? value : ""
                );
                break;
            default:
                return;
        }
        await this.pluginInstance.saveSettings();
    }
}
