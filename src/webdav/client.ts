import { type RequestUrlParam, type RequestUrlResponse, requestUrl } from "obsidian";
import { log } from "../log";
import type { RemoteItem, VaultDavSettings, WebDavRequestOptions } from "../types";
import { util } from "../utilities";
import { buildPropfindBody, parseMultiStatus, parseSingleStat } from "./xml_parser";

export const MAX_CHUNKED_FILE_SIZE_BYTES: number = 1024 * 1024 * 1024;
export const MAX_FILE_SIZE_BYTES: number = util.MAX_FILE_SIZE_BYTES;

const BYTES_PER_MB: number = 1024 * 1024;
const CHUNK_DOWNLOAD_CONCURRENCY: number = 4;
const CHUNK_INDEX_PAD_LENGTH: number = 16;
const CHUNK_UPLOAD_TIMEOUT_MS: number = 60000;
const DEFAULT_CHUNK_SIZE_MB: number = 10;
const DEFAULT_CHUNKING_THRESHOLD_MB: number = 90;
const DEFAULT_MAX_RETRIES: number = 3;
const DEFAULT_RETRY_BASE_MS: number = 500;
const FILES_DAV_MARKER: string = "/remote.php/dav/files/";
const OCTET_STREAM_CONTENT_TYPE: string = "application/octet-stream";
const RETRYABLE_STATUS_CODES: ReadonlySet<number> = new Set<number>([
    423,
    425,
    429,
    503,
    504
]);
const UPLOADS_DAV_MARKER: string = "/remote.php/dav/uploads/";
const WALK_CONCURRENCY: number = 4;
const XML_CONTENT_TYPE: string = "application/xml; charset=utf-8";

export class WebDavClient {
    private readonly authHeader: string;
    private readonly baseUrl: string;
    private readonly retryBaseMs: number;
    private readonly settings: Readonly<VaultDavSettings>;
    private readonly uploadsRootUrl: string;
    private readonly userRootUrl: string;

    public constructor(
        settings: VaultDavSettings,
        retryBaseMs: number = DEFAULT_RETRY_BASE_MS
    ) {
        const frozenSettings: Readonly<VaultDavSettings> = Object.freeze({
            ...settings
        });
        this.settings = frozenSettings;
        this.authHeader = util.encodeBasicAuth(
            frozenSettings.username,
            frozenSettings.appPassword
        );
        this.retryBaseMs =
            Number.isFinite(retryBaseMs) && retryBaseMs >= 0
                ? retryBaseMs
                : DEFAULT_RETRY_BASE_MS;
        this.userRootUrl = util.buildNextcloudWebDavBaseUrl(
            frozenSettings.url,
            frozenSettings.username,
            ""
        );
        const markerIndex: number = this.userRootUrl.lastIndexOf(FILES_DAV_MARKER);
        this.uploadsRootUrl =
            markerIndex !== -1
                ? `${this.userRootUrl.slice(0, markerIndex)}${UPLOADS_DAV_MARKER}${this.userRootUrl.slice(markerIndex + FILES_DAV_MARKER.length)}`
                : `${this.userRootUrl}/uploads`;
        this.baseUrl = util.buildNextcloudWebDavBaseUrl(
            frozenSettings.url,
            frozenSettings.username,
            frozenSettings.remoteBaseDir
        );
    }

    private assertValidRemoteBaseDir(): string {
        const normalizedBase: string = util.normalizeVaultPath(
            this.settings.remoteBaseDir
        );
        if (normalizedBase === "") {
            throw new Error("WebDAV remoteBaseDir must not be empty");
        }
        if (util.isExcludedPath(normalizedBase)) {
            throw new Error(
                `WebDAV remoteBaseDir refused on excluded path: ${normalizedBase}`
            );
        }
        return normalizedBase;
    }

    public buildResourceUrl(path: string, isDirectory: boolean): string {
        this.assertValidRemoteBaseDir();
        const encodedRel: string = util.encodeWebDavPath(path);
        const rawUrl: string =
            encodedRel === "" ? this.baseUrl : `${this.baseUrl}/${encodedRel}`;
        if (isDirectory && !rawUrl.endsWith("/")) {
            return `${rawUrl}/`;
        }
        return rawUrl;
    }

    public async checkConnection(): Promise<boolean> {
        await this.ensureRemoteBaseDir();
        const rootStat: RemoteItem | null = await this.statRemote("", true);
        return rootStat !== null && rootStat.isDirectory;
    }

    private async cleanupTransferDir(
        transferDirUrl: string,
        normalizedPath: string
    ): Promise<void> {
        try {
            await this.requestWithRetry(
                {
                    method: "DELETE",
                    path: normalizedPath,
                    timeoutMs: CHUNK_UPLOAD_TIMEOUT_MS
                },
                true,
                transferDirUrl
            );
        } catch (cleanupErr: unknown) {
            log.warn(
                `Failed to clean up aborted chunked upload directory for ${normalizedPath}`,
                cleanupErr
            );
        }
    }

    public async createDirectory(path: string): Promise<void> {
        const normalizedPath: string = this.resolveScopedPath(path, false, "MKCOL");
        const response: RequestUrlResponse = await this.requestWithRetry(
            {
                method: "MKCOL",
                path: normalizedPath
            },
            true
        );
        if (response.status === 201 || response.status === 405) {
            return;
        }
        throw this.formatStatusError("MKCOL", normalizedPath, response.status);
    }

    public async deleteItem(path: string, isDirectory: boolean): Promise<void> {
        const normalizedPath: string = this.resolveScopedPath(
            path,
            false,
            "DELETE"
        );
        const response: RequestUrlResponse = await this.requestWithRetry(
            {
                method: "DELETE",
                path: normalizedPath
            },
            isDirectory
        );
        if (
            response.status === 200 ||
            response.status === 204 ||
            response.status === 404
        ) {
            return;
        }
        throw this.formatStatusError("DELETE", normalizedPath, response.status);
    }

    public async downloadFile(path: string): Promise<ArrayBuffer> {
        const normalizedPath: string = this.resolveScopedPath(path, false, "GET");
        const response: RequestUrlResponse = await this.requestWithRetry(
            {
                method: "GET",
                path: normalizedPath
            },
            false
        );
        if (response.status === 200) {
            const byteLength: number = response.arrayBuffer.byteLength;
            if (byteLength > MAX_FILE_SIZE_BYTES) {
                log.warn(
                    `Skipping download for oversized file (${byteLength} bytes exceeds ${MAX_FILE_SIZE_BYTES} bytes): ${normalizedPath}`
                );
                throw new Error(
                    `WebDAV GET refused on oversized file (${byteLength} bytes exceeds ${MAX_FILE_SIZE_BYTES} bytes): ${normalizedPath}`
                );
            }
            return response.arrayBuffer;
        }
        throw this.formatStatusError("GET", normalizedPath, response.status);
    }

    public async downloadFileChunked(
        path: string,
        totalSize: number,
        onProgress?: (completedChunks: number, totalChunks: number) => void
    ): Promise<ArrayBuffer> {
        const normalizedPath: string = this.resolveScopedPath(path, false, "GET");
        if (!Number.isFinite(totalSize) || totalSize < 0) {
            throw new Error(`Invalid file size for chunked download: ${totalSize}`);
        }
        if (totalSize > MAX_CHUNKED_FILE_SIZE_BYTES) {
            throw new Error(
                `WebDAV GET refused on oversized chunked file (${totalSize} bytes exceeds ${MAX_CHUNKED_FILE_SIZE_BYTES} bytes): ${normalizedPath}`
            );
        }
        const safeTotalSize: number = Math.floor(totalSize);
        if (safeTotalSize === 0) {
            return new ArrayBuffer(0);
        }

        const chunkSizeBytes: number = this.getChunkSizeBytes();
        const totalChunks: number = Math.ceil(safeTotalSize / chunkSizeBytes);
        const assembled: Uint8Array<ArrayBuffer> = new Uint8Array(safeTotalSize);
        let completedChunks: number = 0;

        const tasks: Array<() => Promise<void>> = [];
        for (let i: number = 0; i < totalChunks; i += 1) {
            const start: number = i * chunkSizeBytes;
            const end: number = Math.min(
                start + chunkSizeBytes - 1,
                safeTotalSize - 1
            );
            const expectedLength: number = end - start + 1;

            tasks.push(async (): Promise<void> => {
                const response: RequestUrlResponse = await this.requestWithRetry(
                    {
                        headers: {
                            Range: `bytes=${start}-${end}`
                        },
                        method: "GET",
                        path: normalizedPath
                    },
                    false
                );
                if (response.status !== 206 && response.status !== 200) {
                    throw this.formatStatusError(
                        "GET",
                        normalizedPath,
                        response.status
                    );
                }
                const chunkBytes: Uint8Array = new Uint8Array(response.arrayBuffer);
                if (response.status === 206) {
                    if (chunkBytes.byteLength !== expectedLength) {
                        throw new Error(
                            `WebDAV GET ${normalizedPath} returned unexpected chunk length (${chunkBytes.byteLength} bytes, expected ${expectedLength} bytes)`
                        );
                    }
                    assembled.set(chunkBytes, start);
                } else {
                    if (chunkBytes.byteLength !== safeTotalSize) {
                        throw new Error(
                            `WebDAV GET ${normalizedPath} returned unexpected full body length (${chunkBytes.byteLength} bytes, expected ${safeTotalSize} bytes)`
                        );
                    }
                    assembled.set(chunkBytes.subarray(start, end + 1), start);
                }
                completedChunks += 1;
                onProgress?.(completedChunks, totalChunks);
            });
        }

        await util.runConcurrent(tasks, CHUNK_DOWNLOAD_CONCURRENCY);
        return assembled.buffer;
    }

    public async ensureRemoteBaseDir(): Promise<void> {
        const normalizedBaseDir: string = this.assertValidRemoteBaseDir();
        const levels: string[] = util.getFolderLevels(normalizedBaseDir, true);

        for (const levelPath of levels) {
            const encodedLevel: string = util.encodeWebDavPath(levelPath);
            const targetUrl: string = `${this.userRootUrl}/${encodedLevel}/`;

            const propfindResp: RequestUrlResponse = await this.requestWithRetry(
                {
                    body: buildPropfindBody(),
                    contentType: XML_CONTENT_TYPE,
                    depth: "0",
                    method: "PROPFIND",
                    path: levelPath
                },
                true,
                targetUrl
            );

            if (propfindResp.status === 207 || propfindResp.status === 200) {
                if (propfindResp.text.trim() !== "") {
                    const item: RemoteItem | null = parseSingleStat(
                        propfindResp.text,
                        this.settings.username,
                        "",
                        levelPath
                    );
                    if (item !== null && !item.isDirectory) {
                        throw new Error(
                            `WebDAV PROPFIND ${levelPath} failed (remote path is not a directory)`
                        );
                    }
                }
                continue;
            }
            if (propfindResp.status === 404) {
                const mkcolResp: RequestUrlResponse = await this.requestWithRetry(
                    {
                        method: "MKCOL",
                        path: levelPath
                    },
                    true,
                    targetUrl
                );
                if (mkcolResp.status !== 201 && mkcolResp.status !== 405) {
                    throw this.formatStatusError("MKCOL", levelPath, mkcolResp.status);
                }
                continue;
            }
            throw this.formatStatusError("PROPFIND", levelPath, propfindResp.status);
        }
    }

    private async executeRequest(
        param: RequestUrlParam,
        method: string,
        path: string,
        timeoutMs?: number
    ): Promise<RequestUrlResponse> {
        if (
            timeoutMs === undefined ||
            !Number.isFinite(timeoutMs) ||
            timeoutMs <= 0
        ) {
            return await requestUrl(param);
        }
        let timerId: ReturnType<typeof setTimeout> | null = null;
        try {
            return await Promise.race([
                requestUrl(param),
                new Promise<never>(
                    (_resolve, reject: (reason?: unknown) => void) => {
                        timerId = setTimeout(() => {
                            reject(
                                new Error(
                                    `WebDAV ${method} ${path} timed out after ${timeoutMs}ms`
                                )
                            );
                        }, timeoutMs);
                    }
                )
            ]);
        } finally {
            if (timerId !== null) {
                clearTimeout(timerId);
            }
        }
    }

    public extractHeaderEtag(
        headers: Record<string, string> | null | undefined
    ): string {
        if (headers === null || headers === undefined) {
            return "";
        }
        for (const [key, value] of Object.entries(headers)) {
            const lower: string = key.toLowerCase();
            if (lower === "etag" || lower === "oc-etag") {
                const normalized: string = util.normalizeEtag(value);
                if (normalized !== "") {
                    return normalized;
                }
            }
        }
        return "";
    }

    public formatStatusError(method: string, path: string, status: number): Error {
        const displayPath: string = path === "" ? "/" : path;
        if (status === 401) {
            return new Error(`WebDAV ${method} ${displayPath} failed (401 Unauthorized)`);
        }
        if (status === 403) {
            return new Error(`WebDAV ${method} ${displayPath} failed (403 Forbidden)`);
        }
        if (status === 404) {
            return new Error(`WebDAV ${method} ${displayPath} failed (404 Not Found)`);
        }
        if (status === 409) {
            return new Error(`WebDAV ${method} ${displayPath} failed (409 Conflict)`);
        }
        if (status === 423) {
            return new Error(`WebDAV ${method} ${displayPath} failed (423 Locked)`);
        }
        if (status === 425) {
            return new Error(`WebDAV ${method} ${displayPath} failed (425 Too Early)`);
        }
        if (status === 429) {
            return new Error(
                `WebDAV ${method} ${displayPath} failed (429 Too Many Requests)`
            );
        }
        if (status === 503) {
            return new Error(
                `WebDAV ${method} ${displayPath} failed (503 Service Unavailable)`
            );
        }
        if (status === 504) {
            return new Error(
                `WebDAV ${method} ${displayPath} failed (504 Gateway Timeout)`
            );
        }
        if (status === 507) {
            return new Error(
                `WebDAV ${method} ${displayPath} failed (507 Insufficient Storage)`
            );
        }
        return new Error(`WebDAV ${method} ${displayPath} failed (HTTP ${status})`);
    }

    private generateTransferId(): string {
        if (
            typeof crypto !== "undefined" &&
            typeof crypto.randomUUID === "function"
        ) {
            return crypto.randomUUID();
        }
        const randomSuffix: string = Math.floor(Math.random() * 1e9).toString(36);
        return `${Date.now()}-${randomSuffix}`;
    }

    private getChunkSizeBytes(): number {
        const mb: number = this.settings.chunkSizeMB;
        if (Number.isFinite(mb) && mb > 0) {
            return Math.max(1, Math.floor(mb * BYTES_PER_MB));
        }
        return DEFAULT_CHUNK_SIZE_MB * BYTES_PER_MB;
    }

    private getChunkingThresholdBytes(): number {
        const mb: number = this.settings.chunkingThresholdMB;
        if (Number.isFinite(mb) && mb > 0) {
            return Math.max(1, Math.floor(mb * BYTES_PER_MB));
        }
        return DEFAULT_CHUNKING_THRESHOLD_MB * BYTES_PER_MB;
    }

    public async listDirectory(dirPath: string): Promise<RemoteItem[]> {
        const normalizedDir: string = this.resolveScopedPath(
            dirPath,
            true,
            "PROPFIND"
        );
        const response: RequestUrlResponse = await this.requestWithRetry(
            {
                body: buildPropfindBody(),
                contentType: XML_CONTENT_TYPE,
                depth: "1",
                method: "PROPFIND",
                path: normalizedDir
            },
            true
        );

        if (response.status !== 207 && response.status !== 200) {
            throw this.formatStatusError(
                "PROPFIND",
                normalizedDir,
                response.status
            );
        }

        return parseMultiStatus(
            response.text,
            this.settings.username,
            this.settings.remoteBaseDir,
            normalizedDir
        );
    }

    public async requestWithRetry(
        options: WebDavRequestOptions,
        isDirectory: boolean,
        urlOverride?: string
    ): Promise<RequestUrlResponse> {
        const url: string =
            urlOverride ?? this.buildResourceUrl(options.path, isDirectory);
        const headers: Record<string, string> = {
            Authorization: this.authHeader,
            "Cache-Control": "no-cache",
            ...(options.headers ?? {})
        };
        if (options.depth !== undefined) {
            headers["Depth"] = options.depth;
        }

        const param: RequestUrlParam = {
            body: options.body,
            contentType: options.contentType,
            headers,
            method: options.method,
            throw: false,
            url
        };

        let attempt: number = 0;
        while (true) {
            let response: RequestUrlResponse | null = null;
            try {
                response = await this.executeRequest(
                    param,
                    options.method,
                    options.path,
                    options.timeoutMs
                );
            } catch (err: unknown) {
                const isMockError: boolean =
                    err instanceof Error &&
                    err.message.includes("requestUrl must be mocked");
                if (!isMockError && attempt < DEFAULT_MAX_RETRIES) {
                    const waitMs: number = this.retryBaseMs * Math.pow(2, attempt);
                    log.debug(
                        `Retrying ${options.method} ${options.path} after request error (${waitMs}ms)`
                    );
                    await util.delay(waitMs);
                    attempt += 1;
                    continue;
                }
                throw err;
            }
            if (
                RETRYABLE_STATUS_CODES.has(response.status) &&
                attempt < DEFAULT_MAX_RETRIES
            ) {
                const waitMs: number = this.retryBaseMs * Math.pow(2, attempt);
                log.debug(
                    `Retrying ${options.method} ${options.path} after HTTP ${response.status} (${waitMs}ms)`
                );
                await util.delay(waitMs);
                attempt += 1;
                continue;
            }
            return response;
        }
    }

    private resolveScopedPath(
        path: string,
        allowRoot: boolean,
        method: string
    ): string {
        this.assertValidRemoteBaseDir();
        const trimmed: string = path.trim();
        const isExplicitRoot: boolean = trimmed === "" || trimmed === "/";
        const normalizedPath: string = util.normalizeVaultPath(path);
        if (normalizedPath === "") {
            if (allowRoot && isExplicitRoot) {
                return "";
            }
            throw new Error(`WebDAV ${method} refused on empty root path`);
        }
        if (util.isExcludedPath(normalizedPath)) {
            throw new Error(
                `WebDAV ${method} refused on excluded path: ${normalizedPath}`
            );
        }
        return normalizedPath;
    }

    public async statRemote(
        path: string,
        isDirectory: boolean = false
    ): Promise<RemoteItem | null> {
        const normalizedPath: string = this.resolveScopedPath(
            path,
            true,
            "PROPFIND"
        );
        const response: RequestUrlResponse = await this.requestWithRetry(
            {
                body: buildPropfindBody(),
                contentType: XML_CONTENT_TYPE,
                depth: "0",
                method: "PROPFIND",
                path: normalizedPath
            },
            isDirectory
        );

        if (response.status === 404) {
            return null;
        }
        if (response.status !== 207 && response.status !== 200) {
            throw this.formatStatusError(
                "PROPFIND",
                normalizedPath,
                response.status
            );
        }

        return parseSingleStat(
            response.text,
            this.settings.username,
            this.settings.remoteBaseDir,
            normalizedPath
        );
    }

    public async uploadFile(
        path: string,
        content: ArrayBuffer,
        localMtime: number
    ): Promise<RemoteItem> {
        const normalizedPath: string = this.resolveScopedPath(path, false, "PUT");
        const maxSingleUploadBytes: number = this.getChunkingThresholdBytes();
        if (content.byteLength > maxSingleUploadBytes) {
            log.warn(
                `Skipping upload for oversized file (${content.byteLength} bytes exceeds ${maxSingleUploadBytes} bytes): ${normalizedPath}`
            );
            throw new Error(
                `WebDAV PUT refused on oversized file (${content.byteLength} bytes exceeds ${maxSingleUploadBytes} bytes): ${normalizedPath}`
            );
        }
        const safeMtime: number =
            Number.isFinite(localMtime) && localMtime > 0
                ? util.toSecondPrecision(localMtime)
                : util.toSecondPrecision(Date.now());
        const mtimeSeconds: number = Math.floor(safeMtime / 1000);
        const response: RequestUrlResponse = await this.requestWithRetry(
            {
                body: content,
                contentType: OCTET_STREAM_CONTENT_TYPE,
                headers: {
                    "X-OC-Mtime": String(mtimeSeconds)
                },
                method: "PUT",
                path: normalizedPath
            },
            false
        );

        if (
            response.status !== 200 &&
            response.status !== 201 &&
            response.status !== 204
        ) {
            throw this.formatStatusError("PUT", normalizedPath, response.status);
        }

        const headerEtag: string = this.extractHeaderEtag(response.headers);
        if (headerEtag !== "") {
            return {
                etag: headerEtag,
                href: this.buildResourceUrl(normalizedPath, false),
                isDirectory: false,
                mtime: safeMtime,
                path: normalizedPath,
                size: content.byteLength
            };
        }

        const fallbackStat: RemoteItem | null = await this.statRemote(
            normalizedPath,
            false
        );
        if (fallbackStat !== null && !fallbackStat.isDirectory) {
            return {
                ...fallbackStat,
                etag: util.normalizeEtag(fallbackStat.etag),
                mtime:
                    fallbackStat.mtime > 0
                        ? util.toSecondPrecision(fallbackStat.mtime)
                        : safeMtime
            };
        }

        return {
            etag: "",
            href: this.buildResourceUrl(normalizedPath, false),
            isDirectory: false,
            mtime: safeMtime,
            path: normalizedPath,
            size: content.byteLength
        };
    }

    public async uploadFileChunked(
        path: string,
        content: ArrayBuffer,
        localMtime: number,
        onProgress?: (completedChunks: number, totalChunks: number) => void
    ): Promise<RemoteItem> {
        const normalizedPath: string = this.resolveScopedPath(path, false, "PUT");
        if (content.byteLength > MAX_CHUNKED_FILE_SIZE_BYTES) {
            throw new Error(
                `WebDAV PUT refused on oversized chunked file (${content.byteLength} bytes exceeds ${MAX_CHUNKED_FILE_SIZE_BYTES} bytes): ${normalizedPath}`
            );
        }

        const safeMtime: number =
            Number.isFinite(localMtime) && localMtime > 0
                ? util.toSecondPrecision(localMtime)
                : util.toSecondPrecision(Date.now());
        const mtimeSeconds: number = Math.floor(safeMtime / 1000);

        const transferId: string = this.generateTransferId();
        const transferDirUrl: string = `${this.uploadsRootUrl}/${transferId}`;

        const mkcolResp: RequestUrlResponse = await this.requestWithRetry(
            {
                method: "MKCOL",
                path: normalizedPath,
                timeoutMs: CHUNK_UPLOAD_TIMEOUT_MS
            },
            true,
            transferDirUrl
        );
        if (mkcolResp.status !== 201 && mkcolResp.status !== 405) {
            throw this.formatStatusError("MKCOL", normalizedPath, mkcolResp.status);
        }

        const chunkSizeBytes: number = this.getChunkSizeBytes();
        const totalBytes: number = content.byteLength;
        const totalChunks: number =
            totalBytes === 0 ? 1 : Math.ceil(totalBytes / chunkSizeBytes);
        const destinationUrl: string = this.buildResourceUrl(normalizedPath, false);
        let moveResp: RequestUrlResponse | null = null;

        try {
            for (
                let chunkIndex: number = 0;
                chunkIndex < totalChunks;
                chunkIndex += 1
            ) {
                const start: number = chunkIndex * chunkSizeBytes;
                const end: number = Math.min(start + chunkSizeBytes, totalBytes);
                const chunkBuffer: ArrayBuffer = content.slice(start, end);
                const paddedIndex: string = String(chunkIndex + 1).padStart(
                    CHUNK_INDEX_PAD_LENGTH,
                    "0"
                );
                const chunkUrl: string = `${transferDirUrl}/${paddedIndex}`;
                const putResp: RequestUrlResponse = await this.requestWithRetry(
                    {
                        body: chunkBuffer,
                        contentType: OCTET_STREAM_CONTENT_TYPE,
                        method: "PUT",
                        path: normalizedPath,
                        timeoutMs: CHUNK_UPLOAD_TIMEOUT_MS
                    },
                    false,
                    chunkUrl
                );
                if (
                    putResp.status !== 200 &&
                    putResp.status !== 201 &&
                    putResp.status !== 204
                ) {
                    throw this.formatStatusError(
                        "PUT",
                        normalizedPath,
                        putResp.status
                    );
                }
                onProgress?.(chunkIndex + 1, totalChunks);
            }

            const assembleUrl: string = `${transferDirUrl}/.file`;
            moveResp = await this.requestWithRetry(
                {
                    headers: {
                        Destination: destinationUrl,
                        Overwrite: "T",
                        "X-OC-Mtime": String(mtimeSeconds)
                    },
                    method: "MOVE",
                    path: normalizedPath,
                    timeoutMs: CHUNK_UPLOAD_TIMEOUT_MS
                },
                false,
                assembleUrl
            );
            if (
                moveResp.status !== 200 &&
                moveResp.status !== 201 &&
                moveResp.status !== 204
            ) {
                throw this.formatStatusError(
                    "MOVE",
                    normalizedPath,
                    moveResp.status
                );
            }
        } catch (err: unknown) {
            await this.cleanupTransferDir(transferDirUrl, normalizedPath);
            throw err;
        }

        const headerEtag: string = this.extractHeaderEtag(moveResp.headers);
        if (headerEtag !== "") {
            return {
                etag: headerEtag,
                href: destinationUrl,
                isDirectory: false,
                mtime: safeMtime,
                path: normalizedPath,
                size: totalBytes
            };
        }

        const fallbackStat: RemoteItem | null = await this.statRemote(
            normalizedPath,
            false
        );
        if (fallbackStat !== null && !fallbackStat.isDirectory) {
            return {
                ...fallbackStat,
                etag: util.normalizeEtag(fallbackStat.etag),
                mtime:
                    fallbackStat.mtime > 0
                        ? util.toSecondPrecision(fallbackStat.mtime)
                        : safeMtime
            };
        }

        return {
            etag: "",
            href: destinationUrl,
            isDirectory: false,
            mtime: safeMtime,
            path: normalizedPath,
            size: totalBytes
        };
    }

    public async walkRemote(): Promise<RemoteItem[]> {
        const discovered: RemoteItem[] = [];
        const seenLowerPaths: Map<string, string> = new Map<string, string>();
        const visitedLowerDirs: Set<string> = new Set<string>([""]);
        let currentQueue: string[] = [""];

        while (currentQueue.length > 0) {
            const batch: string[] = currentQueue;
            currentQueue = [];

            const tasks: Array<() => Promise<RemoteItem[]>> = batch.map(
                (dirPath: string) => async (): Promise<RemoteItem[]> => {
                    return await this.listDirectory(dirPath);
                }
            );

            const batchResults: RemoteItem[][] = await util.runConcurrent(
                tasks,
                WALK_CONCURRENCY
            );

            for (const children of batchResults) {
                for (const item of children) {
                    const depth: number = util.getPathDepth(item.path);
                    if (
                        item.path === "" ||
                        util.isExcludedPath(item.path) ||
                        depth > util.MAX_WALK_DEPTH
                    ) {
                        continue;
                    }
                    const lowerPath: string = item.path.toLowerCase();
                    const existingPath: string | undefined = seenLowerPaths.get(lowerPath);
                    if (existingPath !== undefined) {
                        if (existingPath !== item.path) {
                            log.warn(
                                `Skipping case-colliding remote path: ${item.path} (collides with ${existingPath})`
                            );
                        }
                        continue;
                    }
                    seenLowerPaths.set(lowerPath, item.path);
                    discovered.push(item);
                    if (
                        item.isDirectory &&
                        !visitedLowerDirs.has(lowerPath) &&
                        depth < util.MAX_WALK_DEPTH
                    ) {
                        visitedLowerDirs.add(lowerPath);
                        currentQueue.push(item.path);
                    }
                }
            }
        }

        return discovered;
    }
}
