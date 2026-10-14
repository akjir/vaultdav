import type {
    RequestUrlParam,
    RequestUrlResponse,
    RequestUrlResponsePromise
} from "obsidian";
import * as obsidian from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteItem, VaultDavSettings } from "../src/types";
import { WebDavClient } from "../src/webdav/client";

function createMockResponse(
    status: number,
    text: string = "",
    headers: Record<string, string> = {},
    arrayBuffer: ArrayBuffer = new ArrayBuffer(0)
): RequestUrlResponsePromise {
    const response: RequestUrlResponse = {
        arrayBuffer,
        headers,
        json: {},
        status,
        text
    };
    return Object.assign(Promise.resolve(response), {
        arrayBuffer: Promise.resolve(arrayBuffer),
        json: Promise.resolve({}),
        text: Promise.resolve(text)
    });
}

const DEFAULT_TEST_SETTINGS: VaultDavSettings = {
    appPassword: "app-password-123",
    conflictStrategy: "keep_both",
    remoteBaseDir: "Vault/SubVault",
    syncInterval: 5,
    url: "https://cloud.example.com",
    username: "alice"
};

describe("WebDavClient", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it("ensures remoteBaseDir exists by creating missing segments top-down via MKCOL", async () => {
        const calls: Array<{ method: string; url: string }> = [];
        vi.spyOn(obsidian, "requestUrl").mockImplementation(
            (req: RequestUrlParam | string): RequestUrlResponsePromise => {
                const param: RequestUrlParam =
                    typeof req === "string" ? { url: req } : req;
                const method: string = param.method ?? "GET";
                calls.push({ method, url: param.url });

                if (
                    method === "PROPFIND" &&
                    param.url.endsWith("/remote.php/dav/files/alice/Vault/")
                ) {
                    return createMockResponse(
                        207,
                        `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"/>`
                    );
                }
                if (
                    method === "PROPFIND" &&
                    param.url.endsWith("/remote.php/dav/files/alice/Vault/SubVault/")
                ) {
                    return createMockResponse(404);
                }
                if (
                    method === "MKCOL" &&
                    param.url.endsWith("/remote.php/dav/files/alice/Vault/SubVault/")
                ) {
                    return createMockResponse(201);
                }
                return createMockResponse(500);
            }
        );

        const client: WebDavClient = new WebDavClient(DEFAULT_TEST_SETTINGS, 1);
        await client.ensureRemoteBaseDir();

        expect(calls).toEqual([
            {
                method: "PROPFIND",
                url: "https://cloud.example.com/remote.php/dav/files/alice/Vault/"
            },
            {
                method: "PROPFIND",
                url: "https://cloud.example.com/remote.php/dav/files/alice/Vault/SubVault/"
            },
            {
                method: "MKCOL",
                url: "https://cloud.example.com/remote.php/dav/files/alice/Vault/SubVault/"
            }
        ]);
    });

    it("performs BFS walkRemote with Depth: 1 and skips excluded directories", async () => {
        const rootXml: string = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
    <d:response>
        <d:href>/remote.php/dav/files/alice/Vault/SubVault/</d:href>
        <d:propstat>
            <d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop>
            <d:status>HTTP/1.1 200 OK</d:status>
        </d:propstat>
    </d:response>
    <d:response>
        <d:href>/remote.php/dav/files/alice/Vault/SubVault/Notes/</d:href>
        <d:propstat>
            <d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop>
            <d:status>HTTP/1.1 200 OK</d:status>
        </d:propstat>
    </d:response>
    <d:response>
        <d:href>/remote.php/dav/files/alice/Vault/SubVault/.git/</d:href>
        <d:propstat>
            <d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop>
            <d:status>HTTP/1.1 200 OK</d:status>
        </d:propstat>
    </d:response>
</d:multistatus>`;

        const notesXml: string = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
    <d:response>
        <d:href>/remote.php/dav/files/alice/Vault/SubVault/Notes/</d:href>
        <d:propstat>
            <d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop>
            <d:status>HTTP/1.1 200 OK</d:status>
        </d:propstat>
    </d:response>
    <d:response>
        <d:href>/remote.php/dav/files/alice/Vault/SubVault/Notes/Daily.md</d:href>
        <d:propstat>
            <d:prop>
                <d:getlastmodified>Wed, 14 Oct 2026 18:00:00 GMT</d:getlastmodified>
                <d:getcontentlength>64</d:getcontentlength>
                <d:getetag>"daily-64"</d:getetag>
                <d:resourcetype/>
            </d:prop>
            <d:status>HTTP/1.1 200 OK</d:status>
        </d:propstat>
    </d:response>
</d:multistatus>`;

        const requestedUrls: string[] = [];
        vi.spyOn(obsidian, "requestUrl").mockImplementation(
            (req: RequestUrlParam | string): RequestUrlResponsePromise => {
                const param: RequestUrlParam =
                    typeof req === "string" ? { url: req } : req;
                requestedUrls.push(param.url);
                if (param.url.endsWith("/SubVault/")) {
                    return createMockResponse(207, rootXml);
                }
                if (param.url.endsWith("/SubVault/Notes/")) {
                    return createMockResponse(207, notesXml);
                }
                return createMockResponse(404);
            }
        );

        const client: WebDavClient = new WebDavClient(DEFAULT_TEST_SETTINGS, 1);
        const items: RemoteItem[] = await client.walkRemote();

        expect(items.map((i: RemoteItem) => i.path)).toEqual(["Notes", "Notes/Daily.md"]);
        expect(requestedUrls.some((u: string) => u.includes(".git"))).toBe(false);
    });

    it("uploads binary files with X-OC-Mtime and extracts ETag from PUT response header", async () => {
        const capturedParams: RequestUrlParam[] = [];
        vi.spyOn(obsidian, "requestUrl").mockImplementation(
            (req: RequestUrlParam | string): RequestUrlResponsePromise => {
                capturedParams.push(typeof req === "string" ? { url: req } : req);
                return createMockResponse(201, "", { ETag: '"put-etag-999"' });
            }
        );

        const client: WebDavClient = new WebDavClient(DEFAULT_TEST_SETTINGS, 1);
        const payload: ArrayBuffer = new Uint8Array([10, 20, 30, 40]).buffer;
        const result: RemoteItem = await client.uploadFile(
            "Notes/C# File?.md",
            payload,
            1728928291789
        );

        const capturedParam: RequestUrlParam | undefined = capturedParams[0];
        expect(capturedParam).toBeDefined();
        expect(capturedParam?.url).toBe(
            "https://cloud.example.com/remote.php/dav/files/alice/Vault/SubVault/Notes/C%23%20File%3F.md"
        );
        expect(capturedParam?.contentType).toBe("application/octet-stream");
        expect(capturedParam?.headers?.["X-OC-Mtime"]).toBe("1728928291");
        expect(result.etag).toBe("put-etag-999");
        expect(result.mtime).toBe(1728928291000);
        expect(result.size).toBe(4);
    });

    it("falls back to statRemote (PROPFIND Depth: 0) when PUT response omits ETag header", async () => {
        const statXml: string = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
    <d:response>
        <d:href>/remote.php/dav/files/alice/Vault/SubVault/Notes/Fallback.md</d:href>
        <d:propstat>
            <d:prop>
                <d:getlastmodified>Wed, 14 Oct 2026 17:51:31 GMT</d:getlastmodified>
                <d:getcontentlength>3</d:getcontentlength>
                <d:getetag>"fallback-etag-777"</d:getetag>
                <d:resourcetype/>
            </d:prop>
            <d:status>HTTP/1.1 200 OK</d:status>
        </d:propstat>
    </d:response>
</d:multistatus>`;

        const methods: string[] = [];
        vi.spyOn(obsidian, "requestUrl").mockImplementation(
            (req: RequestUrlParam | string): RequestUrlResponsePromise => {
                const param: RequestUrlParam =
                    typeof req === "string" ? { url: req } : req;
                const method: string = param.method ?? "GET";
                methods.push(method);
                if (method === "PUT") {
                    return createMockResponse(204, "", {});
                }
                if (method === "PROPFIND") {
                    expect(param.headers?.["Depth"]).toBe("0");
                    return createMockResponse(207, statXml);
                }
                return createMockResponse(500);
            }
        );

        const client: WebDavClient = new WebDavClient(DEFAULT_TEST_SETTINGS, 1);
        const payload: ArrayBuffer = new Uint8Array([1, 2, 3]).buffer;
        const result: RemoteItem = await client.uploadFile(
            "Notes/Fallback.md",
            payload,
            1728928291000
        );

        expect(methods).toEqual(["PUT", "PROPFIND"]);
        expect(result.etag).toBe("fallback-etag-777");
        expect(result.size).toBe(3);
    });

    it("retries 423 Locked responses with backoff and succeeds", async () => {
        let attempts: number = 0;
        const payload: ArrayBuffer = new Uint8Array([7, 8, 9]).buffer;

        vi.spyOn(obsidian, "requestUrl").mockImplementation(
            (): RequestUrlResponsePromise => {
                attempts += 1;
                if (attempts < 3) {
                    return createMockResponse(423, "Sabre\\DAV\\Exception\\Locked");
                }
                return createMockResponse(200, "", {}, payload);
            }
        );

        const client: WebDavClient = new WebDavClient(DEFAULT_TEST_SETTINGS, 1);
        const downloaded: ArrayBuffer = await client.downloadFile("Notes/Locked.md");

        expect(attempts).toBe(3);
        expect(new Uint8Array(downloaded)).toEqual(new Uint8Array([7, 8, 9]));
    });

    it("handles HTTP 401, 403, 404, 409, and 507 Insufficient Storage errors deterministically", async () => {
        const client: WebDavClient = new WebDavClient(DEFAULT_TEST_SETTINGS, 1);

        for (const status of [401, 403, 404, 409, 507]) {
            let callCount: number = 0;
            vi.spyOn(obsidian, "requestUrl").mockImplementation(
                (): RequestUrlResponsePromise => {
                    callCount += 1;
                    return createMockResponse(status);
                }
            );

            await expect(
                client.uploadFile("Notes/Fail.md", new ArrayBuffer(8), 1728928291000)
            ).rejects.toThrow(new RegExp(String(status)));
            expect(callCount).toBe(1);
        }
    });

    it("handles partial /remote.php/dav/files URLs without duplication, skips .trash, keeps .github, and guards non-finite retry/mtime", async () => {
        const rootXml: string = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
    <d:response>
        <d:href>/remote.php/dav/files/alice/Vault/.trash/</d:href>
        <d:propstat>
            <d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop>
            <d:status>HTTP/1.1 200 OK</d:status>
        </d:propstat>
    </d:response>
    <d:response>
        <d:href>/remote.php/dav/files/alice/Vault/.github/</d:href>
        <d:propstat>
            <d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop>
            <d:status>HTTP/1.1 200 OK</d:status>
        </d:propstat>
    </d:response>
</d:multistatus>`;

        const githubXml: string = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
    <d:response>
        <d:href>/remote.php/dav/files/alice/Vault/.github/workflows.md</d:href>
        <d:propstat>
            <d:prop>
                <d:getlastmodified>Wed, 14 Oct 2026 18:00:00 GMT</d:getlastmodified>
                <d:getcontentlength>12</d:getcontentlength>
                <d:getetag>"gh-12"</d:getetag>
                <d:resourcetype/>
            </d:prop>
            <d:status>HTTP/1.1 200 OK</d:status>
        </d:propstat>
    </d:response>
</d:multistatus>`;

        const requestedUrls: string[] = [];
        vi.spyOn(obsidian, "requestUrl").mockImplementation(
            (req: RequestUrlParam | string): RequestUrlResponsePromise => {
                const param: RequestUrlParam =
                    typeof req === "string" ? { url: req } : req;
                requestedUrls.push(param.url);
                if (param.method === "PUT") {
                    const mtimeHeader: number = Number(param.headers?.["X-OC-Mtime"]);
                    expect(Number.isFinite(mtimeHeader)).toBe(true);
                    expect(mtimeHeader).toBeGreaterThan(0);
                    return createMockResponse(201, "", { ETag: '"nan-mtime-etag"' });
                }
                if (param.url.endsWith("/Vault/")) {
                    return createMockResponse(207, rootXml);
                }
                if (param.url.endsWith("/Vault/.github/")) {
                    return createMockResponse(207, githubXml);
                }
                return createMockResponse(404);
            }
        );

        const client: WebDavClient = new WebDavClient(
            {
                ...DEFAULT_TEST_SETTINGS,
                remoteBaseDir: "Vault",
                url: "https://cloud.example.com/remote.php/dav/files/"
            },
            Number.NaN
        );

        const items: RemoteItem[] = await client.walkRemote();
        expect(items.map((i: RemoteItem) => i.path)).toEqual([
            ".github",
            ".github/workflows.md"
        ]);
        expect(requestedUrls[0]).toBe(
            "https://cloud.example.com/remote.php/dav/files/alice/Vault/"
        );
        expect(requestedUrls.some((u: string) => u.includes(".trash"))).toBe(false);

        const uploaded: RemoteItem = await client.uploadFile(
            "Notes/NaNMtime.md",
            new Uint8Array([1, 2]).buffer,
            Number.NaN
        );
        expect(uploaded.mtime).toBeGreaterThan(0);
    });

    it("rejects empty or root paths in deleteItem, createDirectory, downloadFile, and uploadFile without sending requests", async () => {
        const requestSpy = vi.spyOn(obsidian, "requestUrl");
        const client: WebDavClient = new WebDavClient(DEFAULT_TEST_SETTINGS, 1);

        for (const rootPath of ["", "/"]) {
            await expect(client.deleteItem(rootPath, false)).rejects.toThrow(
                /refused on empty root path/
            );
            await expect(client.createDirectory(rootPath)).rejects.toThrow(
                /refused on empty root path/
            );
            await expect(client.downloadFile(rootPath)).rejects.toThrow(
                /refused on empty root path/
            );
            await expect(
                client.uploadFile(rootPath, new ArrayBuffer(4), 1728928291000)
            ).rejects.toThrow(/refused on empty root path/);
        }

        expect(requestSpy).not.toHaveBeenCalled();
    });

    it("retries 423 Locked in ensureRemoteBaseDir and rejects when remoteBaseDir segment is a file", async () => {
        let vaultPropfindAttempts: number = 0;
        const fileStatXml: string = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
    <d:response>
        <d:href>/remote.php/dav/files/alice/Vault/SubVault</d:href>
        <d:propstat>
            <d:prop>
                <d:getlastmodified>Wed, 14 Oct 2026 18:00:00 GMT</d:getlastmodified>
                <d:getcontentlength>10</d:getcontentlength>
                <d:getetag>"file-etag"</d:getetag>
                <d:resourcetype/>
            </d:prop>
            <d:status>HTTP/1.1 200 OK</d:status>
        </d:propstat>
    </d:response>
</d:multistatus>`;

        vi.spyOn(obsidian, "requestUrl").mockImplementation(
            (req: RequestUrlParam | string): RequestUrlResponsePromise => {
                const param: RequestUrlParam =
                    typeof req === "string" ? { url: req } : req;
                if (param.url.endsWith("/remote.php/dav/files/alice/Vault/")) {
                    vaultPropfindAttempts += 1;
                    if (vaultPropfindAttempts === 1) {
                        return createMockResponse(423, "Locked");
                    }
                    return createMockResponse(
                        207,
                        `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"/>`
                    );
                }
                if (param.url.endsWith("/remote.php/dav/files/alice/Vault/SubVault/")) {
                    return createMockResponse(207, fileStatXml);
                }
                return createMockResponse(500);
            }
        );

        const client: WebDavClient = new WebDavClient(DEFAULT_TEST_SETTINGS, 1);
        await expect(client.ensureRemoteBaseDir()).rejects.toThrow(
            "WebDAV PROPFIND Vault/SubVault failed (remote path is not a directory)"
        );
        expect(vaultPropfindAttempts).toBe(2);
    });

    it("handles undefined headers and skips empty etag header in favor of oc-etag in extractHeaderEtag", () => {
        const client: WebDavClient = new WebDavClient(DEFAULT_TEST_SETTINGS, 1);

        expect(client.extractHeaderEtag(undefined)).toBe("");
        expect(client.extractHeaderEtag(null)).toBe("");
        expect(
            client.extractHeaderEtag({
                ETag: '""',
                "OC-ETag": '"valid-oc-etag"'
            })
        ).toBe("valid-oc-etag");
    });

    it("falls back to current timestamp when uploadFile localMtime is 0 and formats 507 Insufficient Storage", async () => {
        const statZeroMtimeXml: string = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
    <d:response>
        <d:href>/remote.php/dav/files/alice/Vault/SubVault/Notes/ZeroMtime.md</d:href>
        <d:propstat>
            <d:prop>
                <d:getcontentlength>2</d:getcontentlength>
                <d:getetag>"zero-mtime-etag"</d:getetag>
                <d:resourcetype/>
            </d:prop>
            <d:status>HTTP/1.1 200 OK</d:status>
        </d:propstat>
    </d:response>
</d:multistatus>`;

        vi.spyOn(obsidian, "requestUrl").mockImplementation(
            (req: RequestUrlParam | string): RequestUrlResponsePromise => {
                const param: RequestUrlParam =
                    typeof req === "string" ? { url: req } : req;
                if (param.method === "PUT") {
                    const mtimeSec: number = Number(param.headers?.["X-OC-Mtime"]);
                    expect(mtimeSec).toBeGreaterThan(0);
                    return createMockResponse(204, "", {});
                }
                return createMockResponse(207, statZeroMtimeXml);
            }
        );

        const client: WebDavClient = new WebDavClient(DEFAULT_TEST_SETTINGS, 1);
        const uploaded: RemoteItem = await client.uploadFile(
            "Notes/ZeroMtime.md",
            new Uint8Array([1, 2]).buffer,
            0
        );
        expect(uploaded.etag).toBe("zero-mtime-etag");
        expect(uploaded.mtime).toBeGreaterThan(0);
        expect(
            client.formatStatusError("PUT", "Notes/ZeroMtime.md", 507).message
        ).toBe("WebDAV PUT Notes/ZeroMtime.md failed (507 Insufficient Storage)");
    });

    it("prevents infinite loops and duplicate entries when walkRemote encounters already-visited directories", async () => {
        const rootXml: string = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
    <d:response>
        <d:href>/remote.php/dav/files/alice/Vault/SubVault/Cycle/</d:href>
        <d:propstat>
            <d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop>
            <d:status>HTTP/1.1 200 OK</d:status>
        </d:propstat>
    </d:response>
</d:multistatus>`;

        const cycleXml: string = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
    <d:response>
        <d:href>/remote.php/dav/files/alice/Vault/SubVault/Cycle/</d:href>
        <d:propstat>
            <d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop>
            <d:status>HTTP/1.1 200 OK</d:status>
        </d:propstat>
    </d:response>
    <d:response>
        <d:href>/remote.php/dav/files/alice/Vault/SubVault/Cycle/Sub/</d:href>
        <d:propstat>
            <d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop>
            <d:status>HTTP/1.1 200 OK</d:status>
        </d:propstat>
    </d:response>
</d:multistatus>`;

        const subXml: string = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
    <d:response>
        <d:href>/remote.php/dav/files/alice/Vault/SubVault/Cycle/</d:href>
        <d:propstat>
            <d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop>
            <d:status>HTTP/1.1 200 OK</d:status>
        </d:propstat>
    </d:response>
    <d:response>
        <d:href>/remote.php/dav/files/alice/Vault/SubVault/Cycle/Sub/Note.md</d:href>
        <d:propstat>
            <d:prop>
                <d:getlastmodified>Wed, 14 Oct 2026 18:00:00 GMT</d:getlastmodified>
                <d:getcontentlength>5</d:getcontentlength>
                <d:getetag>"note-5"</d:getetag>
                <d:resourcetype/>
            </d:prop>
            <d:status>HTTP/1.1 200 OK</d:status>
        </d:propstat>
    </d:response>
</d:multistatus>`;

        let requestCount: number = 0;
        vi.spyOn(obsidian, "requestUrl").mockImplementation(
            (req: RequestUrlParam | string): RequestUrlResponsePromise => {
                requestCount += 1;
                const param: RequestUrlParam =
                    typeof req === "string" ? { url: req } : req;
                if (param.url.endsWith("/SubVault/")) {
                    return createMockResponse(207, rootXml);
                }
                if (param.url.endsWith("/SubVault/Cycle/")) {
                    return createMockResponse(207, cycleXml);
                }
                if (param.url.endsWith("/SubVault/Cycle/Sub/")) {
                    return createMockResponse(207, subXml);
                }
                return createMockResponse(404);
            }
        );

        const client: WebDavClient = new WebDavClient(DEFAULT_TEST_SETTINGS, 1);
        const items: RemoteItem[] = await client.walkRemote();

        expect(requestCount).toBe(3);
        expect(items.map((i: RemoteItem) => i.path)).toEqual([
            "Cycle",
            "Cycle/Sub",
            "Cycle/Sub/Note.md"
        ]);
    });
});
