import { Notice } from "obsidian";

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
            console.debug(`[VaultDAV] ${message}`, ...args);
        }
    },
    debugEnabled: false,
    error(message: string, ...args: unknown[]): void {
        console.error(`[VaultDAV] ${message}`, ...args);
    },
    info(message: string, ...args: unknown[]): void {
        console.info(`[VaultDAV] ${message}`, ...args);
    },
    notify(message: string, duration: number = 4000): void {
        new Notice(`VaultDAV: ${message}`, duration);
    },
    warn(message: string, ...args: unknown[]): void {
        console.warn(`[VaultDAV] ${message}`, ...args);
    }
};
