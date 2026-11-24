import { Notice } from "obsidian";
import type { ProgressReporter } from "./types";

export type { ProgressReporter };

const BASIC_AUTH_REDACT_REGEX: RegExp = /Basic\s+[A-Za-z0-9+/=]+/gi;
const DEFAULT_NOTICE_DURATION_MS: number = 4000;
const LOG_PREFIX: string = "[VaultDAV]";
const MAX_LOG_SANITIZE_DEPTH: number = 6;
const NOTICE_PREFIX: string = "VaultDAV:";
const SENSITIVE_LOG_KEYS_LOWER: ReadonlySet<string> = new Set<string>([
    "apppassword",
    "authorization",
    "cookie",
    "passwd",
    "password",
    "proxy-authorization",
    "secret",
    "set-cookie",
    "token"
]);
const WHITESPACE_CHAR_REGEX: RegExp = /\s/;

export interface Logger {
    debug: (message: string, ...args: unknown[]) => void;
    debugEnabled: boolean;
    error: (message: string, ...args: unknown[]) => void;
    info: (message: string, ...args: unknown[]) => void;
    notify: (message: string, duration?: number) => void;
    warn: (message: string, ...args: unknown[]) => void;
}

export function formatTransferProgress(
    direction: "Downloading" | "Uploading",
    path: string,
    fileIndex: number,
    totalFiles: number,
    chunkIndex?: number,
    totalChunks?: number
): string {
    const safeFileIndex: number =
        Number.isFinite(fileIndex) && fileIndex > 0 ? Math.floor(fileIndex) : 1;
    const safeTotalFiles: number =
        Number.isFinite(totalFiles) && totalFiles > 0 ? Math.floor(totalFiles) : 1;
    const redactedPath: string = redactSensitiveText(path);
    if (
        chunkIndex !== undefined &&
        totalChunks !== undefined &&
        Number.isFinite(chunkIndex) &&
        Number.isFinite(totalChunks) &&
        chunkIndex > 0 &&
        totalChunks > 0
    ) {
        const safeChunk: number = Math.floor(chunkIndex);
        const safeTotalChunks: number = Math.floor(totalChunks);
        return `${direction} ${redactedPath} (${safeChunk}/${safeTotalChunks} · file ${safeFileIndex}/${safeTotalFiles})`;
    }
    return `${direction} ${redactedPath} (file ${safeFileIndex}/${safeTotalFiles})`;
}

function isAuthorityDelimiter(
    code: number,
    text: string,
    index: number
): boolean {
    if (
        code === 47 ||
        code === 63 ||
        code === 35 ||
        code === 32 ||
        (code >= 9 && code <= 13)
    ) {
        return true;
    }
    if (code >= 128) {
        return WHITESPACE_CHAR_REGEX.test(text.charAt(index));
    }
    return false;
}

function isSchemeAlpha(code: number): boolean {
    return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isSchemeChar(code: number): boolean {
    return (
        isSchemeAlpha(code) ||
        (code >= 48 && code <= 57) ||
        code === 43 ||
        code === 45 ||
        code === 46
    );
}

export function redactSensitiveText(text: string): string {
    const basicRedacted: string = text.replace(
        BASIC_AUTH_REDACT_REGEX,
        "Basic [REDACTED]"
    );
    return redactUrlUserinfo(basicRedacted);
}

function redactUrlUserinfo(text: string): string {
    let schemeSepIndex: number = text.indexOf("://");
    if (schemeSepIndex === -1) {
        return text;
    }
    const parts: string[] = [];
    let changed: boolean = false;
    let lastEmitted: number = 0;
    let minSchemeStart: number = 0;
    let searchFrom: number = 0;

    while (schemeSepIndex !== -1) {
        let firstAlphaIndex: number = -1;
        for (let i: number = schemeSepIndex - 1; i >= minSchemeStart; i -= 1) {
            const code: number = text.charCodeAt(i);
            if (!isSchemeChar(code)) {
                break;
            }
            if (isSchemeAlpha(code)) {
                firstAlphaIndex = i;
            }
        }

        const authorityStart: number = schemeSepIndex + 3;
        if (firstAlphaIndex !== -1) {
            let authorityEnd: number = authorityStart;
            let lastAtIndex: number = -1;
            while (authorityEnd < text.length) {
                const code: number = text.charCodeAt(authorityEnd);
                if (isAuthorityDelimiter(code, text, authorityEnd)) {
                    break;
                }
                if (code === 64) {
                    lastAtIndex = authorityEnd;
                }
                authorityEnd += 1;
            }
            if (lastAtIndex > authorityStart) {
                parts.push(
                    text.slice(lastEmitted, authorityStart),
                    "[REDACTED]@"
                );
                changed = true;
                lastEmitted = lastAtIndex + 1;
                minSchemeStart = lastAtIndex + 1;
                searchFrom = lastAtIndex + 1;
            } else {
                minSchemeStart = authorityStart;
                if (
                    authorityEnd > authorityStart &&
                    authorityEnd < text.length &&
                    text.charCodeAt(authorityEnd) === 47 &&
                    text.charCodeAt(authorityEnd - 1) === 58
                ) {
                    searchFrom = authorityEnd - 1;
                } else {
                    searchFrom = authorityEnd;
                }
            }
        } else {
            minSchemeStart = authorityStart;
            searchFrom = authorityStart;
        }

        schemeSepIndex = text.indexOf("://", searchFrom);
    }

    if (!changed) {
        return text;
    }
    parts.push(text.slice(lastEmitted));
    return parts.join("");
}

function sanitizeLogArg(arg: unknown): unknown {
    return sanitizeLogValue(arg, new WeakSet<object>(), 0).value;
}

function sanitizeLogArgs(args: ReadonlyArray<unknown>): unknown[] {
    return args.map((arg: unknown) => sanitizeLogArg(arg));
}

function sanitizeLogValue(
    arg: unknown,
    seen: WeakSet<object>,
    depth: number
): { changed: boolean; value: unknown } {
    if (typeof arg === "string") {
        const redacted: string = redactSensitiveText(arg);
        return { changed: redacted !== arg, value: redacted };
    }
    if (typeof arg !== "object" || arg === null) {
        return { changed: false, value: arg };
    }
    if (arg instanceof Date || arg instanceof RegExp) {
        return { changed: false, value: arg };
    }
    if (seen.has(arg)) {
        return { changed: true, value: "[Circular]" };
    }
    if (depth >= MAX_LOG_SANITIZE_DEPTH) {
        return { changed: true, value: "[Truncated]" };
    }

    seen.add(arg);
    try {
        if (arg instanceof Error) {
            const redactedMessage: string = redactSensitiveText(arg.message);
            const redactedStack: string | undefined =
                typeof arg.stack === "string"
                    ? redactSensitiveText(arg.stack)
                    : undefined;
            const hasCause: boolean =
                "cause" in arg && arg.cause !== undefined;
            const sanitizedCause: { changed: boolean; value: unknown } = hasCause
                ? sanitizeLogValue(arg.cause, seen, depth + 1)
                : { changed: false, value: undefined };

            let ownPropsChanged: boolean = false;
            const sanitizedEntries: Array<[string, unknown]> = [];
            for (const [key, val] of Object.entries(arg)) {
                if (SENSITIVE_LOG_KEYS_LOWER.has(key.toLowerCase())) {
                    ownPropsChanged = true;
                    sanitizedEntries.push([key, "[REDACTED]"]);
                } else {
                    const sanitizedVal: { changed: boolean; value: unknown } =
                        sanitizeLogValue(val, seen, depth + 1);
                    if (sanitizedVal.changed) {
                        ownPropsChanged = true;
                    }
                    sanitizedEntries.push([key, sanitizedVal.value]);
                }
            }

            const changed: boolean =
                redactedMessage !== arg.message ||
                redactedStack !== arg.stack ||
                sanitizedCause.changed ||
                ownPropsChanged;
            if (!changed) {
                return { changed: false, value: arg };
            }
            const sanitizedError: Error & Record<string, unknown> = new Error(
                redactedMessage
            ) as Error & Record<string, unknown>;
            sanitizedError.name = arg.name;
            if (redactedStack !== undefined) {
                sanitizedError.stack = redactedStack;
            }
            if (hasCause) {
                sanitizedError.cause = sanitizedCause.value;
            }
            for (const [key, val] of sanitizedEntries) {
                sanitizedError[key] = val;
            }
            return { changed: true, value: sanitizedError };
        }

        if (Array.isArray(arg)) {
            let changed: boolean = false;
            const sanitizedList: unknown[] = new Array<unknown>(arg.length);
            for (let i: number = 0; i < arg.length; i += 1) {
                const entry: { changed: boolean; value: unknown } =
                    sanitizeLogValue(arg[i], seen, depth + 1);
                if (entry.changed) {
                    changed = true;
                }
                sanitizedList[i] = entry.value;
            }
            return { changed, value: changed ? sanitizedList : arg };
        }

        let changed: boolean = false;
        const sanitizedRecord: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(arg)) {
            if (SENSITIVE_LOG_KEYS_LOWER.has(key.toLowerCase())) {
                changed = true;
                sanitizedRecord[key] = "[REDACTED]";
            } else {
                const entry: { changed: boolean; value: unknown } =
                    sanitizeLogValue(val, seen, depth + 1);
                if (entry.changed) {
                    changed = true;
                }
                sanitizedRecord[key] = entry.value;
            }
        }
        return { changed, value: changed ? sanitizedRecord : arg };
    } finally {
        seen.delete(arg);
    }
}

export const log: Logger = {
    debug(message: string, ...args: unknown[]): void {
        if (log.debugEnabled) {
            console.debug(
                `${LOG_PREFIX} ${redactSensitiveText(message)}`,
                ...sanitizeLogArgs(args)
            );
        }
    },
    debugEnabled: false,
    error(message: string, ...args: unknown[]): void {
        console.error(
            `${LOG_PREFIX} ${redactSensitiveText(message)}`,
            ...sanitizeLogArgs(args)
        );
    },
    info(message: string, ...args: unknown[]): void {
        console.debug(
            `${LOG_PREFIX} ${redactSensitiveText(message)}`,
            ...sanitizeLogArgs(args)
        );
    },
    notify(message: string, duration: number = DEFAULT_NOTICE_DURATION_MS): void {
        const safeDuration: number =
            Number.isFinite(duration) && duration >= 0
                ? Math.floor(duration)
                : DEFAULT_NOTICE_DURATION_MS;
        new Notice(
            `${NOTICE_PREFIX} ${redactSensitiveText(message)}`,
            safeDuration
        );
    },
    warn(message: string, ...args: unknown[]): void {
        console.warn(
            `${LOG_PREFIX} ${redactSensitiveText(message)}`,
            ...sanitizeLogArgs(args)
        );
    }
};
