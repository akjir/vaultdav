import { type RequestUrlParam, type RequestUrlResponse, requestUrl } from "obsidian";
import { log } from "../log";
import type { RemoteItem, VaultDavSettings, WebDavRequestOptions } from "../types";
import { util } from "../utilities";
import { buildPropfindBody, parseMultiStatus, parseSingleStat } from "./xml_parser";

const DEFAULT_MAX_RETRIES: number = 3;
const DEFAULT_RETRY_BASE_MS: number = 500;
const OCTET_STREAM_CONTENT_TYPE: string = "application/octet-stream";
const WALK_CONCURRENCY: number = 4;
const XML_CONTENT_TYPE: string = "application/xml; charset=utf-8";

export class WebDavClient {
    private readonly authHeader: string;
    private readonly baseUrl: string;
    private readonly retryBaseMs: number;
    private readonly settings: VaultDavSettings;
    private readonly userRootUrl: string;

    public constructor(
        settings: VaultDavSettings,
        retryBaseMs: number = DEFAULT_RETRY_BASE_MS
    ) {
        this.settings = settings;
        this.authHeader = util.encodeBasicAuth(
            settings.username,
            settings.appPassword
        );
        this.retryBaseMs =
            Number.isFinite(retryBaseMs) && retryBaseMs >= 0
                ? retryBaseMs
                : DEFAULT_RETRY_BASE_MS;
        this.userRootUrl = util.buildNextcloudWebDavBaseUrl(
            settings.url,
            settings.username,
            ""
        );
        this.baseUrl = util.buildNextcloudWebDavBaseUrl(
            settings.url,
            settings.username,
            settings.remoteBaseDir
        );
    }

    public buildResourceUrl(path: string, isDirectory: boolean): string {
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

    public async createDirectory(path: string): Promise<void> {
        const normalizedPath: string = util.normalizeVaultPath(path);
        if (normalizedPath === "") {
            throw new Error("WebDAV MKCOL refused on empty root path");
        }
        if (util.isExcludedPath(normalizedPath)) {
            throw new Error(`WebDAV MKCOL refused on excluded path: ${normalizedPath}`);
        }
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
        const normalizedPath: string = util.normalizeVaultPath(path);
        if (normalizedPath === "") {
            throw new Error("WebDAV DELETE refused on empty root path");
        }
        if (util.isExcludedPath(normalizedPath)) {
            throw new Error(`WebDAV DELETE refused on excluded path: ${normalizedPath}`);
        }
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
        const normalizedPath: string = util.normalizeVaultPath(path);
        if (normalizedPath === "") {
            throw new Error("WebDAV GET refused on empty root path");
        }
        if (util.isExcludedPath(normalizedPath)) {
            throw new Error(`WebDAV GET refused on excluded path: ${normalizedPath}`);
        }
        const response: RequestUrlResponse = await this.requestWithRetry(
            {
                method: "GET",
                path: normalizedPath
            },
            false
        );
        if (response.status === 200) {
            return response.arrayBuffer;
        }
        throw this.formatStatusError("GET", normalizedPath, response.status);
    }

    public async ensureRemoteBaseDir(): Promise<void> {
        const levels: string[] = util.getFolderLevels(this.settings.remoteBaseDir, true);
        if (levels.length === 0) {
            throw new Error("WebDAV remoteBaseDir must not be empty");
        }

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
        if (status === 507) {
            return new Error(
                `WebDAV ${method} ${displayPath} failed (507 Insufficient Storage)`
            );
        }
        return new Error(`WebDAV ${method} ${displayPath} failed (HTTP ${status})`);
    }

    public async listDirectory(dirPath: string): Promise<RemoteItem[]> {
        const response: RequestUrlResponse = await this.requestWithRetry(
            {
                body: buildPropfindBody(),
                contentType: XML_CONTENT_TYPE,
                depth: "1",
                method: "PROPFIND",
                path: dirPath
            },
            true
        );

        if (response.status !== 207 && response.status !== 200) {
            throw this.formatStatusError("PROPFIND", dirPath, response.status);
        }

        return parseMultiStatus(
            response.text,
            this.settings.username,
            this.settings.remoteBaseDir,
            dirPath
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
            const response: RequestUrlResponse = await requestUrl(param);
            if (
                (response.status === 423 || response.status === 429) &&
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

    public async statRemote(
        path: string,
        isDirectory: boolean = false
    ): Promise<RemoteItem | null> {
        const response: RequestUrlResponse = await this.requestWithRetry(
            {
                body: buildPropfindBody(),
                contentType: XML_CONTENT_TYPE,
                depth: "0",
                method: "PROPFIND",
                path
            },
            isDirectory
        );

        if (response.status === 404) {
            return null;
        }
        if (response.status !== 207 && response.status !== 200) {
            throw this.formatStatusError("PROPFIND", path, response.status);
        }

        return parseSingleStat(
            response.text,
            this.settings.username,
            this.settings.remoteBaseDir,
            path
        );
    }

    public async uploadFile(
        path: string,
        content: ArrayBuffer,
        localMtime: number
    ): Promise<RemoteItem> {
        const normalizedPath: string = util.normalizeVaultPath(path);
        if (normalizedPath === "") {
            throw new Error("WebDAV PUT refused on empty root path");
        }
        if (util.isExcludedPath(normalizedPath)) {
            throw new Error(`WebDAV PUT refused on excluded path: ${normalizedPath}`);
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

        const fallbackStat: RemoteItem | null = await this.statRemote(normalizedPath, false);
        if (fallbackStat !== null) {
            return {
                ...fallbackStat,
                mtime: fallbackStat.mtime > 0 ? fallbackStat.mtime : safeMtime
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

    public async walkRemote(): Promise<RemoteItem[]> {
        const discovered: RemoteItem[] = [];
        const seenPaths: Set<string> = new Set<string>();
        const visitedDirs: Set<string> = new Set<string>([""]);
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
                        seenPaths.has(item.path) ||
                        depth > util.MAX_WALK_DEPTH
                    ) {
                        continue;
                    }
                    seenPaths.add(item.path);
                    discovered.push(item);
                    if (
                        item.isDirectory &&
                        !visitedDirs.has(item.path) &&
                        depth < util.MAX_WALK_DEPTH
                    ) {
                        visitedDirs.add(item.path);
                        currentQueue.push(item.path);
                    }
                }
            }
        }

        return discovered;
    }
}
