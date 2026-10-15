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
    chunkSizeMB: 10,
    chunkingThresholdMB: 90,
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
});
