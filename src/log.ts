import { Notice } from "obsidian";

const DEFAULT_NOTICE_DURATION_MS: number = 4000;
const LOG_PREFIX: string = "[VaultDAV]";
const NOTICE_PREFIX: string = "VaultDAV:";

export interface Logger {
    debug: (message: string, ...args: unknown[]) => void;
    debugEnabled: boolean;
    error: (message: string, ...args: unknown[]) => void;
    info: (message: string, ...args: unknown[]) => void;
    notify: (message: string, duration?: number) => void;
    warn: (message: string, ...args: unknown[]) => void;
}

export const log: Logger = {
    debug(message: string, ...args: unknown[]): void {
        if (log.debugEnabled) {
            console.debug(`${LOG_PREFIX} ${message}`, ...args);
        }
    },
    debugEnabled: false,
    error(message: string, ...args: unknown[]): void {
        console.error(`${LOG_PREFIX} ${message}`, ...args);
    },
    info(message: string, ...args: unknown[]): void {
        console.info(`${LOG_PREFIX} ${message}`, ...args);
    },
    notify(message: string, duration: number = DEFAULT_NOTICE_DURATION_MS): void {
        const safeDuration: number =
            Number.isFinite(duration) && duration >= 0
                ? Math.floor(duration)
                : DEFAULT_NOTICE_DURATION_MS;
        new Notice(`${NOTICE_PREFIX} ${message}`, safeDuration);
    },
    warn(message: string, ...args: unknown[]): void {
        console.warn(`${LOG_PREFIX} ${message}`, ...args);
    }
};
