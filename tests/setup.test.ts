import { describe, expect, it } from "vitest";
import packageJson from "../package.json";

describe("Test environment setup", () => {
    it("enforces zero external runtime dependencies in package.json", () => {
        const record: Record<string, unknown> = packageJson;
        const devDependencyKeys: string[] = Object.keys(packageJson.devDependencies).sort();

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
});
