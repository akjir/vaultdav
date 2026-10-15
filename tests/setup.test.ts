import type { App, PluginManifest } from "obsidian";
import { describe, expect, it } from "vitest";
import manifestJson from "../manifest.json";
import packageJson from "../package.json";
import VaultDavPlugin from "../src/main";
import { VaultDavSettingTab } from "../src/settings";

describe("Test environment setup and plugin metadata", () => {
    it("enforces zero external runtime dependencies and vaultdav plugin ID", () => {
        const record: Record<string, unknown> = packageJson;
        const devDependencyKeys: string[] = Object.keys(packageJson.devDependencies).sort();

        expect(packageJson.name).toBe("vaultdav");
        expect(manifestJson.id).toBe("vaultdav");
        expect("dependencies" in record).toBe(false);
        expect("optionalDependencies" in record).toBe(false);
        expect("peerDependencies" in record).toBe(false);
        expect(devDependencyKeys).toEqual([
            "esbuild",
            "happy-dom",
            "obsidian",
            "typescript",
            "vitest"
        ]);
    });

    it("provides a working DOMParser for WebDAV XML responses", () => {
        const xml: string = `<d:multistatus xmlns:d="DAV:"><d:response><d:href>/remote.php/dav/files/user/</d:href></d:response></d:multistatus>`;
        const parser: DOMParser = new DOMParser();
        const doc: Document = parser.parseFromString(xml, "application/xml");
        const hrefElement: Element | undefined = doc.getElementsByTagName("d:href")[0];

        expect(hrefElement).toBeDefined();
        expect(hrefElement?.textContent).toBe("/remote.php/dav/files/user/");
    });

    it("initializes VaultDavPlugin lifecycle and renders VaultDavSettingTab", async () => {
        const mockApp: Partial<App> = {
            vault: {
                adapter: {
                    exists: async (): Promise<boolean> => false,
                    mkdir: async (): Promise<void> => undefined,
                    read: async (): Promise<string> => "{}",
                    write: async (): Promise<void> => undefined
                },
                getName: (): string => "MyVault"
            } as unknown as App["vault"]
        };
        const mockManifest: PluginManifest = {
            author: "Test",
            description: "Test",
            id: "vaultdav",
            isDesktopOnly: false,
            minAppVersion: "1.5.0",
            name: "VaultDAV",
            version: "0.1.0"
        };

        const plugin: VaultDavPlugin = new VaultDavPlugin(
            mockApp as App,
            mockManifest
        );
        await plugin.onload();

        expect(plugin.isConfigured()).toBe(false);
        expect(await plugin.triggerSync()).toBeNull();

        const tab: VaultDavSettingTab = new VaultDavSettingTab(
            mockApp as App,
            plugin
        );
        tab.display();
        expect(tab.containerEl.children.length).toBe(10);

        plugin.onunload();
    });
});
