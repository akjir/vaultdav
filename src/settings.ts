import { type App, PluginSettingTab, Setting } from "obsidian";
import type VaultDavPlugin from "./main";
import type { ConflictStrategy, VaultDavSettings } from "./types";
import { util } from "./utilities";

export const DEFAULT_SETTINGS: VaultDavSettings = {
    appPassword: "",
    conflictStrategy: "keep_both",
    remoteBaseDir: "",
    syncInterval: 0,
    url: "",
    username: ""
};

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

        new Setting(containerEl)
            .setName("Server URL")
            .setDesc("Nextcloud base URL or WebDAV endpoint (https://<domain>).")
            .addText((text) => {
                text.inputEl.autocapitalize = "none";
                text.inputEl.spellcheck = false;
                return text
                    .setPlaceholder("https://cloud.example.com")
                    .setValue(this.pluginInstance.settings.url)
                    .onChange(async (value: string): Promise<void> => {
                        this.pluginInstance.settings.url = value.trim();
                        await this.pluginInstance.saveSettings();
                    });
            });

        new Setting(containerEl)
            .setName("Username")
            .setDesc("Nextcloud account username.")
            .addText((text) => {
                text.inputEl.autocapitalize = "none";
                text.inputEl.spellcheck = false;
                return text
                    .setPlaceholder("username")
                    .setValue(this.pluginInstance.settings.username)
                    .onChange(async (value: string): Promise<void> => {
                        this.pluginInstance.settings.username = value.trim();
                        await this.pluginInstance.saveSettings();
                    });
            });

        new Setting(containerEl)
            .setName("App password")
            .setDesc("Nextcloud app password for HTTP Basic authentication.")
            .addText((text) => {
                text.inputEl.type = "password";
                text.inputEl.autocapitalize = "none";
                text.inputEl.spellcheck = false;
                return text
                    .setPlaceholder("xxxxx-xxxxx-xxxxx-xxxxx-xxxxx")
                    .setValue(this.pluginInstance.settings.appPassword)
                    .onChange(async (value: string): Promise<void> => {
                        this.pluginInstance.settings.appPassword = value.trim();
                        await this.pluginInstance.saveSettings();
                    });
            });

        new Setting(containerEl)
            .setName("Remote base directory")
            .setDesc("Target remote folder path inside the Nextcloud user files root.")
            .addText((text) => {
                text.inputEl.autocapitalize = "none";
                text.inputEl.spellcheck = false;
                return text
                    .setPlaceholder(this.app.vault.getName())
                    .setValue(this.pluginInstance.settings.remoteBaseDir)
                    .onChange(async (value: string): Promise<void> => {
                        this.pluginInstance.settings.remoteBaseDir =
                            util.normalizeVaultPath(value);
                        await this.pluginInstance.saveSettings();
                    });
            });

        new Setting(containerEl)
            .setName("Sync interval")
            .setDesc("Automatic synchronization interval in minutes (0 to disable).")
            .addText((text) => {
                text.inputEl.type = "number";
                text.inputEl.min = "0";
                return text
                    .setPlaceholder("0")
                    .setValue(String(this.pluginInstance.settings.syncInterval))
                    .onChange(async (value: string): Promise<void> => {
                        const trimmed: string = value.trim();
                        const parsed: number =
                            trimmed === "" ? Number.NaN : Number(trimmed);
                        this.pluginInstance.settings.syncInterval =
                            !Number.isFinite(parsed) || parsed < 0
                                ? 0
                                : Math.floor(parsed);
                        await this.pluginInstance.saveSettings();
                    });
            });

        new Setting(containerEl)
            .setName("Conflict strategy")
            .setDesc("Resolution mode for concurrent edits (keep_both or newest_wins).")
            .addDropdown((dropdown) =>
                dropdown
                    .addOption("keep_both", "Keep both (create conflict copy)")
                    .addOption("newest_wins", "Newest wins")
                    .setValue(this.pluginInstance.settings.conflictStrategy)
                    .onChange(async (value: string): Promise<void> => {
                        const strategy: ConflictStrategy =
                            value === "newest_wins" ? "newest_wins" : "keep_both";
                        this.pluginInstance.settings.conflictStrategy = strategy;
                        await this.pluginInstance.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("Test connection")
            .setDesc("Verify Nextcloud WebDAV credentials and remote directory access.")
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
}
