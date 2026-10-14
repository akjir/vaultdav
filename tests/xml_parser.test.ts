import { describe, expect, it } from "vitest";
import type { RemoteItem } from "../src/types";
import {
    buildPropfindBody,
    parseMultiStatus,
    parseSingleStat
} from "../src/webdav/xml_parser";

describe("webdav xml_parser", () => {
    it("builds a standard WebDAV PROPFIND XML body", () => {
        const body: string = buildPropfindBody();
        expect(body).toContain("<d:propfind");
        expect(body).toContain("<d:getlastmodified/>");
        expect(body).toContain("<d:getcontentlength/>");
        expect(body).toContain("<d:getetag/>");
        expect(body).toContain("<d:resourcetype/>");
    });

    it("parses Nextcloud 207 Multi-Status XML and filters root self-entry", () => {
        const xml: string = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns">
    <d:response>
        <d:href>/remote.php/dav/files/alice/Obsidian%20Vault/</d:href>
        <d:propstat>
            <d:prop>
                <d:getlastmodified>Wed, 14 Oct 2026 18:00:00 GMT</d:getlastmodified>
                <d:getetag>"root-etag"</d:getetag>
                <d:resourcetype><d:collection/></d:resourcetype>
            </d:prop>
            <d:status>HTTP/1.1 200 OK</d:status>
        </d:propstat>
        <d:propstat>
            <d:prop>
                <d:getcontentlength/>
            </d:prop>
            <d:status>HTTP/1.1 404 Not Found</d:status>
        </d:propstat>
    </d:response>
    <d:response>
        <d:href>/remote.php/dav/files/alice/Obsidian%20Vault/Notes/</d:href>
        <d:propstat>
            <d:prop>
                <d:getlastmodified>Wed, 14 Oct 2026 18:05:00 GMT</d:getlastmodified>
                <d:getetag>W/"dir-etag-1"</d:getetag>
                <d:resourcetype><d:collection/></d:resourcetype>
            </d:prop>
            <d:status>HTTP/1.1 200 OK</d:status>
        </d:propstat>
    </d:response>
    <d:response>
        <d:href>/remote.php/dav/files/alice/Obsidian%20Vault/C%23%20Note%3F.md</d:href>
        <d:propstat>
            <d:prop>
                <d:getlastmodified>Wed, 14 Oct 2026 18:10:00 GMT</d:getlastmodified>
                <d:getcontentlength>512</d:getcontentlength>
                <d:getetag>"file-etag-abc"</d:getetag>
                <d:resourcetype/>
            </d:prop>
            <d:status>HTTP/1.1 200 OK</d:status>
        </d:propstat>
    </d:response>
</d:multistatus>`;

        const items: RemoteItem[] = parseMultiStatus(xml, "alice", "Obsidian Vault", "");
        expect(items).toHaveLength(2);

        const folderItem: RemoteItem | undefined = items.find(
            (item: RemoteItem) => item.path === "Notes"
        );
        expect(folderItem).toEqual({
            etag: "dir-etag-1",
            href: "/remote.php/dav/files/alice/Obsidian%20Vault/Notes/",
            isDirectory: true,
            mtime: Date.parse("Wed, 14 Oct 2026 18:05:00 GMT"),
            path: "Notes",
            size: 0
        });

        const fileItem: RemoteItem | undefined = items.find(
            (item: RemoteItem) => item.path === "C# Note?.md"
        );
        expect(fileItem).toEqual({
            etag: "file-etag-abc",
            href: "/remote.php/dav/files/alice/Obsidian%20Vault/C%23%20Note%3F.md",
            isDirectory: false,
            mtime: Date.parse("Wed, 14 Oct 2026 18:10:00 GMT"),
            path: "C# Note?.md",
            size: 512
        });
    });

    it("supports uppercase D: and default DAV: namespaces and filters queried subdirectory self-entry", () => {
        const xml: string = `<?xml version="1.0"?>
<D:multistatus xmlns:D="DAV:">
    <D:response>
        <D:href>/remote.php/dav/files/alice/Vault/Notes/</D:href>
        <D:propstat>
            <D:prop>
                <D:resourcetype><D:collection/></D:resourcetype>
            </D:prop>
            <D:status>HTTP/1.1 200 OK</D:status>
        </D:propstat>
    </D:response>
    <D:response>
        <D:href>/remote.php/dav/files/alice/Vault/Notes/Idea.md</D:href>
        <D:propstat>
            <D:prop>
                <D:getlastmodified>Wed, 14 Oct 2026 19:00:00 GMT</D:getlastmodified>
                <D:getcontentlength>42</D:getcontentlength>
                <D:getetag>"idea-42"</D:getetag>
                <D:resourcetype/>
            </D:prop>
            <D:status>HTTP/1.1 200 OK</D:status>
        </D:propstat>
    </D:response>
</D:multistatus>`;

        const items: RemoteItem[] = parseMultiStatus(xml, "alice", "Vault", "Notes");
        expect(items).toHaveLength(1);
        expect(items[0]?.path).toBe("Notes/Idea.md");
        expect(items[0]?.size).toBe(42);
    });

    it("parses single-item Depth: 0 stat responses via parseSingleStat", () => {
        const xml: string = `<?xml version="1.0"?>
<multistatus xmlns="DAV:">
    <response>
        <href>/remote.php/dav/files/alice/Vault/Notes/Idea.md</href>
        <propstat>
            <prop>
                <getlastmodified>Wed, 14 Oct 2026 19:00:00 GMT</getlastmodified>
                <getcontentlength>128</getcontentlength>
                <getetag>"etag-128"</getetag>
                <resourcetype/>
            </prop>
            <status>HTTP/1.1 200 OK</status>
        </propstat>
    </response>
</multistatus>`;

        const stat: RemoteItem | null = parseSingleStat(
            xml,
            "alice",
            "Vault",
            "Notes/Idea.md"
        );
        expect(stat).not.toBeNull();
        expect(stat?.etag).toBe("etag-128");
        expect(stat?.size).toBe(128);
    });

    it("throws on malformed XML responses", () => {
        const invalidXml: string = "<d:multistatus><d:response><unclosed></d:multistatus>";
        expect(() => parseMultiStatus(invalidXml, "alice", "Vault")).toThrow(
            /Invalid WebDAV XML/
        );
    });
});
