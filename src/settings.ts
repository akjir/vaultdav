import {
    type App,
    PluginSettingTab,
    type Setting,
    type SettingDefinitionItem
} from "obsidian";
import type VaultDavPlugin from "./main";
import type { ConflictStrategy, VaultDavSettings } from "./types";
import { util } from "./utilities";

export interface WebDavUrlPreview {
    isError: boolean;
    isReady: boolean;
    text: string;
}

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

const BARE_URL_USERINFO_REGEX: RegExp = /^[^/\s?#]+@/;
const HTTP_URL_USERINFO_REGEX: RegExp = /^(https?:\/\/)[^/\s?#]+@/i;
const SECRET_ID_REGEX: RegExp = /^[a-z0-9-]+$/;
const URL_USERINFO_REGEX: RegExp = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/\s?#]+@/i;

function applyMobileLowercaseInputAttributes(
    inputEl: HTMLInputElement,
    isUrl: boolean = false
): void {
    inputEl.autocapitalize = "none";
    inputEl.setAttribute("autocapitalize", "none");
    inputEl.setAttribute("autocorrect", "off");
    inputEl.autocomplete = "off";
    inputEl.spellcheck = false;
    if (isUrl) {
        inputEl.inputMode = "url";
        inputEl.setAttribute("inputmode", "url");
    }
}

export function hasEmbeddedUrlCredentials(value: string): boolean {
    const trimmed: string = value.trim();
    return (
        URL_USERINFO_REGEX.test(trimmed) ||
        BARE_URL_USERINFO_REGEX.test(trimmed)
    );
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

export function resolveRemoteBaseDir(
    remoteBaseDir: string,
    vaultName: string,
    configDir: string
): string {
    const normalizedRemoteBaseDir: string = sanitizeRemoteBaseDir(
        remoteBaseDir,
        configDir
    );
    if (normalizedRemoteBaseDir !== "") {
        return normalizedRemoteBaseDir;
    }
    const normalizedVaultName: string = sanitizeRemoteBaseDir(
        vaultName,
        configDir
    );
    return normalizedVaultName !== "" ? normalizedVaultName : "VaultDAV";
}

export function resolveWebDavUrlPreview(
    rawUrl: string,
    rawUsername: string,
    rawRemoteBaseDir: string,
    vaultName: string,
    configDir: string
): WebDavUrlPreview {
    const trimmedUrl: string = rawUrl.trim();
    if (trimmedUrl === "") {
        return {
            isError: false,
            isReady: false,
            text: "Enter server URL and username to preview the WebDAV URL."
        };
    }
    if (util.hasControlChars(rawUrl)) {
        return {
            isError: true,
            isReady: false,
            text: "Enter a valid server URL (http:// or https://)."
        };
    }
    const strippedUrl: string = trimmedUrl.replace(
        HTTP_URL_USERINFO_REGEX,
        "$1"
    );
    let normalizedUrl: string = "";
    try {
        normalizedUrl = util.normalizeServerUrl(strippedUrl);
    } catch (err: unknown) {
        const message: string = err instanceof Error ? err.message : "";
        if (message.includes("HTTP or HTTPS")) {
            return {
                isError: true,
                isReady: false,
                text: "Server URL must use http:// or https://."
            };
        }
        return {
            isError: true,
            isReady: false,
            text: "Enter a valid server URL (http:// or https://)."
        };
    }
    try {
        const parsedUrl: URL = new URL(normalizedUrl);
        if (parsedUrl.search !== "" || parsedUrl.hash !== "") {
            return {
                isError: true,
                isReady: false,
                text: "Server URL must not contain query or hash parameters."
            };
        }
    } catch {
        return {
            isError: true,
            isReady: false,
            text: "Enter a valid server URL (http:// or https://)."
        };
    }

    const trimmedUsername: string = rawUsername.trim();
    if (trimmedUsername === "") {
        return {
            isError: false,
            isReady: false,
            text: "Enter username to preview the WebDAV URL."
        };
    }
    const safeUsername: string = sanitizeUsername(rawUsername);
    if (safeUsername === "") {
        return {
            isError: true,
            isReady: false,
            text: "Username must not contain colons, slashes, or control characters."
        };
    }

    const trimmedRemoteBaseDir: string = rawRemoteBaseDir.trim();
    const sanitizedRemoteBaseDir: string = sanitizeRemoteBaseDir(
        rawRemoteBaseDir,
        configDir
    );
    if (
        trimmedRemoteBaseDir !== "" &&
        trimmedRemoteBaseDir !== "/" &&
        sanitizedRemoteBaseDir === ""
    ) {
        return {
            isError: true,
            isReady: false,
            text: "Remote base directory cannot use excluded or invalid paths."
        };
    }

    const effectiveBaseDir: string = resolveRemoteBaseDir(
        sanitizedRemoteBaseDir,
        vaultName,
        configDir
    );
    try {
        const baseUrl: string = util.buildNextcloudWebDavBaseUrl(
            normalizedUrl,
            safeUsername,
            effectiveBaseDir
        );
        return {
            isError: false,
            isReady: true,
            text: baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`
        };
    } catch (err: unknown) {
        const message: string = err instanceof Error ? err.message : "";
        if (message.toLowerCase().includes("username")) {
            return {
                isError: true,
                isReady: false,
                text: "Enter a valid Nextcloud username."
            };
        }
        return {
            isError: true,
            isReady: false,
            text: "Enter a valid server URL (http:// or https://)."
        };
    }
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
    const trimmed: string = value.trim();
    if (trimmed === "") {
        return "";
    }
    const stripped: string = trimmed.replace(HTTP_URL_USERINFO_REGEX, "$1");
    try {
        return util.normalizeServerUrl(stripped);
    } catch {
        return "";
    }
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
    private draftRemoteBaseDir: string | null = null;
    private draftUrl: string | null = null;
    private draftUsername: string | null = null;
    private readonly pluginInstance: VaultDavPlugin;
    private resolvedUrlEl: HTMLElement | null = null;

    public constructor(app: App, plugin: VaultDavPlugin) {
        super(app, plugin);
        this.pluginInstance = plugin;
    }

    private attachRemoteBaseDirControl(setting: Setting): () => void {
        this.draftRemoteBaseDir = null;
        setting.addText((text) => {
            applyMobileLowercaseInputAttributes(text.inputEl);
            return text
                .setPlaceholder(this.app.vault.getName())
                .setValue(this.pluginInstance.settings.remoteBaseDir)
                .onChange(async (value: string): Promise<void> => {
                    this.draftRemoteBaseDir = value;
                    await this.setControlValue("remoteBaseDir", value);
                });
        });
        return (): void => {
            this.draftRemoteBaseDir = null;
        };
    }

    private attachResolvedUrlPreview(setting: Setting): () => void {
        setting.settingEl.classList.add("vaultdav-settings-endpoint-row");
        const previewEl: HTMLElement = setting.descEl.createDiv({
            cls: "vaultdav-settings-endpoint-preview"
        });
        this.resolvedUrlEl = previewEl;
        this.refreshResolvedUrlPreview();
        return (): void => {
            if (this.resolvedUrlEl === previewEl) {
                this.resolvedUrlEl = null;
            }
        };
    }

    private attachServerUrlControl(setting: Setting): () => void {
        this.draftUrl = null;
        let inputEl: HTMLInputElement | null = null;
        const handleBlur = (): void => {
            if (inputEl === null) {
                return;
            }
            const rawValue: string = inputEl.value;
            if (rawValue.trim() === "") {
                this.draftUrl = null;
                this.refreshResolvedUrlPreview();
                return;
            }
            const normalized: string = sanitizeServerUrl(rawValue);
            if (normalized !== "") {
                if (inputEl.value !== normalized) {
                    inputEl.value = normalized;
                }
                this.draftUrl = null;
                this.refreshResolvedUrlPreview();
            }
        };
        setting.addText((text) => {
            inputEl = text.inputEl;
            applyMobileLowercaseInputAttributes(text.inputEl, true);
            text.inputEl.addEventListener("blur", handleBlur);
            return text
                .setPlaceholder("https://cloud.example.com")
                .setValue(this.pluginInstance.settings.url)
                .onChange(async (value: string): Promise<void> => {
                    this.draftUrl = value;
                    await this.setControlValue("url", value);
                });
        });
        return (): void => {
            if (inputEl !== null) {
                inputEl.removeEventListener("blur", handleBlur);
            }
            this.draftUrl = null;
        };
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

    private attachUsernameControl(setting: Setting): () => void {
        this.draftUsername = null;
        setting.addText((text) => {
            applyMobileLowercaseInputAttributes(text.inputEl);
            return text
                .setPlaceholder("Enter username")
                .setValue(this.pluginInstance.settings.username)
                .onChange(async (value: string): Promise<void> => {
                    this.draftUsername = value;
                    await this.setControlValue("username", value);
                });
        });
        return (): void => {
            this.draftUsername = null;
        };
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
        const definitions: SettingDefinitionItem<keyof VaultDavSettings>[] = [
            {
                items: [
                    {
                        desc: "Nextcloud host or WebDAV URL (uses https:// if omitted; only http:// and https:// allowed).",
                        name: "Server URL",
                        render: (setting: Setting): (() => void) =>
                            this.attachServerUrlControl(setting)
                    },
                    {
                        desc: "Nextcloud account username.",
                        name: "Username",
                        render: (setting: Setting): (() => void) =>
                            this.attachUsernameControl(setting)
                    },
                    {
                        control: {
                            defaultValue: DEFAULT_SETTINGS.appPasswordSecret,
                            key: "appPasswordSecret",
                            type: "secret"
                        },
                        desc: "Select or create a secret for your Nextcloud app password.",
                        name: "App password"
                    },
                    {
                        desc: "Target remote folder path inside the Nextcloud user files root.",
                        name: "Remote base directory",
                        render: (setting: Setting): (() => void) =>
                            this.attachRemoteBaseDirControl(setting)
                    },
                    {
                        desc: "Full WebDAV endpoint constructed from server URL, username, and remote base directory.",
                        name: "Resolved WebDAV URL",
                        render: (setting: Setting): (() => void) =>
                            this.attachResolvedUrlPreview(setting)
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

    public hide(): void {
        this.draftRemoteBaseDir = null;
        this.draftUrl = null;
        this.draftUsername = null;
        this.resolvedUrlEl = null;
    }

    private refreshResolvedUrlPreview(): void {
        if (this.resolvedUrlEl === null) {
            return;
        }
        const preview: WebDavUrlPreview = resolveWebDavUrlPreview(
            this.draftUrl ?? this.pluginInstance.settings.url,
            this.draftUsername ?? this.pluginInstance.settings.username,
            this.draftRemoteBaseDir ??
                this.pluginInstance.settings.remoteBaseDir,
            this.app.vault.getName(),
            this.app.vault.configDir
        );
        this.resolvedUrlEl.textContent = preview.text;
        this.resolvedUrlEl.classList.toggle("is-error", preview.isError);
        this.resolvedUrlEl.classList.toggle(
            "is-placeholder",
            !preview.isReady && !preview.isError
        );
    }

    public async setControlValue(key: string, value: unknown): Promise<void> {
        let shouldRefreshPreview: boolean = false;
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
                shouldRefreshPreview = true;
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
                shouldRefreshPreview = true;
                break;
            case "username":
                this.pluginInstance.settings.username = sanitizeUsername(
                    typeof value === "string" ? value : ""
                );
                shouldRefreshPreview = true;
                break;
            default:
                return;
        }
        if (shouldRefreshPreview) {
            this.refreshResolvedUrlPreview();
        }
        await this.pluginInstance.saveSettings();
    }
}
