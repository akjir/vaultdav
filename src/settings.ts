import { type App, PluginSettingTab, Setting } from "obsidian";
import type VaultDavPlugin from "./main";
import type { ConflictStrategy, VaultDavSettings } from "./types";

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
        containerEl.innerHTML = "";

        new Setting(containerEl)
            .setName("Server URL")
            .setDesc("Nextcloud base URL or WebDAV endpoint (https://<domain>).")
            .addText((text) =>
                text
                    .setPlaceholder("https://cloud.example.com")
                    .setValue(this.pluginInstance.settings.url)
                    .onChange(async (value: string): Promise<void> => {
                        this.pluginInstance.settings.url = value.trim();
                        await this.pluginInstance.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("Username")
            .setDesc("Nextcloud account username.")
            .addText((text) =>
                text
                    .setPlaceholder("username")
                    .setValue(this.pluginInstance.settings.username)
                    .onChange(async (value: string): Promise<void> => {
                        this.pluginInstance.settings.username = value.trim();
                        await this.pluginInstance.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("App Password")
            .setDesc("Nextcloud App Password for HTTP Basic authentication.")
            .addText((text) => {
                text.inputEl.type = "password";
                return text
                    .setPlaceholder("xxxxx-xxxxx-xxxxx-xxxxx-xxxxx")
                    .setValue(this.pluginInstance.settings.appPassword)
                    .onChange(async (value: string): Promise<void> => {
                        this.pluginInstance.settings.appPassword = value.trim();
                        await this.pluginInstance.saveSettings();
                    });
            });

        new Setting(containerEl)
            .setName("Remote Base Directory")
            .setDesc("Target remote folder path inside the Nextcloud user files root.")
            .addText((text) =>
                text
                    .setPlaceholder(this.app.vault.getName())
                    .setValue(this.pluginInstance.settings.remoteBaseDir)
                    .onChange(async (value: string): Promise<void> => {
                        this.pluginInstance.settings.remoteBaseDir = value.trim();
                        await this.pluginInstance.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("Sync Interval")
            .setDesc("Automatic synchronization interval in minutes (0 to disable).")
            .addText((text) =>
                text
                    .setPlaceholder("0")
                    .setValue(String(this.pluginInstance.settings.syncInterval))
                    .onChange(async (value: string): Promise<void> => {
                        const parsed: number = Number.parseInt(value.trim(), 10);
                        this.pluginInstance.settings.syncInterval =
                            Number.isNaN(parsed) || parsed < 0 ? 0 : parsed;
                        await this.pluginInstance.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("Conflict Strategy")
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
            .setName("Test Connection")
            .setDesc("Verify Nextcloud WebDAV credentials and remote directory access.")
            .addButton((button) =>
                button
                    .setButtonText("Test connection")
                    .setCta()
                    .onClick(async (): Promise<void> => {
                        await this.pluginInstance.testConnection();
                    })
            );
    }
}
