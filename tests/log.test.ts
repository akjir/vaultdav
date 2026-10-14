import * as obsidian from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { log } from "../src/log";

describe("log", () => {
    beforeEach(() => {
        log.debugEnabled = false;
    });

    afterEach(() => {
        log.debugEnabled = false;
        vi.restoreAllMocks();
    });

    it("suppresses debug output when debugEnabled is false and logs with [VaultDAV] when true", () => {
        const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => undefined);

        log.debug("hidden debug message", { detail: 1 });
        expect(debugSpy).not.toHaveBeenCalled();

        log.debugEnabled = true;
        log.debug("visible debug message", { detail: 2 }, 42);
        expect(debugSpy).toHaveBeenCalledTimes(1);
        expect(debugSpy).toHaveBeenCalledWith(
            "[VaultDAV] visible debug message",
            { detail: 2 },
            42
        );
    });

    it("forwards info, warn, and error messages and extra arguments with the [VaultDAV] prefix", () => {
        const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const errObj: Error = new Error("failure");

        log.info("sync started", "phase-1");
        log.warn("lock detected", 423);
        log.error("sync failed", errObj);

        expect(infoSpy).toHaveBeenCalledTimes(1);
        expect(infoSpy).toHaveBeenCalledWith("[VaultDAV] sync started", "phase-1");

        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy).toHaveBeenCalledWith("[VaultDAV] lock detected", 423);

        expect(errorSpy).toHaveBeenCalledTimes(1);
        expect(errorSpy).toHaveBeenCalledWith("[VaultDAV] sync failed", errObj);
    });

    it("instantiates Notice with VaultDAV prefix and handles default, custom, and invalid durations", () => {
        const noticeSpy = vi.spyOn(obsidian, "Notice").mockImplementation(function (
            this: obsidian.Notice,
            _message: string | DocumentFragment,
            _duration?: number
        ): obsidian.Notice {
            return this;
        });

        log.notify("Default notice");
        expect(noticeSpy).toHaveBeenNthCalledWith(1, "VaultDAV: Default notice", 4000);

        log.notify("Persistent notice", 0);
        expect(noticeSpy).toHaveBeenNthCalledWith(2, "VaultDAV: Persistent notice", 0);

        log.notify("Custom notice", 2500.9);
        expect(noticeSpy).toHaveBeenNthCalledWith(3, "VaultDAV: Custom notice", 2500);

        log.notify("NaN duration notice", Number.NaN);
        expect(noticeSpy).toHaveBeenNthCalledWith(4, "VaultDAV: NaN duration notice", 4000);

        log.notify("Negative duration notice", -500);
        expect(noticeSpy).toHaveBeenNthCalledWith(5, "VaultDAV: Negative duration notice", 4000);

        log.notify("Infinite duration notice", Number.POSITIVE_INFINITY);
        expect(noticeSpy).toHaveBeenNthCalledWith(6, "VaultDAV: Infinite duration notice", 4000);
    });
});
