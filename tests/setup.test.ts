import type { App, PluginManifest } from "obsidian";
import { describe, expect, it } from "vitest";
import manifestJson from "../manifest.json";
import packageLockJson from "../package-lock.json";
import packageJson from "../package.json";
import VaultDavPlugin from "../src/main";
import { VaultDavSettingTab } from "../src/settings";
import versionsJson from "../versions.json";

const SEMVER_REGEX: RegExp = /^\d+\.\d+\.\d+$/;

describe("Test environment setup and plugin metadata", () => {
    it("enforces zero external runtime dependencies, vaultdav plugin ID, and synchronized version metadata", () => {
        const record: Record<string, unknown> = packageJson;
        const versionsRecord: Record<string, string> = versionsJson;
        const devDependencyKeys: string[] = Object.keys(packageJson.devDependencies).sort();

        expect(packageJson.name).toBe("vaultdav");
        expect(manifestJson.id).toBe("vaultdav");
        expect(manifestJson.isDesktopOnly).toBe(false);
        expect(SEMVER_REGEX.test(packageJson.version)).toBe(true);
        expect(manifestJson.version).toBe(packageJson.version);
        expect(packageLockJson.version).toBe(packageJson.version);
        expect(packageLockJson.packages[""].version).toBe(packageJson.version);
        expect(versionsRecord[manifestJson.version]).toBe(manifestJson.minAppVersion);
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
        expect(tab.containerEl.children.length).toBe(4);

        plugin.onunload();
    });
});
