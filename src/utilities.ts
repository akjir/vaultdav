import { normalizePath } from "obsidian";

export const MAX_FILE_SIZE_BYTES: number = 50 * 1024 * 1024;
export const MAX_WALK_DEPTH: number = 64;
export const PLUGIN_DATA_FILE_PATH: string = ".obsidian/plugins/vaultdav/data.json";
export const SYNC_STATE_FILE_PATH: string = ".obsidian/plugins/vaultdav/sync-state.json";

const BACKSLASH_REGEX: RegExp = /\\/g;
const BASE64_CHARS: string = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const CONTROL_CHAR_REGEX: RegExp = /[\x00-\x1f\x7f]/;
const DOTS_ONLY_REGEX: RegExp = /^\.+$/;
const DRIVE_PREFIX_REGEX: RegExp = /^[a-zA-Z]:/;
const FORBIDDEN_OBJECT_KEYS: ReadonlySet<string> = new Set<string>([
    "__proto__",
    "constructor",
    "prototype"
]);
const HTTPS_PROTOCOL_REGEX: RegExp = /^https:\/\//i;
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
const MAX_DATE_TIMESTAMP_MS: number = 8_640_000_000_000_000;
const OBSIDIAN_PLUGINS_PREFIX: string = ".obsidian/plugins/";
const OBSIDIAN_VAULTDAV_DIR: string = ".obsidian/plugins/vaultdav";
const OBSIDIAN_VAULTDAV_PREFIX: string = ".obsidian/plugins/vaultdav/";
const QUERY_OR_HASH_REGEX: RegExp = /[?#]/;
const TRAILING_DOT_OR_SPACE_REGEX: RegExp = /[. ]$/;
const TRAILING_SLASHES_REGEX: RegExp = /\/+$/;
const URI_SCHEME_REGEX: RegExp = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
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
    const normalizedUser: string | null = normalizeUsername(username);
    if (normalizedUser === null) {
        throw new Error("Nextcloud username must not be empty or invalid");
    }
    const normalizedBaseDir: string = normalizeVaultPath(remoteBaseDir);
    if (normalizedBaseDir === "" && !isExplicitRootPath(remoteBaseDir)) {
        throw new Error("Invalid Nextcloud remoteBaseDir");
    }
    const encodedUser: string = encodeURIComponent(normalizedUser);
    const trimmedPathname: string = parsedUrl.pathname.replace(TRAILING_SLASHES_REGEX, "");
    const baseOriginAndPath: string = `${parsedUrl.origin}${trimmedPathname}`;
    const encodedBaseDir: string = encodeWebDavPath(normalizedBaseDir);
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
    const normalizedUser: string | null = normalizeUsername(username);
    if (normalizedUser === null) {
        return null;
    }
    const normalizedBase: string = normalizeVaultPath(remoteBaseDir);
    if (normalizedBase === "" && !isExplicitRootPath(remoteBaseDir)) {
        return null;
    }

    let rawPathname: string = href.trim();
    if (rawPathname === "" || rawPathname.startsWith("//")) {
        return null;
    }
    if (URI_SCHEME_REGEX.test(rawPathname)) {
        if (!HTTPS_PROTOCOL_REGEX.test(rawPathname)) {
            return null;
        }
        try {
            const parsedUrl: URL = new URL(rawPathname);
            if (
                parsedUrl.username !== "" ||
                parsedUrl.password !== "" ||
                parsedUrl.search !== "" ||
                parsedUrl.hash !== ""
            ) {
                return null;
            }
            const schemeIdx: number = rawPathname.indexOf("://");
            const afterScheme: string =
                schemeIdx !== -1 ? rawPathname.slice(schemeIdx + 3) : "";
            const slashIdx: number = afterScheme.indexOf("/");
            const rawUrlPath: string =
                slashIdx !== -1 ? afterScheme.slice(slashIdx) : "";
            rawPathname = rawUrlPath !== "" ? rawUrlPath : parsedUrl.pathname;
        } catch {
            return null;
        }
    }
    if (QUERY_OR_HASH_REGEX.test(rawPathname)) {
        return null;
    }

    const decodedSegments: string[] = [];
    for (const part of rawPathname.split("/")) {
        if (part === "") {
            continue;
        }
        if (DOTS_ONLY_REGEX.test(part.trim())) {
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
            const trimmedSub: string = sub.trim();
            if (
                trimmedSub === "" ||
                DOTS_ONLY_REGEX.test(trimmedSub) ||
                TRAILING_DOT_OR_SPACE_REGEX.test(sub) ||
                DRIVE_PREFIX_REGEX.test(trimmedSub) ||
                FORBIDDEN_OBJECT_KEYS.has(trimmedSub.toLowerCase())
            ) {
                return null;
            }
            decodedSegments.push(sub);
        }
    }

    let davIndex: number = -1;
    for (let i: number = 0; i <= decodedSegments.length - 3; i += 1) {
        if (
            decodedSegments[i]?.toLowerCase() === "remote.php" &&
            decodedSegments[i + 1]?.toLowerCase() === "dav"
        ) {
            davIndex = i;
            break;
        }
    }
    if (davIndex === -1) {
        return null;
    }
    if (decodedSegments[davIndex + 2]?.toLowerCase() !== "files") {
        return null;
    }
    const hrefUser: string | undefined = decodedSegments[davIndex + 3];
    if (
        hrefUser === undefined ||
        (hrefUser !== normalizedUser &&
            hrefUser.toLowerCase() !== normalizedUser.toLowerCase())
    ) {
        return null;
    }

    const afterUserSegments: string[] = decodedSegments.slice(davIndex + 4);
    const rawAfterUser: string = afterUserSegments.join("/");
    const afterUser: string =
        rawAfterUser === "" ? "" : normalizeVaultPath(rawAfterUser);
    if (rawAfterUser !== "" && afterUser === "") {
        return null;
    }

    if (normalizedBase === "") {
        return afterUser;
    }

    const baseSegments: string[] = normalizedBase.split("/");
    if (afterUserSegments.length < baseSegments.length) {
        return null;
    }
    for (let i: number = 0; i < baseSegments.length; i += 1) {
        const seg: string | undefined = afterUserSegments[i];
        const baseSeg: string | undefined = baseSegments[i];
        if (
            seg === undefined ||
            baseSeg === undefined ||
            (seg !== baseSeg && seg.toLowerCase() !== baseSeg.toLowerCase())
        ) {
            return null;
        }
    }
    if (afterUserSegments.length === baseSegments.length) {
        return "";
    }
    const relativeRaw: string = afterUserSegments
        .slice(baseSegments.length)
        .join("/");
    const normalizedRel: string = normalizeVaultPath(relativeRaw);
    return normalizedRel === "" ? null : normalizedRel;
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
    if (normalized === "") {
        throw new Error(
            "Conflict path cannot be generated for an empty or invalid path"
        );
    }
    const parent: string = getParentPath(normalized);
    const segments: string[] = normalized.split("/");
    const fileName: string = segments[segments.length - 1] ?? normalized;

    const safeTimestamp: number =
        Number.isFinite(timestamp) &&
        timestamp > 0 &&
        timestamp <= MAX_DATE_TIMESTAMP_MS
            ? Math.floor(timestamp)
            : 0;
    const rawDate: Date = new Date(safeTimestamp);
    const date: Date = Number.isFinite(rawDate.getTime()) ? rawDate : new Date(0);
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

function isExplicitRootPath(path: string): boolean {
    if (CONTROL_CHAR_REGEX.test(path)) {
        return false;
    }
    const trimmed: string = path.trim();
    return trimmed === "" || trimmed === "/";
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

function normalizeUsername(username: string): string | null {
    if (CONTROL_CHAR_REGEX.test(username)) {
        return null;
    }
    const trimmed: string = username.normalize("NFC").trim();
    if (
        trimmed === "" ||
        DOTS_ONLY_REGEX.test(trimmed) ||
        TRAILING_DOT_OR_SPACE_REGEX.test(trimmed) ||
        trimmed.includes("/") ||
        trimmed.includes("\\") ||
        FORBIDDEN_OBJECT_KEYS.has(trimmed.toLowerCase())
    ) {
        return null;
    }
    return trimmed;
}

export function normalizeVaultPath(path: string): string {
    if (CONTROL_CHAR_REGEX.test(path)) {
        return "";
    }
    const trimmed: string = path
        .normalize("NFC")
        .trim()
        .replace(BACKSLASH_REGEX, "/");
    if (trimmed === "" || trimmed === "/" || DOTS_ONLY_REGEX.test(trimmed)) {
        return "";
    }
    for (const rawSegment of trimmed.split("/")) {
        if (rawSegment === "") {
            continue;
        }
        const trimmedSegment: string = rawSegment.trim();
        if (
            trimmedSegment === "" ||
            DOTS_ONLY_REGEX.test(trimmedSegment) ||
            TRAILING_DOT_OR_SPACE_REGEX.test(rawSegment) ||
            DRIVE_PREFIX_REGEX.test(trimmedSegment) ||
            FORBIDDEN_OBJECT_KEYS.has(trimmedSegment.toLowerCase())
        ) {
            return "";
        }
    }
    const normalized: string = normalizePath(trimmed)
        .replace(BACKSLASH_REGEX, "/")
        .replace(LEADING_SLASHES_REGEX, "")
        .replace(TRAILING_SLASHES_REGEX, "");
    if (normalized === "" || normalized === "/" || DOTS_ONLY_REGEX.test(normalized)) {
        return "";
    }
    for (const segment of normalized.split("/")) {
        const trimmedSegment: string = segment.trim();
        if (
            trimmedSegment === "" ||
            DOTS_ONLY_REGEX.test(trimmedSegment) ||
            TRAILING_DOT_OR_SPACE_REGEX.test(segment) ||
            DRIVE_PREFIX_REGEX.test(trimmedSegment) ||
            FORBIDDEN_OBJECT_KEYS.has(trimmedSegment.toLowerCase())
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
