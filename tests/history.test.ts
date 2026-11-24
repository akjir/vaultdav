import type { DataAdapter } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { log } from "../src/log";
import {
    capRunEvents,
    createEmptyRunSummary,
    CURRENT_HISTORY_VERSION,
    isCriticalRun,
    isNoopRun,
    MAX_EVENT_MESSAGE_LENGTH,
    MAX_EVENTS_PER_RUN,
    MAX_HISTORY_RUNS,
    pruneHistoryRuns,
    SyncHistoryStore
} from "../src/sync/history";
import type {
    SyncLogEvent,
    SyncRunRecord,
    SyncRunSummary
} from "../src/types";

interface MockHistoryFs {
    adapter: DataAdapter;
    files: Map<string, string>;
    mkdirCalls: string[];
    writeCalls: string[];
}

function createMockHistoryAdapter(): MockHistoryFs {
    const files: Map<string, string> = new Map<string, string>();
    const mkdirCalls: string[] = [];
    const writeCalls: string[] = [];

    const adapter: DataAdapter = {
        exists: async (path: string): Promise<boolean> => files.has(path),
        mkdir: async (path: string): Promise<void> => {
            mkdirCalls.push(path);
        },
        read: async (path: string): Promise<string> => {
            const content: string | undefined = files.get(path);
            if (content === undefined) {
                throw new Error(`ENOENT: ${path}`);
            }
            return content;
        },
        write: async (path: string, data: string): Promise<void> => {
            writeCalls.push(path);
            files.set(path, data);
        }
    } as unknown as DataAdapter;

    return { adapter, files, mkdirCalls, writeCalls };
}

function makeRun(
    overrides: Partial<SyncRunRecord> & { id: string; finishedAt: number }
): SyncRunRecord {
    const summary: SyncRunSummary = {
        ...createEmptyRunSummary(),
        ...(overrides.summary ?? {})
    };
    return {
        collapsedCount: overrides.collapsedCount ?? 1,
        detailsPruned: overrides.detailsPruned ?? false,
        durationMs: overrides.durationMs ?? 250,
        events: overrides.events ?? [],
        finishedAt: overrides.finishedAt,
        firstCollapsedAt: overrides.firstCollapsedAt,
        id: overrides.id,
        omittedEvents: overrides.omittedEvents ?? 0,
        startedAt: overrides.startedAt ?? overrides.finishedAt - 250,
        status: overrides.status ?? "success",
        summary,
        trigger: overrides.trigger ?? "manual"
    };
}

describe("SyncHistoryStore and Hybrid Tiered Retention", () => {
    const historyPath: string = ".obsidian/plugins/vaultdav/sync-history.json";
    const dayMs: number = 86_400_000;
    const baseNow: number = 1_760_000_000_000;

    it("rejects invalid, non-excluded, data.json, and sync-state.json history file paths", () => {
        const { adapter } = createMockHistoryAdapter();
        expect(
            () => new SyncHistoryStore(adapter, "", ".obsidian")
        ).toThrow("Invalid sync history file path");
        expect(
            () => new SyncHistoryStore(adapter, "Notes/history.json", ".obsidian")
        ).toThrow("Invalid sync history file path");
        expect(
            () =>
                new SyncHistoryStore(
                    adapter,
                    ".obsidian/plugins/vaultdav/data.json",
                    ".obsidian"
                )
        ).toThrow("Invalid sync history file path");
        expect(
            () =>
                new SyncHistoryStore(
                    adapter,
                    ".obsidian/plugins/vaultdav/sync-state.json",
                    ".obsidian"
                )
        ).toThrow("Invalid sync history file path");
        expect(
            () =>
                new SyncHistoryStore(
                    adapter,
                    ".custom-cfg/plugins/vaultdav/sync-history.json",
                    ".custom-cfg"
                )
        ).not.toThrow();
    });

    it("folds consecutive no-op runs without losing separate active runs", async () => {
        const { adapter } = createMockHistoryAdapter();
        const store: SyncHistoryStore = new SyncHistoryStore(
            adapter,
            historyPath,
            ".obsidian"
        );

        await store.recordRun(
            makeRun({
                finishedAt: baseNow - 5_000,
                id: "r1",
                startedAt: baseNow - 5_200,
                trigger: "auto"
            }),
            30,
            baseNow - 5_000
        );
        await store.recordRun(
            makeRun({
                finishedAt: baseNow - 3_000,
                id: "r2",
                startedAt: baseNow - 3_100,
                trigger: "auto"
            }),
            30,
            baseNow - 3_000
        );
        await store.recordRun(
            makeRun({
                finishedAt: baseNow - 1_000,
                id: "r3",
                startedAt: baseNow - 1_100,
                trigger: "manual"
            }),
            30,
            baseNow - 1_000
        );

        let runs: SyncRunRecord[] = store.getRuns();
        expect(runs.length).toBe(1);
        expect(runs[0]?.collapsedCount).toBe(3);
        expect(runs[0]?.firstCollapsedAt).toBe(baseNow - 5_200);
        expect(runs[0]?.finishedAt).toBe(baseNow - 1_000);
        expect(isNoopRun(runs[0]!)).toBe(true);

        // Active run breaks the no-op streak
        await store.recordRun(
            makeRun({
                events: [{ kind: "upload", path: "Note.md", size: 42 }],
                finishedAt: baseNow,
                id: "r4",
                summary: { ...createEmptyRunSummary(), uploaded: 1 }
            }),
            30,
            baseNow
        );
        // Subsequent no-op starts a fresh folded streak
        await store.recordRun(
            makeRun({
                finishedAt: baseNow + 2_000,
                id: "r5",
                trigger: "auto"
            }),
            30,
            baseNow + 2_000
        );

        runs = store.getRuns();
        expect(runs.length).toBe(3);
        expect(runs[0]?.id).toBe("r5");
        expect(runs[0]?.collapsedCount).toBe(1);
        expect(runs[1]?.id).toBe("r4");
        expect(runs[2]?.collapsedCount).toBe(3);
    });

    it("prioritizes conflicts, errors, warnings, and deletions over routine events when capping per run", () => {
        const events: SyncLogEvent[] = [];
        for (let i: number = 0; i < 600; i += 1) {
            events.push({ kind: "upload", path: `Notes/File-${i}.md`, size: 100 });
        }
        events.push({
            conflictCopyPath: "Notes/A.conflict-20261124-120000.md",
            kind: "conflict",
            path: "Notes/A.md",
            resolution: "keep_both",
            size: 120
        });
        events.push({
            kind: "error",
            message: "HTTP 503",
            path: "Notes/Fail.md"
        });
        events.push({
            kind: "warning",
            message: "Case mismatch",
            path: "Notes/Case.md"
        });
        events.push({
            isDirectory: false,
            kind: "delete_remote",
            path: "Notes/Old.md"
        });
        events.push({
            isDirectory: true,
            kind: "create_remote_dir",
            path: "Notes/NewDir"
        });

        const capped = capRunEvents(events, MAX_EVENTS_PER_RUN);
        expect(capped.events.length).toBe(MAX_EVENTS_PER_RUN);
        expect(capped.omittedEvents).toBe(events.length - MAX_EVENTS_PER_RUN);
        expect(capped.events[0]?.kind).toBe("conflict");
        expect(capped.events[1]?.kind).toBe("error");
        expect(capped.events[2]?.kind).toBe("warning");
        expect(capped.events[3]?.kind).toBe("delete_remote");
        expect(
            capped.events.some((e: SyncLogEvent) => e.kind === "create_remote_dir")
        ).toBe(false);
    });

    it("prunes runs older than retentionDays and preserves critical runs ahead of clean runs under maxRuns", () => {
        const runs: SyncRunRecord[] = [];
        // Expired run (40 days old)
        runs.push(
            makeRun({
                events: [{ kind: "error", message: "Old error" }],
                finishedAt: baseNow - 40 * dayMs,
                id: "expired-critical",
                status: "failed",
                summary: { ...createEmptyRunSummary(), errors: 1 }
            })
        );
        // 15 critical runs inside 30-day window (older than routine runs)
        for (let i: number = 0; i < 15; i += 1) {
            runs.push(
                makeRun({
                    events: [
                        {
                            conflictCopyPath: `Doc${i}.conflict-20261120-000000.md`,
                            kind: "conflict",
                            path: `Doc${i}.md`,
                            resolution: "keep_both"
                        }
                    ],
                    finishedAt: baseNow - (20 * dayMs) + i * 1000,
                    id: `critical-${i}`,
                    summary: {
                        ...createEmptyRunSummary(),
                        conflictsKeepBoth: 1,
                        conflictsResolved: 1
                    }
                })
            );
        }
        // 100 newer routine upload runs inside 30-day window
        for (let i: number = 0; i < 100; i += 1) {
            runs.push(
                makeRun({
                    events: [{ kind: "upload", path: `Routine${i}.md`, size: 10 }],
                    finishedAt: baseNow - (5 * dayMs) + i * 1000,
                    id: `routine-${i}`,
                    summary: { ...createEmptyRunSummary(), uploaded: 1 }
                })
            );
        }

        const pruned: SyncRunRecord[] = pruneHistoryRuns(
            runs,
            baseNow,
            30,
            MAX_HISTORY_RUNS
        );
        expect(pruned.length).toBe(MAX_HISTORY_RUNS);
        expect(pruned.some((r: SyncRunRecord) => r.id === "expired-critical")).toBe(
            false
        );
        // All 15 in-window critical runs survive while oldest routine runs are evicted
        const criticalSurviving: SyncRunRecord[] = pruned.filter(
            (r: SyncRunRecord) => isCriticalRun(r)
        );
        expect(criticalSurviving.length).toBe(15);
        expect(pruned.some((r: SyncRunRecord) => r.id === "routine-0")).toBe(false);
        expect(pruned.some((r: SyncRunRecord) => r.id === "routine-99")).toBe(true);
    });

    it("enforces maxBytes by compacting older runs to summary-only before evicting or trimming latest run", () => {
        const bigEvents: SyncLogEvent[] = [];
        for (let i: number = 0; i < 80; i += 1) {
            bigEvents.push({
                kind: "upload",
                path: `Folder/SubFolder/LongDocumentNameForBudgetTest-${i}.md`,
                size: 1024
            });
        }
        const olderClean: SyncRunRecord = makeRun({
            events: bigEvents,
            finishedAt: baseNow - 3000,
            id: "older-clean",
            summary: { ...createEmptyRunSummary(), uploaded: 80 }
        });
        const olderCritical: SyncRunRecord = makeRun({
            events: [
                {
                    conflictCopyPath: "Important.conflict-20261124-120000.md",
                    kind: "conflict",
                    path: "Important.md",
                    resolution: "keep_both"
                },
                ...bigEvents.slice(0, 40)
            ],
            finishedAt: baseNow - 2000,
            id: "older-critical",
            summary: {
                ...createEmptyRunSummary(),
                conflictsKeepBoth: 1,
                conflictsResolved: 1,
                uploaded: 40
            }
        });
        const newest: SyncRunRecord = makeRun({
            events: [
                { kind: "error", message: "Timeout", path: "LatestFail.md" },
                ...bigEvents.slice(0, 20)
            ],
            finishedAt: baseNow,
            id: "newest",
            status: "partial",
            summary: { ...createEmptyRunSummary(), errors: 1, uploaded: 20 }
        });

        // Tight budget that fits summaries + newest events, forcing Phase A1 compaction on olderClean
        const compacted: SyncRunRecord[] = pruneHistoryRuns(
            [newest, olderCritical, olderClean],
            baseNow,
            30,
            100,
            6000
        );
        expect(compacted.length).toBe(3);
        const foundOlderClean: SyncRunRecord | undefined = compacted.find(
            (r: SyncRunRecord) => r.id === "older-clean"
        );
        expect(foundOlderClean?.detailsPruned).toBe(true);
        expect(foundOlderClean?.events).toEqual([]);
        expect(foundOlderClean?.omittedEvents).toBe(80);
        expect(foundOlderClean?.summary.uploaded).toBe(80);

        // Extremely tight budget (1500 bytes) forces eviction & latest run priority trimming while keeping the error
        const tight: SyncRunRecord[] = pruneHistoryRuns(
            [newest, olderCritical, olderClean],
            baseNow,
            30,
            100,
            1500
        );
        expect(tight.length).toBeGreaterThanOrEqual(1);
        expect(tight[0]?.id).toBe("newest");
        expect(
            new TextEncoder().encode(
                JSON.stringify({ runs: tight, version: CURRENT_HISTORY_VERSION })
            ).byteLength
        ).toBeLessThanOrEqual(1500);
        expect(tight[0]?.events[0]?.kind).toBe("error");
    });

    it("redacts sensitive credentials, truncates oversized messages, strips null padding, and recovers from corrupt or oversized files", async () => {
        const { adapter, files } = createMockHistoryAdapter();
        const warnSpy = vi.spyOn(log, "warn").mockImplementation((): void => undefined);
        const store: SyncHistoryStore = new SyncHistoryStore(
            adapter,
            historyPath,
            ".obsidian"
        );

        const longSecretMsg: string =
            "Authorization: Basic c2VjcmV0OnBhc3M= https://alice:topsecret@cloud.example.com " +
            "x".repeat(MAX_EVENT_MESSAGE_LENGTH + 100);
        await store.recordRun(
            makeRun({
                events: [{ kind: "error", message: longSecretMsg, path: "Note.md" }],
                finishedAt: baseNow,
                id: "secret-run",
                status: "partial",
                summary: { ...createEmptyRunSummary(), errors: 1 }
            }),
            30,
            baseNow
        );

        const persistedRaw: string = files.get(historyPath) ?? "";
        expect(persistedRaw).not.toContain("c2VjcmV0OnBhc3M=");
        expect(persistedRaw).not.toContain("topsecret");
        expect(persistedRaw).toContain("Basic [REDACTED]");
        expect(persistedRaw).toContain("https://[REDACTED]@cloud.example.com");

        // Reload with null-byte padding
        files.set(historyPath, `\u0000\u0000${persistedRaw}\u0000`);
        const reloaded = await store.load(30, baseNow);
        expect(reloaded.runs.length).toBe(1);
        const reloadedMsg: string = reloaded.runs[0]?.events[0]?.message ?? "";
        expect(reloadedMsg.length).toBeLessThanOrEqual(MAX_EVENT_MESSAGE_LENGTH);
        expect(reloadedMsg.endsWith("...")).toBe(true);

        // Corrupt JSON resets safely
        files.set(historyPath, "{bad-json");
        const corruptLoaded = await store.load(30, baseNow);
        expect(corruptLoaded.runs).toEqual([]);
        expect(warnSpy).toHaveBeenCalled();

        // Clear writes empty history
        await store.clear();
        expect(store.getRuns()).toEqual([]);
        expect(JSON.parse(files.get(historyPath) ?? "{}")).toEqual({
            runs: [],
            version: CURRENT_HISTORY_VERSION
        });

        warnSpy.mockRestore();
    });

    it("serializes concurrent recordRun() writes and clones getRuns() defensively", async () => {
        const files: Map<string, string> = new Map<string, string>();
        let activeWrites: number = 0;
        let maxActiveWrites: number = 0;
        const adapter: DataAdapter = {
            exists: async (path: string): Promise<boolean> => files.has(path),
            mkdir: async (): Promise<void> => undefined,
            read: async (path: string): Promise<string> => files.get(path) ?? "{}",
            write: async (path: string, data: string): Promise<void> => {
                activeWrites += 1;
                if (activeWrites > maxActiveWrites) {
                    maxActiveWrites = activeWrites;
                }
                await Promise.resolve();
                files.set(path, data);
                activeWrites -= 1;
            }
        } as unknown as DataAdapter;

        const store: SyncHistoryStore = new SyncHistoryStore(
            adapter,
            historyPath,
            ".obsidian"
        );
        await store.load(30, baseNow);

        await Promise.all([
            store.recordRun(
                makeRun({
                    events: [{ kind: "upload", path: "A.md", size: 10 }],
                    finishedAt: baseNow,
                    id: "run-1",
                    summary: { ...createEmptyRunSummary(), uploaded: 1 }
                }),
                30,
                baseNow
            ),
            store.recordRun(
                makeRun({
                    events: [{ kind: "download", path: "B.md", size: 20 }],
                    finishedAt: baseNow + 1000,
                    id: "run-2",
                    summary: { ...createEmptyRunSummary(), downloaded: 1 }
                }),
                30,
                baseNow + 1000
            )
        ]);

        expect(maxActiveWrites).toBe(1);
        const runs: SyncRunRecord[] = store.getRuns();
        expect(runs.length).toBe(2);
        runs[0]!.events.push({ kind: "error", message: "mutated" });
        expect(store.getRuns()[0]?.events.length).toBe(1);
    });
});
