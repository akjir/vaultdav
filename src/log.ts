import { Notice } from "obsidian";
import type { ProgressReporter } from "./types";

export type { ProgressReporter };

const BASIC_AUTH_REDACT_REGEX: RegExp = /Basic\s+[A-Za-z0-9+/=]+/gi;
const DEFAULT_NOTICE_DURATION_MS: number = 4000;
const LOG_PREFIX: string = "[VaultDAV]";
const NOTICE_PREFIX: string = "VaultDAV:";
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
    if (typeof arg === "string") {
        return redactSensitiveText(arg);
    }
    if (arg instanceof Error) {
        const redactedMessage: string = redactSensitiveText(arg.message);
        const redactedStack: string | undefined =
            typeof arg.stack === "string"
                ? redactSensitiveText(arg.stack)
                : undefined;
        if (redactedMessage !== arg.message || redactedStack !== arg.stack) {
            const sanitizedError: Error = new Error(redactedMessage);
            sanitizedError.name = arg.name;
            if (redactedStack !== undefined) {
                sanitizedError.stack = redactedStack;
            }
            return sanitizedError;
        }
    }
    return arg;
}

function sanitizeLogArgs(args: ReadonlyArray<unknown>): unknown[] {
    return args.map((arg: unknown) => sanitizeLogArg(arg));
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
