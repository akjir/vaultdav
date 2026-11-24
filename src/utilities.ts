import { normalizePath } from "obsidian";

export const MAX_FILE_SIZE_BYTES: number = 50 * 1024 * 1024;
export const MAX_WALK_DEPTH: number = 64;
export const PLUGIN_DATA_RELATIVE_PATH: string = "plugins/vaultdav/data.json";
export const SYNC_HISTORY_RELATIVE_PATH: string = "plugins/vaultdav/sync-history.json";
export const SYNC_STATE_RELATIVE_PATH: string = "plugins/vaultdav/sync-state.json";

const BACKSLASH_REGEX: RegExp = /\\/g;
const BASE64_CHARS: string = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const CONFLICT_COPY_FILENAME_REGEX: RegExp =
    /^(.+)\.conflict-(\d{8}-\d{6})(?:-\d+)?(\.[^./]+)?$/i;
const DOTS_ONLY_REGEX: RegExp = /^\.+$/;
const EXPLICIT_SCHEME_REGEX: RegExp = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//;
const FORBIDDEN_BARE_SCHEMES_LOWER: ReadonlySet<string> = new Set<string>([
    "about",
    "blob",
    "data",
    "dav",
    "davs",
    "file",
    "ftp",
    "ftps",
    "http",
    "https",
    "javascript",
    "mailto",
    "smb",
    "ssh",
    "tel",
    "vbscript",
    "ws",
    "wss"
]);
const FORBIDDEN_OBJECT_KEYS: ReadonlySet<string> = new Set<string>([
    "__proto__",
    "constructor",
    "prototype"
]);
const HTTP_OR_HTTPS_PROTOCOL_REGEX: RegExp = /^https?:\/\//i;
const IGNORED_SEGMENTS_LOWER: ReadonlySet<string> = new Set<string>([
    "desktop.ini",
    "node_modules",
    "thumbs.db"
]);
const LEADING_SLASHES_REGEX: RegExp = /^\/+/;
const MAX_DATE_TIMESTAMP_MS: number = 8_640_000_000_000_000;
const NEXTCLOUD_ALT_ENDPOINTS_LOWER: ReadonlySet<string> = new Set<string>([
    "index.php",
    "public.php",
    "status.php"
]);
const PORT_DIGITS_REGEX: RegExp = /^\d{1,5}$/;
const QUERY_OR_HASH_REGEX: RegExp = /[?#]/;
const SCHEME_NAME_REGEX: RegExp = /^[a-zA-Z][a-zA-Z0-9+.-]*$/;
const TRAILING_DOT_OR_SPACE_REGEX: RegExp = /[. ]$/;
const TRAILING_SLASHES_REGEX: RegExp = /\/+$/;
const URI_SCHEME_REGEX: RegExp = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const WHITESPACE_CHAR_REGEX: RegExp = /\s/;

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
    const normalizedUrl: string = normalizeServerUrl(url);
    const parsedUrl: URL = parseServerUrl(normalizedUrl);
    if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
        throw new Error("Nextcloud server URL must use HTTP or HTTPS");
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
    const lowerPathname: string = trimmedPathname.toLowerCase();
    const encodedBaseDir: string = encodeWebDavPath(normalizedBaseDir);
    const davFilesMarker: string = "/remote.php/dav/files";
    const davFilesWithSlash: string = `${davFilesMarker}/`;
    const davMarker: string = "/remote.php/dav";
    const webdavMarker: string = "/remote.php/webdav";
    const webdavWithSlash: string = `${webdavMarker}/`;
    const davFilesIndex: number = lowerPathname.indexOf(davFilesWithSlash);
    const webdavIndex: number = lowerPathname.indexOf(webdavWithSlash);

    let prefixPath: string = trimmedPathname;
    if (davFilesIndex !== -1) {
        prefixPath = trimmedPathname.slice(0, davFilesIndex);
    } else if (lowerPathname.endsWith(davFilesMarker)) {
        prefixPath = trimmedPathname.slice(0, -davFilesMarker.length);
    } else if (lowerPathname.endsWith(davMarker)) {
        prefixPath = trimmedPathname.slice(0, -davMarker.length);
    } else if (webdavIndex !== -1) {
        prefixPath = trimmedPathname.slice(0, webdavIndex);
    } else if (lowerPathname.endsWith(webdavMarker)) {
        prefixPath = trimmedPathname.slice(0, -webdavMarker.length);
    }

    const userRootUrl: string = `${parsedUrl.origin}${prefixPath}${davFilesWithSlash}${encodedUser}`;

    if (encodedBaseDir === "") {
        return userRootUrl;
    }
    return `${userRootUrl}/${encodedBaseDir}`;
}

function decodeUriSegment(part: string): string | null {
    try {
        return decodeURIComponent(part);
    } catch {
        return null;
    }
}

export function decodeWebDavHref(
    href: string,
    username: string,
    remoteBaseDir: string
): string | null {
    if (hasControlChars(href)) {
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
    if (
        rawPathname === "" ||
        rawPathname.startsWith("//") ||
        rawPathname.includes("\\")
    ) {
        return null;
    }
    if (URI_SCHEME_REGEX.test(rawPathname)) {
        if (!HTTP_OR_HTTPS_PROTOCOL_REGEX.test(rawPathname)) {
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
            if (schemeIdx === -1) {
                return null;
            }
            const afterScheme: string = rawPathname.slice(schemeIdx + 3);
            const slashIdx: number = afterScheme.indexOf("/");
            if (slashIdx <= 0) {
                return null;
            }
            const rawAuthority: string = afterScheme.slice(0, slashIdx);
            if (
                rawAuthority.includes("@") ||
                QUERY_OR_HASH_REGEX.test(rawAuthority)
            ) {
                return null;
            }
            rawPathname = afterScheme.slice(slashIdx);
        } catch {
            return null;
        }
    } else if (!rawPathname.startsWith("/")) {
        return null;
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
        const decodedPart: string | null = decodeUriSegment(part);
        if (decodedPart === null) {
            return null;
        }
        if (
            hasControlChars(decodedPart) ||
            decodedPart.includes("/") ||
            decodedPart.includes("\\")
        ) {
            return null;
        }
        const normalizedSegment: string = decodedPart.normalize("NFC");
        if (isInvalidPathSegment(normalizedSegment)) {
            return null;
        }
        decodedSegments.push(normalizedSegment);
    }

    let davIndex: number = -1;
    for (let i: number = 0; i < decodedSegments.length; i += 1) {
        const segmentLower: string = decodedSegments[i]?.toLowerCase() ?? "";
        if (NEXTCLOUD_ALT_ENDPOINTS_LOWER.has(segmentLower)) {
            return null;
        }
        if (segmentLower === "remote.php") {
            davIndex = i;
            break;
        }
    }
    if (
        davIndex === -1 ||
        decodedSegments[davIndex + 1]?.toLowerCase() !== "dav" ||
        decodedSegments[davIndex + 2]?.toLowerCase() !== "files"
    ) {
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
        window.setTimeout(resolve, safeMs);
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

function findAuthorityEnd(value: string): number {
    let end: number = value.length;
    for (let i: number = 0; i < value.length; i += 1) {
        const ch: string = value.charAt(i);
        if (ch === "/" || ch === "?" || ch === "#") {
            end = i;
            break;
        }
    }
    return end;
}

export function formatByteSize(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) {
        return "0 B";
    }
    const kb: number = 1024;
    const mb: number = kb * 1024;
    const gb: number = mb * 1024;
    if (bytes < kb) {
        return `${Math.floor(bytes)} B`;
    }
    if (bytes < mb) {
        return `${(bytes / kb).toFixed(1)} KB`;
    }
    if (bytes < gb) {
        return `${(bytes / mb).toFixed(1)} MB`;
    }
    return `${(bytes / gb).toFixed(2)} GB`;
}

export function getConflictPath(
    path: string,
    timestamp: number,
    existingPaths?: ReadonlySet<string>,
    existingLowerPaths?: ReadonlySet<string>
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

    const maxAttempts: number =
        (existingLowerPaths?.size ?? existingPaths?.size ?? 0) + 1;
    let fallbackLowerSet: Set<string> | null = null;
    for (let counter: number = 1; counter <= maxAttempts; counter += 1) {
        const suffix: string =
            counter === 1 ? `conflict-${stamp}` : `conflict-${stamp}-${counter}`;
        const candidateName: string = `${stem}.${suffix}${ext}`;
        const candidatePath: string =
            parent === "" ? candidateName : `${parent}/${candidateName}`;
        let hasCollision: boolean = false;
        if (existingLowerPaths !== undefined) {
            hasCollision = existingLowerPaths.has(candidatePath.toLowerCase());
        } else if (existingPaths !== undefined) {
            if (existingPaths.has(candidatePath)) {
                hasCollision = true;
            } else {
                const lowerCandidate: string = candidatePath.toLowerCase();
                if (fallbackLowerSet === null && counter > 1) {
                    fallbackLowerSet = new Set<string>();
                    for (const existing of existingPaths) {
                        fallbackLowerSet.add(existing.toLowerCase());
                    }
                }
                if (fallbackLowerSet !== null) {
                    hasCollision = fallbackLowerSet.has(lowerCandidate);
                } else {
                    for (const existing of existingPaths) {
                        if (existing.toLowerCase() === lowerCandidate) {
                            hasCollision = true;
                            break;
                        }
                    }
                }
            }
        }
        if (!hasCollision) {
            return candidatePath;
        }
    }
    const fallbackName: string = `${stem}.conflict-${stamp}-${maxAttempts + 1}${ext}`;
    return parent === "" ? fallbackName : `${parent}/${fallbackName}`;
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
    let depth: number = 1;
    for (let i: number = 0; i < normalized.length; i += 1) {
        if (normalized.charCodeAt(i) === 47) {
            depth += 1;
        }
    }
    return depth;
}

export function getPluginDataFilePath(configDir: string): string {
    const normalizedConfigDir: string = normalizeVaultPath(configDir);
    if (normalizedConfigDir === "") {
        throw new Error(`Invalid Obsidian configDir: ${configDir}`);
    }
    return `${normalizedConfigDir}/${PLUGIN_DATA_RELATIVE_PATH}`;
}

export function getSyncHistoryFilePath(configDir: string): string {
    const normalizedConfigDir: string = normalizeVaultPath(configDir);
    if (normalizedConfigDir === "") {
        throw new Error(`Invalid Obsidian configDir: ${configDir}`);
    }
    return `${normalizedConfigDir}/${SYNC_HISTORY_RELATIVE_PATH}`;
}

export function getSyncStateFilePath(configDir: string): string {
    const normalizedConfigDir: string = normalizeVaultPath(configDir);
    if (normalizedConfigDir === "") {
        throw new Error(`Invalid Obsidian configDir: ${configDir}`);
    }
    return `${normalizedConfigDir}/${SYNC_STATE_RELATIVE_PATH}`;
}

export function hasControlChars(value: string): boolean {
    for (let i: number = 0; i < value.length; i += 1) {
        const code: number = value.charCodeAt(i);
        if (code <= 0x1f || code === 0x7f) {
            return true;
        }
    }
    return false;
}

export function isExcludedPath(path: string, configDir: string = ""): boolean {
    if (hasControlChars(path)) {
        return true;
    }
    const normalized: string = normalizeVaultPath(path);
    if (normalized === "") {
        return true;
    }
    const lower: string = normalized.toLowerCase();

    if (configDir !== "") {
        const normalizedConfigDir: string =
            normalizeVaultPath(configDir).toLowerCase();
        if (normalizedConfigDir === "") {
            return true;
        }
        if (
            lower === normalizedConfigDir ||
            lower.startsWith(`${normalizedConfigDir}/`)
        ) {
            return true;
        }
    }

    const segments: string[] = lower.split("/");
    for (const segment of segments) {
        if (
            segment.startsWith(".") ||
            IGNORED_SEGMENTS_LOWER.has(segment)
        ) {
            return true;
        }
    }
    return false;
}

export function isExplicitRootPath(path: string): boolean {
    if (hasControlChars(path)) {
        return false;
    }
    const trimmed: string = path.trim();
    return trimmed === "" || trimmed === "/";
}

function isInvalidPathSegment(segment: string): boolean {
    const trimmedSegment: string = segment.trim();
    return (
        trimmedSegment === "" ||
        trimmedSegment !== segment ||
        DOTS_ONLY_REGEX.test(trimmedSegment) ||
        TRAILING_DOT_OR_SPACE_REGEX.test(segment) ||
        segment.includes(":") ||
        FORBIDDEN_OBJECT_KEYS.has(trimmedSegment.toLowerCase())
    );
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

export function normalizeServerUrl(rawUrl: string): string {
    if (hasControlChars(rawUrl)) {
        throw new Error("Invalid Nextcloud server URL");
    }
    const trimmed: string = rawUrl.trim();
    if (
        trimmed === "" ||
        trimmed.includes("\\") ||
        trimmed.startsWith("/") ||
        trimmed.startsWith(":") ||
        WHITESPACE_CHAR_REGEX.test(trimmed)
    ) {
        throw new Error("Invalid Nextcloud server URL");
    }

    const schemeMatch: RegExpExecArray | null = EXPLICIT_SCHEME_REGEX.exec(trimmed);
    let candidateUrl: string = "";
    let hadExplicitScheme: boolean = false;
    let hasExplicitPort: boolean = false;
    let rawBareHost: string = "";

    if (schemeMatch !== null) {
        const scheme: string = (schemeMatch[1] ?? "").toLowerCase();
        if (scheme !== "http" && scheme !== "https") {
            throw new Error("Nextcloud server URL must use HTTP or HTTPS");
        }
        const afterScheme: string = trimmed.slice(schemeMatch[0].length);
        if (
            afterScheme === "" ||
            afterScheme.startsWith("/") ||
            afterScheme.startsWith("?") ||
            afterScheme.startsWith("#")
        ) {
            throw new Error("Invalid Nextcloud server URL");
        }
        candidateUrl = `${scheme}://${afterScheme}`;
        hadExplicitScheme = true;
    } else {
        const authorityEnd: number = findAuthorityEnd(trimmed);
        const authority: string = trimmed.slice(0, authorityEnd);
        if (authority === "") {
            throw new Error("Invalid Nextcloud server URL");
        }
        if (authority.startsWith("[")) {
            rawBareHost = authority;
            candidateUrl = `https://${trimmed}`;
        } else {
            const colonIndex: number = authority.indexOf(":");
            if (colonIndex !== -1) {
                const beforeColon: string = authority.slice(0, colonIndex);
                const afterColon: string = authority.slice(colonIndex + 1);
                const beforeColonLower: string = beforeColon.toLowerCase();
                if (
                    beforeColon === "" ||
                    beforeColonLower === "http" ||
                    beforeColonLower === "https"
                ) {
                    throw new Error("Invalid Nextcloud server URL");
                }
                if (FORBIDDEN_BARE_SCHEMES_LOWER.has(beforeColonLower)) {
                    throw new Error("Nextcloud server URL must use HTTP or HTTPS");
                }
                if (PORT_DIGITS_REGEX.test(afterColon)) {
                    const portNumber: number = Number.parseInt(afterColon, 10);
                    if (portNumber < 1 || portNumber > 65535) {
                        throw new Error("Invalid Nextcloud server URL");
                    }
                    rawBareHost = beforeColon;
                    hasExplicitPort = true;
                    candidateUrl = `https://${trimmed}`;
                } else if (afterColon.includes("@")) {
                    throw new Error(
                        "Nextcloud server URL must not contain embedded credentials"
                    );
                } else if (
                    SCHEME_NAME_REGEX.test(beforeColon) &&
                    !beforeColon.includes(".")
                ) {
                    throw new Error("Nextcloud server URL must use HTTP or HTTPS");
                } else {
                    throw new Error("Invalid Nextcloud server URL");
                }
            } else {
                rawBareHost = authority;
                candidateUrl = `https://${trimmed}`;
            }
        }
    }

    const parsedUrl: URL = parseServerUrl(candidateUrl);
    if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
        throw new Error("Nextcloud server URL must use HTTP or HTTPS");
    }
    const schemeSeparatorIndex: number = candidateUrl.indexOf("://");
    const afterCandidateScheme: string =
        schemeSeparatorIndex !== -1
            ? candidateUrl.slice(schemeSeparatorIndex + 3)
            : candidateUrl;
    const candidateAuthority: string = afterCandidateScheme.slice(
        0,
        findAuthorityEnd(afterCandidateScheme)
    );
    if (
        parsedUrl.username !== "" ||
        parsedUrl.password !== "" ||
        candidateAuthority.includes("@")
    ) {
        throw new Error(
            "Nextcloud server URL must not contain embedded credentials"
        );
    }
    const hostname: string = parsedUrl.hostname.toLowerCase();
    if (
        hostname === "" ||
        hostname.startsWith(".") ||
        hostname.endsWith(".") ||
        hostname.includes("..")
    ) {
        throw new Error("Invalid Nextcloud server URL");
    }
    if (!hadExplicitScheme && !rawBareHost.startsWith("[")) {
        const lowerBareHost: string = rawBareHost.toLowerCase();
        if (
            lowerBareHost === "" ||
            lowerBareHost.startsWith(".") ||
            lowerBareHost.endsWith(".") ||
            lowerBareHost.includes("..")
        ) {
            throw new Error("Invalid Nextcloud server URL");
        }
        if (
            !hasExplicitPort &&
            lowerBareHost !== "localhost" &&
            !lowerBareHost.includes(".")
        ) {
            throw new Error("Invalid Nextcloud server URL");
        }
    }
    return candidateUrl;
}

function normalizeUsername(username: string): string | null {
    if (hasControlChars(username)) {
        return null;
    }
    const trimmed: string = username.normalize("NFC").trim();
    if (
        trimmed === "" ||
        DOTS_ONLY_REGEX.test(trimmed) ||
        TRAILING_DOT_OR_SPACE_REGEX.test(trimmed) ||
        trimmed.includes(":") ||
        trimmed.includes("/") ||
        trimmed.includes("\\") ||
        FORBIDDEN_OBJECT_KEYS.has(trimmed.toLowerCase())
    ) {
        return null;
    }
    return trimmed;
}

export function normalizeVaultPath(path: string): string {
    if (hasControlChars(path)) {
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
        if (isInvalidPathSegment(rawSegment)) {
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
    if (normalized !== trimmed) {
        for (const segment of normalized.split("/")) {
            if (isInvalidPathSegment(segment)) {
                return "";
            }
        }
    }
    return normalized;
}

export function parseConflictCopyPath(
    path: string
): { originalPath: string; timestampUtc: string } | null {
    const normalized: string = normalizeVaultPath(path);
    if (normalized === "") {
        return null;
    }
    const parent: string = getParentPath(normalized);
    const lastSlash: number = normalized.lastIndexOf("/");
    const fileName: string =
        lastSlash === -1 ? normalized : normalized.slice(lastSlash + 1);
    const match: RegExpExecArray | null =
        CONFLICT_COPY_FILENAME_REGEX.exec(fileName);
    if (match === null) {
        return null;
    }
    const stem: string = match[1] ?? "";
    const stamp: string = match[2] ?? "";
    const ext: string = match[3] ?? "";
    if (stem === "" || stamp.length !== 15) {
        return null;
    }
    const originalFileName: string = `${stem}${ext}`;
    const originalPath: string = normalizeVaultPath(
        parent === "" ? originalFileName : `${parent}/${originalFileName}`
    );
    if (originalPath === "") {
        return null;
    }
    const timestampUtc: string =
        `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)} ` +
        `${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)} UTC`;
    return {
        originalPath,
        timestampUtc
    };
}

function parseServerUrl(rawUrl: string): URL {
    try {
        return new URL(rawUrl);
    } catch {
        throw new Error("Invalid Nextcloud server URL");
    }
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
    let aborted: boolean = false;
    let firstError: unknown = undefined;
    let hasError: boolean = false;
    let nextIndex: number = 0;

    const worker = async (): Promise<void> => {
        while (!aborted && nextIndex < tasks.length) {
            const currentIndex: number = nextIndex;
            nextIndex += 1;
            const task: (() => Promise<T>) | undefined = tasks[currentIndex];
            if (task !== undefined) {
                try {
                    results[currentIndex] = await task();
                } catch (err: unknown) {
                    if (!hasError) {
                        hasError = true;
                        firstError = err;
                    }
                    aborted = true;
                    return;
                }
            }
        }
    };

    const workerCount: number = Math.min(safeConcurrency, tasks.length);
    const workers: Promise<void>[] = [];
    for (let i: number = 0; i < workerCount; i += 1) {
        workers.push(worker());
    }
    await Promise.allSettled(workers);
    if (hasError) {
        throw firstError;
    }
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
    PLUGIN_DATA_RELATIVE_PATH,
    SYNC_HISTORY_RELATIVE_PATH,
    SYNC_STATE_RELATIVE_PATH,
    areArrayBuffersEqual,
    buildNextcloudWebDavBaseUrl,
    decodeWebDavHref,
    delay,
    encodeBasicAuth,
    encodeWebDavPath,
    formatByteSize,
    getConflictPath,
    getFolderLevels,
    getParentPath,
    getPathDepth,
    getPluginDataFilePath,
    getSyncHistoryFilePath,
    getSyncStateFilePath,
    hasControlChars,
    isExcludedPath,
    isExplicitRootPath,
    normalizeEtag,
    normalizeServerUrl,
    normalizeVaultPath,
    parseConflictCopyPath,
    runConcurrent,
    toSecondPrecision
};
