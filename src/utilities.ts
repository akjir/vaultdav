import { normalizePath } from "obsidian";

export const MAX_FILE_SIZE_BYTES: number = 50 * 1024 * 1024;
export const MAX_WALK_DEPTH: number = 64;
export const PLUGIN_DATA_FILE_PATH: string = ".obsidian/plugins/vaultdav/data.json";
export const SYNC_STATE_FILE_PATH: string = ".obsidian/plugins/vaultdav/sync-state.json";

const BACKSLASH_REGEX: RegExp = /\\/g;
const BASE64_CHARS: string = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const CONTROL_CHAR_REGEX: RegExp = /[\x00-\x1f\x7f]/;
const DRIVE_PREFIX_REGEX: RegExp = /^[a-zA-Z]:/;
const FORBIDDEN_OBJECT_KEYS: ReadonlySet<string> = new Set<string>([
    "__proto__",
    "constructor",
    "prototype"
]);
const HTTP_PROTOCOL_REGEX: RegExp = /^https?:\/\//i;
const IGNORED_SEGMENTS_LOWER: ReadonlySet<string> = new Set<string>([
    ".ds_store",
    ".git",
    ".svn",
    ".trash",
    "desktop.ini",
    "node_modules",
    "thumbs.db"
]);
const LEADING_SLASHES_REGEX: RegExp = /^\/+/;
const OBSIDIAN_PLUGINS_PREFIX: string = ".obsidian/plugins/";
const OBSIDIAN_VAULTDAV_DIR: string = ".obsidian/plugins/vaultdav";
const OBSIDIAN_VAULTDAV_PREFIX: string = ".obsidian/plugins/vaultdav/";
const QUERY_OR_HASH_REGEX: RegExp = /[?#]/;
const TRAILING_SLASHES_REGEX: RegExp = /\/+$/;
const WORKSPACE_FILE_REGEX: RegExp = /^\.obsidian\/workspace[^/]*\.json$/i;

export function areArrayBuffersEqual(a: ArrayBuffer, b: ArrayBuffer): boolean {
    if (a === b) {
        return true;
    }
    if (a.byteLength !== b.byteLength) {
        return false;
    }
    const viewA: Uint8Array = new Uint8Array(a);
    const viewB: Uint8Array = new Uint8Array(b);
    for (let i: number = 0; i < viewA.byteLength; i += 1) {
        if (viewA[i] !== viewB[i]) {
            return false;
        }
    }
    return true;
}

export function buildNextcloudWebDavBaseUrl(
    url: string,
    username: string,
    remoteBaseDir: string
): string {
    const rawUrl: string = url.trim();
    let parsedUrl: URL | null = null;
    try {
        parsedUrl = new URL(rawUrl);
    } catch {
        throw new Error("Invalid Nextcloud server URL");
    }
    if (parsedUrl.protocol !== "https:") {
        throw new Error("Nextcloud server URL must use HTTPS");
    }
    if (parsedUrl.username !== "" || parsedUrl.password !== "") {
        throw new Error("Nextcloud server URL must not contain embedded credentials");
    }
    if (parsedUrl.search !== "" || parsedUrl.hash !== "") {
        throw new Error("Nextcloud server URL must not contain query or hash parameters");
    }
    const trimmedUser: string = username.trim();
    if (trimmedUser === "") {
        throw new Error("Nextcloud username must not be empty");
    }
    const encodedUser: string = encodeURIComponent(trimmedUser);
    const trimmedPathname: string = parsedUrl.pathname.replace(TRAILING_SLASHES_REGEX, "");
    const baseOriginAndPath: string = `${parsedUrl.origin}${trimmedPathname}`;
    const encodedBaseDir: string = encodeWebDavPath(remoteBaseDir);
    const davMarker: string = "/remote.php/dav/files";
    const markerWithSlash: string = `${davMarker}/`;
    const markerIndex: number = baseOriginAndPath.indexOf(markerWithSlash);

    let userRootUrl: string = "";
    if (markerIndex !== -1) {
        const prefix: string = baseOriginAndPath.slice(
            0,
            markerIndex + markerWithSlash.length
        );
        userRootUrl = `${prefix}${encodedUser}`;
    } else if (baseOriginAndPath.endsWith(davMarker)) {
        userRootUrl = `${baseOriginAndPath}/${encodedUser}`;
    } else {
        userRootUrl = `${baseOriginAndPath}${markerWithSlash}${encodedUser}`;
    }

    if (encodedBaseDir === "") {
        return userRootUrl;
    }
    return `${userRootUrl}/${encodedBaseDir}`;
}

export function decodeWebDavHref(
    href: string,
    username: string,
    remoteBaseDir: string
): string | null {
    if (CONTROL_CHAR_REGEX.test(href)) {
        return null;
    }
    const trimmedUser: string = username.trim();
    if (trimmedUser === "") {
        return null;
    }

    let rawPathname: string = href.trim();
    if (HTTP_PROTOCOL_REGEX.test(rawPathname)) {
        try {
            const parsedUrl: URL = new URL(rawPathname);
            if (parsedUrl.username !== "" || parsedUrl.password !== "") {
                return null;
            }
            const schemeIdx: number = rawPathname.indexOf("://");
            const afterScheme: string =
                schemeIdx !== -1 ? rawPathname.slice(schemeIdx + 3) : "";
            const slashIdx: number = afterScheme.indexOf("/");
            const rawUrlPath: string =
                slashIdx !== -1
                    ? (afterScheme.slice(slashIdx).split(QUERY_OR_HASH_REGEX)[0] ?? "")
                    : "";
            rawPathname = rawUrlPath !== "" ? rawUrlPath : parsedUrl.pathname;
        } catch {
            return null;
        }
    }

    const decodedSegments: string[] = [];
    for (const part of rawPathname.split("/")) {
        if (part === "") {
            continue;
        }
        if (part === "." || part === "..") {
            return null;
        }
        let decodedPart: string = "";
        try {
            decodedPart = decodeURIComponent(part);
        } catch {
            return null;
        }
        if (CONTROL_CHAR_REGEX.test(decodedPart)) {
            return null;
        }
        const subSegments: string[] = decodedPart
            .normalize("NFC")
            .replace(BACKSLASH_REGEX, "/")
            .split("/");
        for (const sub of subSegments) {
            if (
                sub === "" ||
                sub === "." ||
                sub === ".." ||
                DRIVE_PREFIX_REGEX.test(sub) ||
                FORBIDDEN_OBJECT_KEYS.has(sub.toLowerCase())
            ) {
                return null;
            }
            decodedSegments.push(sub);
        }
    }

    const decodedFull: string = `/${decodedSegments.join("/")}`;
    const davPrefix: string = `/remote.php/dav/files/${trimmedUser}`;
    let prefixIndex: number = decodedFull.indexOf(davPrefix);
    let prefixEndLength: number = davPrefix.length;
    if (prefixIndex === -1) {
        const lowerFull: string = decodedFull.toLowerCase();
        const lowerPrefix: string = davPrefix.toLowerCase();
        prefixIndex = lowerFull.indexOf(lowerPrefix);
        prefixEndLength = lowerPrefix.length;
    }
    if (prefixIndex === -1) {
        return null;
    }

    const scopedPath: string = decodedFull.slice(prefixIndex);
    if (
        scopedPath.length !== prefixEndLength &&
        scopedPath[prefixEndLength] !== "/"
    ) {
        return null;
    }

    const rawAfterUser: string = scopedPath.slice(prefixEndLength);
    const afterUser: string = normalizeVaultPath(rawAfterUser);
    if (rawAfterUser !== "" && rawAfterUser !== "/" && afterUser === "") {
        return null;
    }
    const normalizedBase: string = normalizeVaultPath(remoteBaseDir);

    if (normalizedBase === "") {
        return afterUser;
    }
    const lowerAfterUser: string = afterUser.toLowerCase();
    const lowerBase: string = normalizedBase.toLowerCase();
    if (afterUser === normalizedBase || lowerAfterUser === lowerBase) {
        return "";
    }
    if (
        afterUser.startsWith(`${normalizedBase}/`) ||
        lowerAfterUser.startsWith(`${lowerBase}/`)
    ) {
        const relativeSlice: string = afterUser.slice(normalizedBase.length + 1);
        const normalizedRel: string = normalizeVaultPath(relativeSlice);
        return normalizedRel === "" ? null : normalizedRel;
    }
    return null;
}

export function delay(ms: number): Promise<void> {
    const safeMs: number = Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : 0;
    return new Promise<void>((resolve: () => void) => {
        setTimeout(resolve, safeMs);
    });
}

export function encodeBasicAuth(username: string, appPassword: string): string {
    const bytes: Uint8Array = new TextEncoder().encode(`${username}:${appPassword}`);
    let result: string = "";
    const len: number = bytes.length;

    for (let i: number = 0; i < len; i += 3) {
        const b0: number = bytes[i] ?? 0;
        const b1: number = i + 1 < len ? (bytes[i + 1] ?? 0) : 0;
        const b2: number = i + 2 < len ? (bytes[i + 2] ?? 0) : 0;

        const triplet: number = (b0 << 16) | (b1 << 8) | b2;
        result += BASE64_CHARS[(triplet >> 18) & 0x3f] ?? "";
        result += BASE64_CHARS[(triplet >> 12) & 0x3f] ?? "";
        result += i + 1 < len ? (BASE64_CHARS[(triplet >> 6) & 0x3f] ?? "") : "=";
        result += i + 2 < len ? (BASE64_CHARS[triplet & 0x3f] ?? "") : "=";
    }

    return `Basic ${result}`;
}

export function encodeWebDavPath(path: string): string {
    const normalized: string = normalizeVaultPath(path);
    if (normalized === "") {
        return "";
    }
    return normalized
        .split("/")
        .map((segment: string) => encodeURIComponent(segment))
        .join("/");
}

export function getConflictPath(
    path: string,
    timestamp: number,
    existingPaths?: ReadonlySet<string>
): string {
    const normalized: string = normalizeVaultPath(path);
    const parent: string = getParentPath(normalized);
    const segments: string[] = normalized.split("/");
    const fileName: string = segments[segments.length - 1] ?? normalized;

    const safeTimestamp: number =
        Number.isFinite(timestamp) && timestamp > 0 ? timestamp : 0;
    const date: Date = new Date(safeTimestamp);
    const yyyy: string = String(date.getUTCFullYear()).padStart(4, "0");
    const mm: string = String(date.getUTCMonth() + 1).padStart(2, "0");
    const dd: string = String(date.getUTCDate()).padStart(2, "0");
    const hh: string = String(date.getUTCHours()).padStart(2, "0");
    const min: string = String(date.getUTCMinutes()).padStart(2, "0");
    const ss: string = String(date.getUTCSeconds()).padStart(2, "0");
    const stamp: string = `${yyyy}${mm}${dd}-${hh}${min}${ss}`;

    const lastDotIndex: number = fileName.lastIndexOf(".");
    let stem: string = fileName;
    let ext: string = "";

    if (lastDotIndex > 0 && lastDotIndex < fileName.length - 1) {
        stem = fileName.slice(0, lastDotIndex);
        ext = fileName.slice(lastDotIndex);
    }

    let counter: number = 1;
    while (true) {
        const suffix: string = counter === 1 ? `conflict-${stamp}` : `conflict-${stamp}-${counter}`;
        const candidateName: string = `${stem}.${suffix}${ext}`;
        const candidatePath: string = parent === "" ? candidateName : `${parent}/${candidateName}`;
        let hasCollision: boolean = false;
        if (existingPaths !== undefined) {
            if (existingPaths.has(candidatePath)) {
                hasCollision = true;
            } else {
                const lowerCandidate: string = candidatePath.toLowerCase();
                for (const existing of existingPaths) {
                    if (existing.toLowerCase() === lowerCandidate) {
                        hasCollision = true;
                        break;
                    }
                }
            }
        }
        if (!hasCollision) {
            return candidatePath;
        }
        counter += 1;
    }
}

export function getFolderLevels(path: string, isDirectory: boolean = false): string[] {
    const normalized: string = normalizeVaultPath(path);
    if (normalized === "") {
        return [];
    }
    const parts: string[] = normalized.split("/");
    const limit: number = isDirectory ? parts.length : parts.length - 1;
    const levels: string[] = [];

    for (let i: number = 1; i <= limit; i += 1) {
        levels.push(parts.slice(0, i).join("/"));
    }
    return levels;
}

export function getParentPath(path: string): string {
    const normalized: string = normalizeVaultPath(path);
    if (normalized === "") {
        return "";
    }
    const lastSlash: number = normalized.lastIndexOf("/");
    if (lastSlash === -1) {
        return "";
    }
    return normalized.slice(0, lastSlash);
}

export function getPathDepth(path: string): number {
    const normalized: string = normalizeVaultPath(path);
    if (normalized === "") {
        return 0;
    }
    return normalized.split("/").length;
}

export function isExcludedPath(path: string): boolean {
    if (CONTROL_CHAR_REGEX.test(path)) {
        return true;
    }
    const normalized: string = normalizeVaultPath(path);
    if (normalized === "") {
        return true;
    }
    const lower: string = normalized.toLowerCase();
    if (
        lower === SYNC_STATE_FILE_PATH ||
        lower === PLUGIN_DATA_FILE_PATH
    ) {
        return true;
    }
    if (
        lower.startsWith(OBSIDIAN_PLUGINS_PREFIX) &&
        (lower === OBSIDIAN_VAULTDAV_DIR ||
            lower.startsWith(OBSIDIAN_VAULTDAV_PREFIX) ||
            lower.endsWith("/data.json") ||
            lower.endsWith("/sync-state.json"))
    ) {
        return true;
    }
    if (WORKSPACE_FILE_REGEX.test(lower)) {
        return true;
    }

    const segments: string[] = lower.split("/");
    for (const segment of segments) {
        if (segment === "." || segment === ".." || IGNORED_SEGMENTS_LOWER.has(segment)) {
            return true;
        }
    }
    return false;
}

export function normalizeEtag(rawEtag: string | null | undefined): string {
    if (rawEtag === undefined || rawEtag === null) {
        return "";
    }
    let cleaned: string = rawEtag.trim();
    if (cleaned.startsWith("W/") || cleaned.startsWith("w/")) {
        cleaned = cleaned.slice(2).trim();
    }
    if (cleaned.startsWith('"') && cleaned.endsWith('"') && cleaned.length >= 2) {
        cleaned = cleaned.slice(1, -1);
    }
    return cleaned;
}

export function normalizeVaultPath(path: string): string {
    if (CONTROL_CHAR_REGEX.test(path)) {
        return "";
    }
    const trimmed: string = path
        .normalize("NFC")
        .trim()
        .replace(BACKSLASH_REGEX, "/");
    if (trimmed === "" || trimmed === "/" || trimmed === ".") {
        return "";
    }
    for (const rawSegment of trimmed.split("/")) {
        if (rawSegment === "") {
            continue;
        }
        if (
            rawSegment === "." ||
            rawSegment === ".." ||
            DRIVE_PREFIX_REGEX.test(rawSegment) ||
            FORBIDDEN_OBJECT_KEYS.has(rawSegment.toLowerCase())
        ) {
            return "";
        }
    }
    const normalized: string = normalizePath(trimmed)
        .replace(BACKSLASH_REGEX, "/")
        .replace(LEADING_SLASHES_REGEX, "")
        .replace(TRAILING_SLASHES_REGEX, "");
    if (normalized === "" || normalized === "/" || normalized === ".") {
        return "";
    }
    for (const segment of normalized.split("/")) {
        if (
            segment === "" ||
            segment === "." ||
            segment === ".." ||
            DRIVE_PREFIX_REGEX.test(segment) ||
            FORBIDDEN_OBJECT_KEYS.has(segment.toLowerCase())
        ) {
            return "";
        }
    }
    return normalized;
}

export async function runConcurrent<T>(
    tasks: ReadonlyArray<() => Promise<T>>,
    concurrency: number = 4
): Promise<T[]> {
    const rawConcurrency: number = Number.isFinite(concurrency)
        ? Math.floor(concurrency)
        : 4;
    const safeConcurrency: number = Math.max(1, Math.min(5, rawConcurrency));
    const results: T[] = new Array<T>(tasks.length);
    let nextIndex: number = 0;

    const worker = async (): Promise<void> => {
        while (nextIndex < tasks.length) {
            const currentIndex: number = nextIndex;
            nextIndex += 1;
            const task: (() => Promise<T>) | undefined = tasks[currentIndex];
            if (task !== undefined) {
                results[currentIndex] = await task();
            }
        }
    };

    const workerCount: number = Math.min(safeConcurrency, tasks.length);
    const workers: Promise<void>[] = [];
    for (let i: number = 0; i < workerCount; i += 1) {
        workers.push(worker());
    }
    await Promise.all(workers);
    return results;
}

export function toSecondPrecision(ms: number): number {
    if (!Number.isFinite(ms) || ms <= 0) {
        return 0;
    }
    return Math.floor(ms / 1000) * 1000;
}

export const util = {
    MAX_FILE_SIZE_BYTES,
    MAX_WALK_DEPTH,
    PLUGIN_DATA_FILE_PATH,
    SYNC_STATE_FILE_PATH,
    areArrayBuffersEqual,
    buildNextcloudWebDavBaseUrl,
    decodeWebDavHref,
    delay,
    encodeBasicAuth,
    encodeWebDavPath,
    getConflictPath,
    getFolderLevels,
    getParentPath,
    getPathDepth,
    isExcludedPath,
    normalizeEtag,
    normalizeVaultPath,
    runConcurrent,
    toSecondPrecision
};
