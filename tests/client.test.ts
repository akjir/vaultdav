import type {
    RequestUrlParam,
    RequestUrlResponse,
    RequestUrlResponsePromise
} from "obsidian";
import * as obsidian from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteItem, WebDavClientConfig } from "../src/types";
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

const DEFAULT_TEST_SETTINGS: WebDavClientConfig = {
    appPassword: "app-password-123",
    chunkSizeMB: 10,
    chunkingThresholdMB: 90,
    remoteBaseDir: "Vault/SubVault",
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

    it("rejects empty, root, traversal, or excluded paths in deleteItem, createDirectory, downloadFile, and uploadFile without sending requests", async () => {
        const requestSpy = vi.spyOn(obsidian, "requestUrl");
        const client: WebDavClient = new WebDavClient(DEFAULT_TEST_SETTINGS, 1);

        for (const rootOrTraversalPath of ["", "/", ".", "..", "../OtherFolder", "a/../.."]) {
            await expect(client.deleteItem(rootOrTraversalPath, true)).rejects.toThrow(
                /refused on empty root path/
            );
            await expect(client.createDirectory(rootOrTraversalPath)).rejects.toThrow(
                /refused on empty root path/
            );
            await expect(client.downloadFile(rootOrTraversalPath)).rejects.toThrow(
                /refused on empty root path/
            );
            await expect(
                client.uploadFile(rootOrTraversalPath, new ArrayBuffer(4), 1728928291000)
            ).rejects.toThrow(/refused on empty root path/);
        }

        for (const excludedPath of [
            ".obsidian/plugins/vaultdav/data.json",
            ".obsidian/plugins/VaultDAV/data.json",
            ".obsidian/plugins/vaultdav/sync-state.json",
            ".git/config"
        ]) {
            await expect(client.deleteItem(excludedPath, false)).rejects.toThrow(
                /refused on excluded path/
            );
            await expect(client.createDirectory(excludedPath)).rejects.toThrow(
                /refused on excluded path/
            );
            await expect(client.downloadFile(excludedPath)).rejects.toThrow(
                /refused on excluded path/
            );
            await expect(
                client.uploadFile(excludedPath, new ArrayBuffer(4), 1728928291000)
            ).rejects.toThrow(/refused on excluded path/);
        }

        expect(requestSpy).not.toHaveBeenCalled();
    });

    it("retries 423 Locked in ensureRemoteBaseDir, rejects when remoteBaseDir is empty or '..', and rejects when segment is a file", async () => {
        for (const badBaseDir of ["", "   ", ".", ".."]) {
            const badClient: WebDavClient = new WebDavClient(
                {
                    ...DEFAULT_TEST_SETTINGS,
                    remoteBaseDir: badBaseDir
                },
                1
            );
            await expect(badClient.ensureRemoteBaseDir()).rejects.toThrow(
                /remoteBaseDir must not be empty/
            );
        }

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

    it("prevents infinite loops on cyclic directories and stops traversing deeper than MAX_WALK_DEPTH", async () => {
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

        const basePrefix: string = "https://cloud.example.com/remote.php/dav/files/alice/Vault/SubVault/";
        vi.spyOn(obsidian, "requestUrl").mockImplementation(
            (req: RequestUrlParam | string): RequestUrlResponsePromise => {
                const param: RequestUrlParam =
                    typeof req === "string" ? { url: req } : req;
                const relDir: string = param.url
                    .slice(basePrefix.length)
                    .replace(/\/+$/, "");
                const childDir: string = relDir === "" ? "d" : `${relDir}/d`;
                const xml: string = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
    <d:response>
        <d:href>/remote.php/dav/files/alice/Vault/SubVault/${childDir}/</d:href>
        <d:propstat>
            <d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop>
            <d:status>HTTP/1.1 200 OK</d:status>
        </d:propstat>
    </d:response>
</d:multistatus>`;
                return createMockResponse(207, xml);
            }
        );

        const deepItems: RemoteItem[] = await client.walkRemote();
        expect(deepItems.length).toBe(64);
    });

    it("rejects oversized files (> chunkingThresholdMB / MAX_FILE_SIZE_BYTES) in unchunked uploadFile and downloadFile with a warning", async () => {
        const client: WebDavClient = new WebDavClient(DEFAULT_TEST_SETTINGS, 1);
        const oversizedLength: number = 100 * 1024 * 1024;
        const fakeOversizedBuffer: ArrayBuffer = {
            byteLength: oversizedLength,
            slice: () => new ArrayBuffer(0)
        } as unknown as ArrayBuffer;

        const requestSpy = vi.spyOn(obsidian, "requestUrl");
        await expect(
            client.uploadFile("Notes/HugeVideo.mp4", fakeOversizedBuffer, 1728928291000)
        ).rejects.toThrow(/oversized file/i);
        expect(requestSpy).not.toHaveBeenCalled();

        requestSpy.mockImplementation((): RequestUrlResponsePromise => {
            return createMockResponse(
                200,
                "",
                { "Content-Length": String(oversizedLength) },
                fakeOversizedBuffer
            );
        });

        await expect(client.downloadFile("Notes/HugeVideo.mp4")).rejects.toThrow(
            /oversized file/i
        );
    });

    it("retries HTTP 425, 429, 503, and 504 with exponential backoff and never misinterprets persistent 5xx/rate-limit errors as 404 Not Found", async () => {
        const client: WebDavClient = new WebDavClient(DEFAULT_TEST_SETTINGS, 1);
        const payload: ArrayBuffer = new Uint8Array([1, 2, 3]).buffer;

        for (const retryStatus of [425, 429, 503, 504]) {
            let attempts: number = 0;
            vi.spyOn(obsidian, "requestUrl").mockImplementation(
                (): RequestUrlResponsePromise => {
                    attempts += 1;
                    if (attempts < 3) {
                        return createMockResponse(retryStatus, "Transient Overload");
                    }
                    return createMockResponse(200, "", {}, payload);
                }
            );

            const downloaded: ArrayBuffer = await client.downloadFile(
                `Notes/Retry-${retryStatus}.md`
            );
            expect(attempts).toBe(3);
            expect(downloaded.byteLength).toBe(3);
        }

        // Persistent 503 / 504 / 429 / 425 in statRemote and walkRemote must throw after max retries (4 total attempts), never return null like 404
        for (const persistentStatus of [425, 429, 503, 504]) {
            let statAttempts: number = 0;
            vi.spyOn(obsidian, "requestUrl").mockImplementation(
                (): RequestUrlResponsePromise => {
                    statAttempts += 1;
                    return createMockResponse(persistentStatus, "Server Overload");
                }
            );

            await expect(
                client.statRemote("Notes/Important.md", false)
            ).rejects.toThrow(new RegExp(String(persistentStatus)));
            expect(statAttempts).toBe(4);

            let walkAttempts: number = 0;
            vi.spyOn(obsidian, "requestUrl").mockImplementation(
                (): RequestUrlResponsePromise => {
                    walkAttempts += 1;
                    return createMockResponse(persistentStatus, "Server Overload");
                }
            );

            await expect(client.walkRemote()).rejects.toThrow(
                new RegExp(String(persistentStatus))
            );
            expect(walkAttempts).toBe(4);
        }
    });

    it("deduplicates case-colliding remote paths in walkRemote and normalizes weak ETag in uploadFile fallback stat", async () => {
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
        <d:href>/remote.php/dav/files/alice/Vault/SubVault/Note.md</d:href>
        <d:propstat>
            <d:prop>
                <d:getlastmodified>Wed, 14 Oct 2026 18:00:00 GMT</d:getlastmodified>
                <d:getcontentlength>10</d:getcontentlength>
                <d:getetag>W/"etag-upper"</d:getetag>
                <d:resourcetype/>
            </d:prop>
            <d:status>HTTP/1.1 200 OK</d:status>
        </d:propstat>
    </d:response>
    <d:response>
        <d:href>/remote.php/dav/files/alice/Vault/SubVault/note.md</d:href>
        <d:propstat>
            <d:prop>
                <d:getlastmodified>Wed, 14 Oct 2026 18:00:00 GMT</d:getlastmodified>
                <d:getcontentlength>12</d:getcontentlength>
                <d:getetag>"etag-lower"</d:getetag>
                <d:resourcetype/>
            </d:prop>
            <d:status>HTTP/1.1 200 OK</d:status>
        </d:propstat>
    </d:response>
</d:multistatus>`;

        vi.spyOn(obsidian, "requestUrl").mockImplementation(
            (): RequestUrlResponsePromise => createMockResponse(207, rootXml)
        );

        const client: WebDavClient = new WebDavClient(DEFAULT_TEST_SETTINGS, 1);
        const items: RemoteItem[] = await client.walkRemote();
        expect(items.map((i: RemoteItem) => i.path)).toEqual(["Note.md"]);
        expect(items[0]?.etag).toBe("etag-upper");
    });

    it("executes Nextcloud OC-Chunked upload (MKCOL, padded PUT chunks with retry, MOVE .file assembly with Destination & X-OC-Mtime, and ETag extraction)", async () => {
        const recordedRequests: Array<{
            bodyLength: number;
            headers: Record<string, string>;
            method: string;
            url: string;
        }> = [];
        let secondChunkAttempts: number = 0;

        vi.spyOn(obsidian, "requestUrl").mockImplementation(
            (req: RequestUrlParam | string): RequestUrlResponsePromise => {
                const param: RequestUrlParam =
                    typeof req === "string" ? { url: req } : req;
                const method: string = param.method ?? "GET";
                const bodyLength: number =
                    param.body instanceof ArrayBuffer ? param.body.byteLength : 0;
                recordedRequests.push({
                    bodyLength,
                    headers: param.headers ?? {},
                    method,
                    url: param.url
                });

                if (method === "MKCOL") {
                    return createMockResponse(201);
                }
                if (method === "PUT") {
                    if (param.url.endsWith("/0000000000000002")) {
                        secondChunkAttempts += 1;
                        if (secondChunkAttempts === 1) {
                            return createMockResponse(423, "Locked");
                        }
                    }
                    return createMockResponse(201);
                }
                if (method === "MOVE") {
                    return createMockResponse(201, "", {
                        "OC-ETag": '"chunked-etag-42"'
                    });
                }
                return createMockResponse(500);
            }
        );

        const client: WebDavClient = new WebDavClient(
            {
                ...DEFAULT_TEST_SETTINGS,
                chunkSizeMB: 4 / (1024 * 1024)
            },
            1
        );
        const payloadBytes: Uint8Array<ArrayBuffer> = new Uint8Array([
            1, 2, 3, 4, 5, 6, 7, 8, 9, 10
        ]);
        const progressEvents: Array<[number, number]> = [];

        const item: RemoteItem = await client.uploadFileChunked(
            "Notes/Large Video.mp4",
            payloadBytes.buffer,
            1728928291789,
            (done: number, total: number): void => {
                progressEvents.push([done, total]);
            }
        );

        expect(secondChunkAttempts).toBe(2);
        expect(progressEvents).toEqual([
            [1, 3],
            [2, 3],
            [3, 3]
        ]);
        expect(item.etag).toBe("chunked-etag-42");
        expect(item.mtime).toBe(1728928291000);
        expect(item.size).toBe(10);

        const mkcolReq = recordedRequests[0];
        expect(mkcolReq?.method).toBe("MKCOL");
        expect(mkcolReq?.url).toMatch(
            /^https:\/\/cloud\.example\.com\/remote\.php\/dav\/uploads\/alice\/[A-Za-z0-9-]+$/
        );

        const transferPrefix: string = mkcolReq?.url ?? "";
        const putUrls: string[] = recordedRequests
            .filter((r) => r.method === "PUT")
            .map((r) => r.url);
        expect(putUrls).toEqual([
            `${transferPrefix}/0000000000000001`,
            `${transferPrefix}/0000000000000002`,
            `${transferPrefix}/0000000000000002`,
            `${transferPrefix}/0000000000000003`
        ]);

        const moveReq = recordedRequests[recordedRequests.length - 1];
        expect(moveReq?.method).toBe("MOVE");
        expect(moveReq?.url).toBe(`${transferPrefix}/.file`);
        expect(moveReq?.headers["Destination"]).toBe(
            "https://cloud.example.com/remote.php/dav/files/alice/Vault/SubVault/Notes/Large%20Video.mp4"
        );
        expect(moveReq?.headers["X-OC-Mtime"]).toBe("1728928291");
    });

    it("downloads large files in parallel Range chunks using Uint8Array.set() with retry backoff and progress reporting", async () => {
        const fullPayload: Uint8Array<ArrayBuffer> = new Uint8Array([
            10, 11, 12, 13, 20, 21, 22, 23, 30, 31
        ]);
        const rangeHeaders: string[] = [];
        let secondRangeAttempts: number = 0;

        vi.spyOn(obsidian, "requestUrl").mockImplementation(
            (req: RequestUrlParam | string): RequestUrlResponsePromise => {
                const param: RequestUrlParam =
                    typeof req === "string" ? { url: req } : req;
                const rangeHeader: string = param.headers?.["Range"] ?? "";
                rangeHeaders.push(rangeHeader);

                if (rangeHeader === "bytes=4-7") {
                    secondRangeAttempts += 1;
                    if (secondRangeAttempts === 1) {
                        return createMockResponse(503, "Service Unavailable");
                    }
                }

                const match: RegExpExecArray | null =
                    /^bytes=(\d+)-(\d+)$/.exec(rangeHeader);
                if (match === null) {
                    return createMockResponse(400);
                }
                const start: number = Number(match[1]);
                const end: number = Number(match[2]);
                const slice: ArrayBuffer = fullPayload.buffer.slice(start, end + 1);
                return createMockResponse(206, "", {}, slice);
            }
        );

        const client: WebDavClient = new WebDavClient(
            {
                ...DEFAULT_TEST_SETTINGS,
                chunkSizeMB: 4 / (1024 * 1024)
            },
            1
        );
        const progressEvents: Array<[number, number]> = [];

        const downloaded: ArrayBuffer = await client.downloadFileChunked(
            "Notes/LargeArchive.zip",
            fullPayload.byteLength,
            (done: number, total: number): void => {
                progressEvents.push([done, total]);
            }
        );

        expect(secondRangeAttempts).toBe(2);
        expect(new Uint8Array(downloaded)).toEqual(fullPayload);
        expect(rangeHeaders).toContain("bytes=0-3");
        expect(rangeHeaders).toContain("bytes=4-7");
        expect(rangeHeaders).toContain("bytes=8-9");
        expect(progressEvents).toEqual([
            [1, 3],
            [2, 3],
            [3, 3]
        ]);

        // Defensive guards on empty / invalid paths and sizes
        await expect(
            client.downloadFileChunked("../escape.bin", 10)
        ).rejects.toThrow(/refused on empty root path/);
        await expect(
            client.downloadFileChunked(".git/config", 10)
        ).rejects.toThrow(/refused on excluded path/);
        await expect(
            client.downloadFileChunked("Notes/Valid.bin", Number.NaN)
        ).rejects.toThrow(/Invalid file size/);
        await expect(
            client.uploadFileChunked("../escape.bin", new ArrayBuffer(4), 1000)
        ).rejects.toThrow(/refused on empty root path/);
        await expect(
            client.uploadFileChunked(".git/config", new ArrayBuffer(4), 1000)
        ).rejects.toThrow(/refused on excluded path/);

        const emptyBuf: ArrayBuffer = await client.downloadFileChunked(
            "Notes/Empty.bin",
            0
        );
        expect(emptyBuf.byteLength).toBe(0);
    });

    it("prevents silent zero-fill corruption on truncated 206 chunks, slices full-body 200 fallback at chunk offset, and enforces MAX_CHUNKED_FILE_SIZE_BYTES", async () => {
        const client: WebDavClient = new WebDavClient(
            {
                ...DEFAULT_TEST_SETTINGS,
                chunkSizeMB: 4 / (1024 * 1024)
            },
            1
        );

        // 1. Truncated 206 Partial Content (returns 2 bytes instead of 4) must throw, never zero-fill
        vi.spyOn(obsidian, "requestUrl").mockImplementation(
            (): RequestUrlResponsePromise => {
                return createMockResponse(
                    206,
                    "",
                    {},
                    new Uint8Array([10, 11]).buffer
                );
            }
        );
        await expect(
            client.downloadFileChunked("Notes/Truncated206.bin", 8)
        ).rejects.toThrow(/unexpected chunk length/i);

        // 2. Server ignores Range header and returns HTTP 200 with full 10-byte file
        const fullPayload: Uint8Array<ArrayBuffer> = new Uint8Array([
            10, 11, 12, 13, 20, 21, 22, 23, 30, 31
        ]);
        vi.spyOn(obsidian, "requestUrl").mockImplementation(
            (): RequestUrlResponsePromise => {
                return createMockResponse(200, "", {}, fullPayload.buffer);
            }
        );
        const downloaded200: ArrayBuffer = await client.downloadFileChunked(
            "Notes/FullBody200.bin",
            fullPayload.byteLength
        );
        expect(new Uint8Array(downloaded200)).toEqual(fullPayload);

        // 3. Server returns HTTP 200 with truncated body must throw
        vi.spyOn(obsidian, "requestUrl").mockImplementation(
            (): RequestUrlResponsePromise => {
                return createMockResponse(
                    200,
                    "",
                    {},
                    new Uint8Array([1, 2, 3]).buffer
                );
            }
        );
        await expect(
            client.downloadFileChunked("Notes/Truncated200.bin", 10)
        ).rejects.toThrow(/unexpected full body length/i);

        // 4. Oversized totalSize (> 1 GB) must be rejected before allocating memory
        await expect(
            client.downloadFileChunked("Notes/Bomb.bin", 2 * 1024 * 1024 * 1024)
        ).rejects.toThrow(/oversized chunked file/i);
    });

    it("cleans up orphaned remote chunk staging directory via DELETE when uploadFileChunked fails on PUT or MOVE", async () => {
        const client: WebDavClient = new WebDavClient(
            {
                ...DEFAULT_TEST_SETTINGS,
                chunkSizeMB: 4 / (1024 * 1024)
            },
            1
        );
        const payload: ArrayBuffer = new Uint8Array([1, 2, 3, 4, 5, 6]).buffer;

        // 1. Failure during chunk PUT triggers DELETE on transferDirUrl
        const putFailCalls: Array<{ method: string; url: string }> = [];
        vi.spyOn(obsidian, "requestUrl").mockImplementation(
            (req: RequestUrlParam | string): RequestUrlResponsePromise => {
                const param: RequestUrlParam =
                    typeof req === "string" ? { url: req } : req;
                const method: string = param.method ?? "GET";
                putFailCalls.push({ method, url: param.url });
                if (method === "MKCOL") {
                    return createMockResponse(201);
                }
                if (method === "PUT") {
                    return createMockResponse(507);
                }
                if (method === "DELETE") {
                    return createMockResponse(204);
                }
                return createMockResponse(500);
            }
        );

        await expect(
            client.uploadFileChunked("Notes/AbortPut.bin", payload, 1728928291000)
        ).rejects.toThrow(/507 Insufficient Storage/);

        const mkcolUrl: string = putFailCalls[0]?.url ?? "";
        expect(putFailCalls.map((c) => c.method)).toEqual([
            "MKCOL",
            "PUT",
            "DELETE"
        ]);
        expect(putFailCalls[2]?.url).toBe(mkcolUrl);

        // 2. Failure during final MOVE triggers DELETE on transferDirUrl and preserves original error even if DELETE fails
        const moveFailCalls: Array<{ method: string; url: string }> = [];
        vi.spyOn(obsidian, "requestUrl").mockImplementation(
            (req: RequestUrlParam | string): RequestUrlResponsePromise => {
                const param: RequestUrlParam =
                    typeof req === "string" ? { url: req } : req;
                const method: string = param.method ?? "GET";
                moveFailCalls.push({ method, url: param.url });
                if (method === "MKCOL" || method === "PUT") {
                    return createMockResponse(201);
                }
                if (method === "MOVE") {
                    return createMockResponse(409);
                }
                if (method === "DELETE") {
                    return createMockResponse(500);
                }
                return createMockResponse(500);
            }
        );

        await expect(
            client.uploadFileChunked("Notes/AbortMove.bin", payload, 1728928291000)
        ).rejects.toThrow(/409 Conflict/);
        expect(moveFailCalls.map((c) => c.method)).toEqual([
            "MKCOL",
            "PUT",
            "PUT",
            "MOVE",
            "DELETE"
        ]);
        expect(moveFailCalls[4]?.url).toBe(moveFailCalls[0]?.url);
    });

    it("rejects traversal and excluded paths in listDirectory and statRemote, isolates settings from external mutation, and blocks root/excluded remoteBaseDir across all methods", async () => {
        const requestSpy = vi.spyOn(obsidian, "requestUrl");
        const mutableSettings: WebDavClientConfig = { ...DEFAULT_TEST_SETTINGS };
        const client: WebDavClient = new WebDavClient(mutableSettings, 1);

        // Constructor must reject empty or control-char app passwords and never retain plaintext appPassword on the instance
        for (const badPassword of ["", "   ", "secret\r\ninjected", "pw\0null"]) {
            expect(
                () =>
                    new WebDavClient(
                        { ...DEFAULT_TEST_SETTINGS, appPassword: badPassword },
                        1
                    )
            ).toThrow(/app password/i);
        }
        expect(JSON.stringify(client)).not.toContain("app-password-123");

        // Traversal and control-char paths must throw in listDirectory and statRemote instead of normalizing to ""
        for (const badPath of [
            ".",
            "..",
            "../secret",
            "Notes/../../secret",
            "a\0b",
            "\n",
            "\r/",
            "\t"
        ]) {
            await expect(client.listDirectory(badPath)).rejects.toThrow(
                /refused on empty root path/
            );
            await expect(client.statRemote(badPath, false)).rejects.toThrow(
                /refused on empty root path/
            );
        }

        // Excluded paths must throw in listDirectory and statRemote
        for (const excludedPath of [
            ".git",
            ".trash",
            ".obsidian/plugins/vaultdav/data.json",
            ".obsidian/plugins/vaultdav/sync-state.json"
        ]) {
            await expect(client.listDirectory(excludedPath)).rejects.toThrow(
                /refused on excluded path/
            );
            await expect(client.statRemote(excludedPath, false)).rejects.toThrow(
                /refused on excluded path/
            );
        }
        expect(requestSpy).not.toHaveBeenCalled();

        // External mutation of the settings object passed to constructor must not affect client
        mutableSettings.remoteBaseDir = "";
        mutableSettings.username = "attacker";
        expect(client.buildResourceUrl("Notes/Test.md", false)).toBe(
            "https://cloud.example.com/remote.php/dav/files/alice/Vault/SubVault/Notes/Test.md"
        );

        // Client initialized with empty, traversal, or excluded remoteBaseDir must refuse all operations
        for (const badBaseDir of ["", "/", "..", ".obsidian/plugins/vaultdav", ".git"]) {
            const badClient: WebDavClient = new WebDavClient(
                {
                    ...DEFAULT_TEST_SETTINGS,
                    remoteBaseDir: badBaseDir
                },
                1
            );
            expect(() => badClient.buildResourceUrl("Notes/File.md", false)).toThrow(
                /remoteBaseDir/
            );
            await expect(badClient.deleteItem("Notes/File.md", false)).rejects.toThrow(
                /remoteBaseDir/
            );
            await expect(badClient.walkRemote()).rejects.toThrow(/remoteBaseDir/);
            await expect(badClient.statRemote("", true)).rejects.toThrow(
                /remoteBaseDir/
            );
        }
        expect(requestSpy).not.toHaveBeenCalled();
    });

    it("verifies remote directory emptiness before recursive WebDAV DELETE and returns cleanly on 404", async () => {
        const client: WebDavClient = new WebDavClient(DEFAULT_TEST_SETTINGS, 1);

        const nonEmptyXml: string = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
    <d:response>
        <d:href>/remote.php/dav/files/alice/Vault/SubVault/Project/</d:href>
        <d:propstat>
            <d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop>
            <d:status>HTTP/1.1 200 OK</d:status>
        </d:propstat>
    </d:response>
    <d:response>
        <d:href>/remote.php/dav/files/alice/Vault/SubVault/Project/.git/</d:href>
        <d:propstat>
            <d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop>
            <d:status>HTTP/1.1 200 OK</d:status>
        </d:propstat>
    </d:response>
</d:multistatus>`;

        const nonEmptyMethods: string[] = [];
        vi.spyOn(obsidian, "requestUrl").mockImplementation(
            (req: RequestUrlParam | string): RequestUrlResponsePromise => {
                const param: RequestUrlParam =
                    typeof req === "string" ? { url: req } : req;
                nonEmptyMethods.push(param.method ?? "GET");
                return createMockResponse(207, nonEmptyXml);
            }
        );

        await expect(client.deleteItem("Project", true)).rejects.toThrow(/ENOTEMPTY/);
        expect(nonEmptyMethods).toEqual(["PROPFIND"]);

        const emptyXml: string = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
    <d:response>
        <d:href>/remote.php/dav/files/alice/Vault/SubVault/EmptyDir/</d:href>
        <d:propstat>
            <d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop>
            <d:status>HTTP/1.1 200 OK</d:status>
        </d:propstat>
    </d:response>
</d:multistatus>`;
        const emptyMethods: string[] = [];
        vi.spyOn(obsidian, "requestUrl").mockImplementation(
            (req: RequestUrlParam | string): RequestUrlResponsePromise => {
                const param: RequestUrlParam =
                    typeof req === "string" ? { url: req } : req;
                emptyMethods.push(param.method ?? "GET");
                if (param.method === "PROPFIND") {
                    return createMockResponse(207, emptyXml);
                }
                return createMockResponse(204);
            }
        );

        await client.deleteItem("EmptyDir", true);
        expect(emptyMethods).toEqual(["PROPFIND", "DELETE"]);

        const goneMethods: string[] = [];
        vi.spyOn(obsidian, "requestUrl").mockImplementation(
            (req: RequestUrlParam | string): RequestUrlResponsePromise => {
                const param: RequestUrlParam =
                    typeof req === "string" ? { url: req } : req;
                goneMethods.push(param.method ?? "GET");
                return createMockResponse(404);
            }
        );

        await client.deleteItem("AlreadyGone", true);
        expect(goneMethods).toEqual(["PROPFIND"]);
    });

    it("enforces ETag and Content-Range integrity, single-request HTTP 200 short-circuit, clamped chunk bounds, custom configDir, and non-retried MOVE timeout", async () => {
        // 1. Single-request HTTP 200 short-circuit when server ignores Range
        const fullPayload: Uint8Array<ArrayBuffer> = new Uint8Array([
            1, 2, 3, 4, 5, 6, 7, 8, 9, 10
        ]);
        let http200Requests: number = 0;
        vi.spyOn(obsidian, "requestUrl").mockImplementation(
            (): RequestUrlResponsePromise => {
                http200Requests += 1;
                return createMockResponse(
                    200,
                    "",
                    { ETag: '"same-etag"' },
                    fullPayload.buffer
                );
            }
        );

        const smallChunkClient: WebDavClient = new WebDavClient(
            {
                ...DEFAULT_TEST_SETTINGS,
                chunkSizeMB: 4 / (1024 * 1024)
            },
            1
        );
        const downloaded200: ArrayBuffer =
            await smallChunkClient.downloadFileChunked(
                "Notes/NoRange.bin",
                fullPayload.byteLength,
                undefined,
                "same-etag"
            );
        expect(new Uint8Array(downloaded200)).toEqual(fullPayload);
        expect(http200Requests).toBe(1);

        // 2. Mid-download ETag drift must reject to prevent torn reads
        let driftCall: number = 0;
        vi.spyOn(obsidian, "requestUrl").mockImplementation(
            (req: RequestUrlParam | string): RequestUrlResponsePromise => {
                driftCall += 1;
                const param: RequestUrlParam =
                    typeof req === "string" ? { url: req } : req;
                const range: string = param.headers?.["Range"] ?? "";
                const match: RegExpExecArray | null =
                    /^bytes=(\d+)-(\d+)$/.exec(range);
                const start: number = Number(match?.[1] ?? 0);
                const end: number = Number(match?.[2] ?? 0);
                return createMockResponse(
                    206,
                    "",
                    {
                        "Content-Range": `bytes ${start}-${end}/10`,
                        ETag: driftCall === 1 ? '"v1"' : '"v2"'
                    },
                    fullPayload.buffer.slice(start, end + 1)
                );
            }
        );
        await expect(
            smallChunkClient.downloadFileChunked(
                "Notes/Drifting.bin",
                10,
                undefined,
                "v1"
            )
        ).rejects.toThrow(/ETag changed/i);

        // 3. Mismatched Content-Range header must reject
        vi.spyOn(obsidian, "requestUrl").mockImplementation(
            (): RequestUrlResponsePromise =>
                createMockResponse(
                    206,
                    "",
                    {
                        "Content-Range": "bytes 4-7/10",
                        ETag: '"v1"'
                    },
                    fullPayload.buffer.slice(0, 4)
                )
        );
        await expect(
            smallChunkClient.downloadFileChunked(
                "Notes/BadRange.bin",
                10,
                undefined,
                "v1"
            )
        ).rejects.toThrow(/Content-Range/i);

        // 4. Extreme chunkSizeMB (1e305) must clamp instead of overflowing to Infinity (0 chunks / zero-fill)
        let extremeRequests: number = 0;
        vi.spyOn(obsidian, "requestUrl").mockImplementation(
            (): RequestUrlResponsePromise => {
                extremeRequests += 1;
                return createMockResponse(
                    206,
                    "",
                    { "Content-Range": "bytes 0-9/10" },
                    fullPayload.buffer
                );
            }
        );
        const extremeClient: WebDavClient = new WebDavClient(
            {
                ...DEFAULT_TEST_SETTINGS,
                chunkSizeMB: 1e305,
                chunkingThresholdMB: 0.5
            },
            1
        );
        const extremeDownloaded: ArrayBuffer =
            await extremeClient.downloadFileChunked("Notes/Extreme.bin", 10);
        expect(extremeRequests).toBe(1);
        expect(new Uint8Array(extremeDownloaded)).toEqual(fullPayload);

        // Fractional chunkingThresholdMB (< 1) falls back to 90 MB (matching SyncEngine) instead of rejecting 1 MB files
        vi.spyOn(obsidian, "requestUrl").mockImplementation(
            (): RequestUrlResponsePromise =>
                createMockResponse(201, "", { ETag: '"ok-etag"' })
        );
        const oneMbBuffer: ArrayBuffer = new ArrayBuffer(1024 * 1024);
        const uploadedOneMb: RemoteItem = await extremeClient.uploadFile(
            "Notes/OneMb.bin",
            oneMbBuffer,
            1728928291000
        );
        expect(uploadedOneMb.etag).toBe("ok-etag");

        // 5. Custom configDir is refused by client guards
        const customConfigClient: WebDavClient = new WebDavClient(
            DEFAULT_TEST_SETTINGS,
            1,
            ".obsidian-mobile"
        );
        await expect(
            customConfigClient.uploadFile(
                ".obsidian-mobile/plugins/vaultdav/data.json",
                new ArrayBuffer(4),
                1728928291000
            )
        ).rejects.toThrow(/refused on excluded path/);

        // 6. Client timeout on MOVE /.file must not retry MOVE multiple times
        let moveCalls: number = 0;
        vi.spyOn(obsidian, "requestUrl").mockImplementation(
            (req: RequestUrlParam | string): RequestUrlResponsePromise => {
                const param: RequestUrlParam =
                    typeof req === "string" ? { url: req } : req;
                if (param.method === "MKCOL" || param.method === "PUT") {
                    return createMockResponse(201);
                }
                if (param.method === "MOVE") {
                    moveCalls += 1;
                    const errPromise: Promise<RequestUrlResponse> =
                        Promise.reject(
                            new Error(
                                "WebDAV MOVE Notes/Slow.bin timed out after 300000ms"
                            )
                        );
                    const rejectedAb: Promise<ArrayBuffer> = Promise.reject(
                        new Error("timeout")
                    );
                    const rejectedJson: Promise<unknown> = Promise.reject(
                        new Error("timeout")
                    );
                    const rejectedText: Promise<string> = Promise.reject(
                        new Error("timeout")
                    );
                    void rejectedAb.catch(() => undefined);
                    void rejectedJson.catch(() => undefined);
                    void rejectedText.catch(() => undefined);
                    return Object.assign(errPromise, {
                        arrayBuffer: rejectedAb,
                        json: rejectedJson,
                        text: rejectedText
                    });
                }
                return createMockResponse(204);
            }
        );
        await expect(
            smallChunkClient.uploadFileChunked(
                "Notes/Slow.bin",
                new Uint8Array([1, 2, 3, 4]).buffer,
                1728928291000
            )
        ).rejects.toThrow(/timed out/i);
        expect(moveCalls).toBe(1);
    });

    it("avoids retrying or deleting staging dir on HTTP 504 MOVE assembly timeout, returns HTTP 200 chunked download directly without copying, and aborts remaining chunks on failure", async () => {
        const smallChunkClient: WebDavClient = new WebDavClient(
            {
                ...DEFAULT_TEST_SETTINGS,
                chunkSizeMB: 4 / (1024 * 1024)
            },
            0
        );

        // 1. HTTP 504 on MOVE /.file must neither retry MOVE nor DELETE the active staging dir
        const move504Methods: string[] = [];
        vi.spyOn(obsidian, "requestUrl").mockImplementation(
            (req: RequestUrlParam | string): RequestUrlResponsePromise => {
                const param: RequestUrlParam =
                    typeof req === "string" ? { url: req } : req;
                const method: string = param.method ?? "GET";
                move504Methods.push(method);
                if (method === "MKCOL" || method === "PUT") {
                    return createMockResponse(201);
                }
                if (method === "MOVE") {
                    return createMockResponse(504, "Gateway Timeout");
                }
                return createMockResponse(204);
            }
        );

        await expect(
            smallChunkClient.uploadFileChunked(
                "Notes/GatewayTimeout.bin",
                new Uint8Array([1, 2, 3, 4, 5, 6]).buffer,
                1728928291000
            )
        ).rejects.toThrow(/504 Gateway Timeout/);
        expect(move504Methods).toEqual(["MKCOL", "PUT", "PUT", "MOVE"]);

        // 2. HTTP 200 fallback on chunk 0 returns the exact response ArrayBuffer directly without extra full-file copy
        const fullPayload: ArrayBuffer = new Uint8Array([
            10, 20, 30, 40, 50, 60, 70, 80
        ]).buffer;
        vi.spyOn(obsidian, "requestUrl").mockImplementationOnce(
            (): RequestUrlResponsePromise =>
                createMockResponse(200, "", { ETag: '"direct-200"' }, fullPayload)
        );
        const directDownloaded: ArrayBuffer =
            await smallChunkClient.downloadFileChunked(
                "Notes/Direct200.bin",
                fullPayload.byteLength
            );
        expect(directDownloaded).toBe(fullPayload);

        // 3. Failure in chunk 1 aborts remaining queued chunks (chunks 5..9) and suppresses late onProgress callbacks
        const requestedRanges: string[] = [];
        const progressEvents: Array<[number, number]> = [];
        let rejectSettled: boolean = false;
        vi.spyOn(obsidian, "requestUrl").mockImplementation(
            (req: RequestUrlParam | string): RequestUrlResponsePromise => {
                const param: RequestUrlParam =
                    typeof req === "string" ? { url: req } : req;
                const range: string = param.headers?.Range ?? "";
                requestedRanges.push(range);
                if (range === "bytes=0-3") {
                    return createMockResponse(
                        206,
                        "",
                        { "Content-Range": "bytes 0-3/40", ETag: '"etag-10"' },
                        new Uint8Array([0, 1, 2, 3]).buffer
                    );
                }
                if (range === "bytes=4-7") {
                    return createMockResponse(
                        206,
                        "",
                        { "Content-Range": "bytes 4-7/40", ETag: '"etag-changed"' },
                        new Uint8Array([4, 5, 6, 7]).buffer
                    );
                }
                const delayedResp: Promise<RequestUrlResponse> = new Promise(
                    (resolve) => {
                        setTimeout(() => {
                            resolve({
                                arrayBuffer: new Uint8Array([8, 9, 10, 11]).buffer,
                                headers: { ETag: '"etag-10"' },
                                json: {},
                                status: 206,
                                text: ""
                            });
                        }, 15);
                    }
                );
                return Object.assign(delayedResp, {
                    arrayBuffer: delayedResp.then((r) => r.arrayBuffer),
                    json: delayedResp.then((r): unknown => r.json as unknown),
                    text: delayedResp.then((r) => r.text)
                });
            }
        );

        await expect(
            smallChunkClient.downloadFileChunked(
                "Notes/AbortMidDownload.bin",
                40,
                (done: number, total: number): void => {
                    progressEvents.push([done, total]);
                    expect(rejectSettled).toBe(false);
                },
                '"etag-10"'
            )
        ).rejects.toThrow(/ETag changed/i);
        rejectSettled = true;
        await new Promise<void>((resolve) => setTimeout(resolve, 40));

        // Chunk 0 + up to 4 parallel workers (chunks 1..4) = at most 5 requests out of 10 chunks
        expect(requestedRanges.length).toBeLessThanOrEqual(5);
        expect(progressEvents).toEqual([[1, 10]]);
    });
});

