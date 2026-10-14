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

    it("throws on empty, whitespace-only, malformed, or non-multistatus XML responses", () => {
        expect(() => parseMultiStatus("", "alice", "Vault")).toThrow(
            "Invalid WebDAV XML response: empty body"
        );
        expect(() => parseMultiStatus("   \n\t  ", "alice", "Vault")).toThrow(
            "Invalid WebDAV XML response: empty body"
        );
        expect(() => parseSingleStat("", "alice", "Vault", "Note.md")).toThrow(
            "Invalid WebDAV XML response: empty body"
        );

        const invalidXml: string = "<d:multistatus><d:response><unclosed></d:multistatus>";
        expect(() => parseMultiStatus(invalidXml, "alice", "Vault")).toThrow(
            /Invalid WebDAV XML/
        );
        expect(() => parseSingleStat(invalidXml, "alice", "Vault", "Note.md")).toThrow(
            /Invalid WebDAV XML/
        );

        const htmlGatewayXml: string = "<html><body>502 Bad Gateway</body></html>";
        expect(() => parseMultiStatus(htmlGatewayXml, "alice", "Vault")).toThrow(
            "Invalid WebDAV XML response: missing multistatus root element"
        );
        expect(() =>
            parseSingleStat(htmlGatewayXml, "alice", "Vault", "Note.md")
        ).toThrow("Invalid WebDAV XML response: missing multistatus root element");

        const davErrorXml: string =
            '<?xml version="1.0"?><d:error xmlns:d="DAV:"><d:need-privileges/></d:error>';
        expect(() => parseMultiStatus(davErrorXml, "alice", "Vault")).toThrow(
            "Invalid WebDAV XML response: missing multistatus root element"
        );
    });

    it("recognizes HTTP/2 200 status lines, merges multiple 200 propstat blocks, and deduplicates repeated paths", () => {
        const xml: string = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
    <d:response>
        <d:href>/remote.php/dav/files/alice/Vault/SplitProps.md</d:href>
        <d:propstat>
            <d:prop>
                <d:getlastmodified>Wed, 14 Oct 2026 20:00:00 GMT</d:getlastmodified>
                <d:resourcetype/>
            </d:prop>
            <d:status>HTTP/2 200</d:status>
        </d:propstat>
        <d:propstat>
            <d:prop>
                <d:getcontentlength>256</d:getcontentlength>
                <d:getetag>"split-etag-256"</d:getetag>
            </d:prop>
            <d:status>HTTP/1.1 200 OK</d:status>
        </d:propstat>
        <d:propstat>
            <d:prop>
                <d:getetag>"ignored-404-etag"</d:getetag>
                <d:getcontentlength>9999</d:getcontentlength>
            </d:prop>
            <d:status>HTTP/1.1 404 Not Found</d:status>
        </d:propstat>
    </d:response>
    <d:response>
        <d:href>/remote.php/dav/files/alice/Vault/SplitProps.md</d:href>
        <d:propstat>
            <d:prop>
                <d:getcontentlength>512</d:getcontentlength>
                <d:getetag>"duplicate-etag"</d:getetag>
                <d:resourcetype/>
            </d:prop>
            <d:status>HTTP/2 200</d:status>
        </d:propstat>
    </d:response>
</d:multistatus>`;

        const items: RemoteItem[] = parseMultiStatus(xml, "alice", "Vault", "");
        expect(items).toHaveLength(1);
        expect(items[0]).toEqual({
            etag: "split-etag-256",
            href: "/remote.php/dav/files/alice/Vault/SplitProps.md",
            isDirectory: false,
            mtime: Date.parse("Wed, 14 Oct 2026 20:00:00 GMT"),
            path: "SplitProps.md",
            size: 256
        });
    });

    it("ignores responses with prefix-colliding usernames or path traversal and sanitizes invalid numeric fields", () => {
        const xml: string = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
    <d:response>
        <d:href>/remote.php/dav/files/maximilian/Vault/OtherUser.md</d:href>
        <d:propstat>
            <d:prop>
                <d:getcontentlength>10</d:getcontentlength>
                <d:resourcetype/>
            </d:prop>
            <d:status>HTTP/1.1 200 OK</d:status>
        </d:propstat>
    </d:response>
    <d:response>
        <d:href>/remote.php/dav/files/max/Vault/../Traversal.md</d:href>
        <d:propstat>
            <d:prop>
                <d:getcontentlength>10</d:getcontentlength>
                <d:resourcetype/>
            </d:prop>
            <d:status>HTTP/1.1 200 OK</d:status>
        </d:propstat>
    </d:response>
    <d:response>
        <d:href>/remote.php/dav/files/max/Vault/NegativeMetrics.md</d:href>
        <d:propstat>
            <d:prop>
                <d:getlastmodified>not-a-valid-date</d:getlastmodified>
                <d:getcontentlength>-50</d:getcontentlength>
                <d:getetag>"neg-etag"</d:getetag>
                <d:resourcetype/>
            </d:prop>
            <d:status>HTTP/1.1 200 OK</d:status>
        </d:propstat>
    </d:response>
    <d:response>
        <d:href>/remote.php/dav/files/max/Vault/AlphanumericSize.md</d:href>
        <d:propstat>
            <d:prop>
                <d:getcontentlength>123abc</d:getcontentlength>
                <d:getetag>"alpha-etag"</d:getetag>
                <d:resourcetype/>
            </d:prop>
            <d:status>HTTP/1.1 200 OK</d:status>
        </d:propstat>
    </d:response>
    <d:response>
        <d:href>/remote.php/dav/files/max/Vault/EmptySize.md</d:href>
        <d:propstat>
            <d:prop>
                <d:getcontentlength>   </d:getcontentlength>
                <d:getetag>"empty-etag"</d:getetag>
                <d:resourcetype/>
            </d:prop>
            <d:status>HTTP/1.1 200 OK</d:status>
        </d:propstat>
    </d:response>
</d:multistatus>`;

        const items: RemoteItem[] = parseMultiStatus(xml, "max", "Vault", "");
        expect(items).toHaveLength(3);
        expect(items[0]?.path).toBe("NegativeMetrics.md");
        expect(items[0]?.mtime).toBe(0);
        expect(items[0]?.size).toBe(0);
        expect(items[1]?.path).toBe("AlphanumericSize.md");
        expect(items[1]?.size).toBe(0);
        expect(items[2]?.path).toBe("EmptySize.md");
        expect(items[2]?.size).toBe(0);
    });
});
