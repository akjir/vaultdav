import * as obsidian from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatTransferProgress, log, redactSensitiveText } from "../src/log";

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

    it("forwards info (via console.debug), warn, and error messages and extra arguments with the [VaultDAV] prefix", () => {
        const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => undefined);
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const errObj: Error = new Error("failure");

        log.info("sync started", "phase-1");
        log.warn("lock detected", 423);
        log.error("sync failed", errObj);

        expect(debugSpy).toHaveBeenCalledTimes(1);
        expect(debugSpy).toHaveBeenCalledWith("[VaultDAV] sync started", "phase-1");

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

    it("redacts HTTP Basic Auth tokens and embedded URL credentials in log and notice output", () => {
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const noticeSpy = vi.spyOn(obsidian, "Notice").mockImplementation(function (
            this: obsidian.Notice,
            _message: string | DocumentFragment,
            _duration?: number
        ): obsidian.Notice {
            return this;
        });

        log.error(
            "Request to https://alice:super-secret@cloud.example.com/dav failed with Authorization: Basic YWxpY2U6c2VjcmV0MTIz",
            "extra https://bob:pw123@example.org/path",
            new Error("Header Basic dXNlcjpwYXNz== leaked")
        );

        expect(errorSpy).toHaveBeenCalledTimes(1);
        const loggedArgs: unknown[] = errorSpy.mock.calls[0] ?? [];
        expect(loggedArgs[0]).toBe(
            "[VaultDAV] Request to https://[REDACTED]@cloud.example.com/dav failed with Authorization: Basic [REDACTED]"
        );
        expect(loggedArgs[1]).toBe("extra https://[REDACTED]@example.org/path");
        expect((loggedArgs[2] as Error).message).toBe("Header Basic [REDACTED] leaked");

        log.notify(
            "Connection failed for https://alice:secret@cloud.example.com (Basic YWxpY2U6c2VjcmV0)"
        );
        expect(noticeSpy).toHaveBeenCalledWith(
            "VaultDAV: Connection failed for https://[REDACTED]@cloud.example.com (Basic [REDACTED])",
            4000
        );

        log.notify(
            "Lowercase basic dG9rZW4= and UPPER BASIC dG9rZW4y with https://alice@domain.com:p@ss@cloud.example.com/dav and https://cloud.example.com?email=user@example.org#tag@frag"
        );
        expect(noticeSpy).toHaveBeenLastCalledWith(
            "VaultDAV: Lowercase Basic [REDACTED] and UPPER Basic [REDACTED] with https://[REDACTED]@cloud.example.com/dav and https://cloud.example.com?email=user@example.org#tag@frag",
            4000
        );

        const stackError: Error = new Error("Generic failure");
        stackError.stack =
            "Error: Generic failure\n    at https://alice:topsecret@cloud.example.com/dav (Basic YWxpY2U6dG9wc2VjcmV0)";
        log.error("Stack redaction check", stackError);
        const stackLoggedArgs: unknown[] = errorSpy.mock.calls[1] ?? [];
        const sanitizedStackError: Error = stackLoggedArgs[1] as Error;
        expect(sanitizedStackError.message).toBe("Generic failure");
        expect(sanitizedStackError.stack).toContain("https://[REDACTED]@cloud.example.com/dav");
        expect(sanitizedStackError.stack).toContain("Basic [REDACTED]");
        expect(sanitizedStackError.stack).not.toContain("topsecret");
        expect(sanitizedStackError.stack).not.toContain("YWxpY2U6dG9wc2VjcmV0");
    });

    it("formats real-time status bar transfer progress strings with numeric guards", () => {
        expect(formatTransferProgress("Uploading", "notes.md", 5, 18, 3, 12)).toBe(
            "Uploading notes.md (3/12 · file 5/18)"
        );
        expect(formatTransferProgress("Downloading", "video.mp4", 1, 2, 1, 1)).toBe(
            "Downloading video.mp4 (1/1 · file 1/2)"
        );
        expect(
            formatTransferProgress(
                "Uploading",
                "notes.md",
                Number.NaN,
                -4,
                0,
                Number.NaN
            )
        ).toBe("Uploading notes.md (file 1/1)");
    });

    it("neutralizes quadratic ReDoS payloads in redactSensitiveText() while preserving edge-case URL redaction", () => {
        const redosPayload: string = "a".repeat(100_000);
        const startMs: number = performance.now();
        const redactedPlain: string = redactSensitiveText(redosPayload);
        const elapsedMs: number = performance.now() - startMs;

        expect(elapsedMs).toBeLessThan(200);
        expect(redactedPlain).toBe(redosPayload);

        const trailingUrlPayload: string = `${"a".repeat(60_000)} https://alice:secret@cloud.example.com/dav`;
        const startUrlMs: number = performance.now();
        const redactedTrailing: string = redactSensitiveText(trailingUrlPayload);
        const elapsedUrlMs: number = performance.now() - startUrlMs;

        expect(elapsedUrlMs).toBeLessThan(200);
        expect(redactedTrailing).toContain("https://[REDACTED]@cloud.example.com/dav");
        expect(redactedTrailing).not.toContain("secret");

        expect(redactSensitiveText("https://@cloud.example.com/dav")).toBe(
            "https://@cloud.example.com/dav"
        );
        expect(redactSensitiveText("https://foo:bar@baz://qux:pw@host/path")).toBe(
            "https://[REDACTED]@baz://[REDACTED]@host/path"
        );
        expect(redactSensitiveText("123https://u:p@example.com/x")).toBe(
            "123https://[REDACTED]@example.com/x"
        );
    });
});
