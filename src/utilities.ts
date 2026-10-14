import { normalizePath } from "obsidian";

export const SYNC_STATE_FILE_PATH: string = ".obsidian/plugins/vaultdav/sync-state.json";

const BASE64_CHARS: string = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function areArrayBuffersEqual(a: ArrayBuffer, b: ArrayBuffer): boolean {
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
    const trimmedUrl: string = url.trim().replace(/\/+$/, "");
    const encodedBaseDir: string = encodeWebDavPath(remoteBaseDir);
    const davMarker: string = "/remote.php/dav/files/";
    const markerIndex: number = trimmedUrl.indexOf(davMarker);

    let userRootUrl: string = "";
    if (markerIndex !== -1) {
        const afterMarker: string = trimmedUrl.slice(markerIndex + davMarker.length);
        const userSegment: string = afterMarker.split("/")[0] ?? "";
        const prefix: string = trimmedUrl.slice(0, markerIndex + davMarker.length);
        userRootUrl = `${prefix}${userSegment}`;
    } else {
        const encodedUser: string = encodeURIComponent(username.trim());
        userRootUrl = `${trimmedUrl}${davMarker}${encodedUser}`;
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
    let rawPathname: string = href.trim();
    if (rawPathname.startsWith("http://") || rawPathname.startsWith("https://")) {
        try {
            const parsedUrl: URL = new URL(rawPathname);
            rawPathname = parsedUrl.pathname;
        } catch {
            return null;
        }
    }

    const decodedSegments: string[] = [];
    for (const part of rawPathname.split("/")) {
        if (part === "") {
            continue;
        }
        try {
            decodedSegments.push(decodeURIComponent(part));
        } catch {
            decodedSegments.push(part);
        }
    }

    const decodedFull: string = `/${decodedSegments.join("/")}`;
    const davPrefix: string = `/remote.php/dav/files/${username.trim()}`;
    const prefixIndex: number = decodedFull.indexOf(davPrefix);
    if (prefixIndex === -1) {
        return null;
    }

    const afterUser: string = decodedFull
        .slice(prefixIndex + davPrefix.length)
        .replace(/^\/+/, "");
    const normalizedBase: string = normalizeVaultPath(remoteBaseDir);

    if (normalizedBase === "") {
        return normalizeVaultPath(afterUser);
    }
    if (afterUser === normalizedBase) {
        return "";
    }
    if (afterUser.startsWith(`${normalizedBase}/`)) {
        return normalizeVaultPath(afterUser.slice(normalizedBase.length + 1));
    }
    return null;
}

export function delay(ms: number): Promise<void> {
    return new Promise<void>((resolve: () => void) => {
        setTimeout(resolve, ms);
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

    const date: Date = new Date(timestamp);
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
        if (existingPaths === undefined || !existingPaths.has(candidatePath)) {
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
    const normalized: string = normalizeVaultPath(path);
    if (normalized === "") {
        return true;
    }
    if (
        normalized === SYNC_STATE_FILE_PATH ||
        normalized === ".obsidian/plugins/vaultdav/data.json"
    ) {
        return true;
    }
    if (/^\.obsidian\/workspace[^/]*\.json$/.test(normalized)) {
        return true;
    }

    const ignoredNames: ReadonlySet<string> = new Set<string>([
        ".DS_Store",
        ".git",
        ".github",
        ".gitlab",
        ".svn",
        "Desktop.ini",
        "Thumbs.db",
        "desktop.ini",
        "node_modules",
        "thumbs.db"
    ]);

    const segments: string[] = normalized.split("/");
    for (const segment of segments) {
        if (ignoredNames.has(segment)) {
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
    const trimmed: string = path.trim();
    if (trimmed === "" || trimmed === "/" || trimmed === ".") {
        return "";
    }
    const normalized: string = normalizePath(trimmed)
        .replace(/^\/+/, "")
        .replace(/\/+$/, "");
    if (normalized === "" || normalized === "/") {
        return "";
    }
    return normalized;
}

export async function runConcurrent<T>(
    tasks: ReadonlyArray<() => Promise<T>>,
    concurrency: number = 4
): Promise<T[]> {
    const safeConcurrency: number = Math.max(1, Math.min(5, Math.floor(concurrency)));
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
