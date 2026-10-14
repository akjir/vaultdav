import { Notice } from "obsidian";

const BASIC_AUTH_REDACT_REGEX: RegExp = /Basic\s+[A-Za-z0-9+/=]+/g;
const DEFAULT_NOTICE_DURATION_MS: number = 4000;
const LOG_PREFIX: string = "[VaultDAV]";
const NOTICE_PREFIX: string = "VaultDAV:";
const URL_USERINFO_REDACT_REGEX: RegExp = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/\s@]+@/g;

export interface Logger {
    debug: (message: string, ...args: unknown[]) => void;
    debugEnabled: boolean;
    error: (message: string, ...args: unknown[]) => void;
    info: (message: string, ...args: unknown[]) => void;
    notify: (message: string, duration?: number) => void;
    warn: (message: string, ...args: unknown[]) => void;
}

export function redactSensitiveText(text: string): string {
    return text
        .replace(BASIC_AUTH_REDACT_REGEX, "Basic [REDACTED]")
        .replace(URL_USERINFO_REDACT_REGEX, "$1[REDACTED]@");
}

function sanitizeLogArg(arg: unknown): unknown {
    if (typeof arg === "string") {
        return redactSensitiveText(arg);
    }
    if (arg instanceof Error) {
        const redactedMessage: string = redactSensitiveText(arg.message);
        if (redactedMessage !== arg.message) {
            return new Error(redactedMessage);
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
        console.info(
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
