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

    it("enforces strict allowlist in constructor rejecting workspace, plugin code, .git, .trash, other plugins, and invalid configDir", () => {
        const { adapter } = createMockHistoryAdapter();

        expect(
            () =>
                new SyncHistoryStore(
                    adapter,
                    ".obsidian/workspace.json",
                    ".obsidian"
                )
        ).toThrow("Invalid sync history file path");
        expect(
            () =>
                new SyncHistoryStore(
                    adapter,
                    ".obsidian/plugins/vaultdav/main.js",
                    ".obsidian"
                )
        ).toThrow("Invalid sync history file path");
        expect(
            () =>
                new SyncHistoryStore(
                    adapter,
                    ".obsidian/plugins/vaultdav/manifest.json",
                    ".obsidian"
                )
        ).toThrow("Invalid sync history file path");
        expect(
            () =>
                new SyncHistoryStore(
                    adapter,
                    ".obsidian/plugins/vaultdav",
                    ".obsidian"
                )
        ).toThrow("Invalid sync history file path");
        expect(
            () =>
                new SyncHistoryStore(
                    adapter,
                    ".obsidian/plugins/other-plugin/sync-history.json",
                    ".obsidian"
                )
        ).toThrow("Invalid sync history file path");
        expect(
            () => new SyncHistoryStore(adapter, ".git/config", ".obsidian")
        ).toThrow("Invalid sync history file path");
        expect(
            () =>
                new SyncHistoryStore(
                    adapter,
                    ".git/plugins/vaultdav/sync-history.json",
                    ".git"
                )
        ).toThrow("Invalid sync history file path");
        expect(
            () =>
                new SyncHistoryStore(
                    adapter,
                    ".git/plugins/vaultdav/sync-history.json"
                )
        ).toThrow("Invalid sync history file path");
        expect(
            () => new SyncHistoryStore(adapter, ".trash/note.md", ".obsidian")
        ).toThrow("Invalid sync history file path");
        expect(
            () =>
                new SyncHistoryStore(
                    adapter,
                    ".obsidian/plugins/vaultdav/sync-history.json",
                    "../escape"
                )
        ).toThrow("Invalid sync history file path");
        expect(
            () =>
                new SyncHistoryStore(
                    adapter,
                    "custom-config/plugins/vaultdav/sync-history.json",
                    "custom-config"
                )
        ).not.toThrow();
        expect(
            () =>
                new SyncHistoryStore(
                    adapter,
                    ".obsidian/plugins/vaultdav/sync-history.json"
                )
        ).not.toThrow();
    });

    it("prevents lost updates on cold-start concurrent recordRun() and prevents stale load() from clobbering clear() or recordRun()", async () => {
        const files: Map<string, string> = new Map<string, string>();
        let delayReads: boolean = true;
        const adapter: DataAdapter = {
            exists: async (path: string): Promise<boolean> => {
                if (delayReads) {
                    await new Promise<void>((resolve: () => void) => {
                        setTimeout(resolve, 10);
                    });
                }
                return files.has(path);
            },
            mkdir: async (): Promise<void> => undefined,
            read: async (path: string): Promise<string> => {
                if (delayReads) {
                    await new Promise<void>((resolve: () => void) => {
                        setTimeout(resolve, 20);
                    });
                }
                return files.get(path) ?? '{"runs":[],"version":1}';
            },
            write: async (path: string, data: string): Promise<void> => {
                await new Promise<void>((resolve: () => void) => {
                    setTimeout(resolve, 5);
                });
                files.set(path, data);
            }
        } as unknown as DataAdapter;

        // Cold-start concurrent recordRun() must retain both runs
        const coldStore: SyncHistoryStore = new SyncHistoryStore(
            adapter,
            historyPath,
            ".obsidian"
        );
        await Promise.all([
            coldStore.recordRun(
                makeRun({
                    events: [{ kind: "upload", path: "First.md", size: 10 }],
                    finishedAt: baseNow,
                    id: "cold-1",
                    summary: { ...createEmptyRunSummary(), uploaded: 1 }
                }),
                30,
                baseNow
            ),
            coldStore.recordRun(
                makeRun({
                    events: [{ kind: "download", path: "Second.md", size: 20 }],
                    finishedAt: baseNow + 1000,
                    id: "cold-2",
                    summary: { ...createEmptyRunSummary(), downloaded: 1 }
                }),
                30,
                baseNow + 1000
            )
        ]);
        expect(coldStore.getRuns().map((r: SyncRunRecord) => r.id)).toEqual([
            "cold-2",
            "cold-1"
        ]);

        // Stale load() overlapping with clear() must not resurrect cleared runs
        const loadDuringClear: Promise<unknown> = coldStore.load(30, baseNow + 2000);
        const clearOp: Promise<void> = coldStore.clear();
        await Promise.all([loadDuringClear, clearOp]);
        expect(coldStore.getRuns()).toEqual([]);

        // Stale load() overlapping with recordRun() must not drop the new run
        await coldStore.recordRun(
            makeRun({
                events: [{ kind: "upload", path: "Seed.md", size: 10 }],
                finishedAt: baseNow + 3000,
                id: "seed-run",
                summary: { ...createEmptyRunSummary(), uploaded: 1 }
            }),
            30,
            baseNow + 3000
        );
        const loadDuringRecord: Promise<unknown> = coldStore.load(30, baseNow + 4000);
        const recordOp: Promise<SyncRunRecord[]> = coldStore.recordRun(
            makeRun({
                events: [{ kind: "upload", path: "Fresh.md", size: 15 }],
                finishedAt: baseNow + 4000,
                id: "fresh-run",
                summary: { ...createEmptyRunSummary(), uploaded: 1 }
            }),
            30,
            baseNow + 4000
        );
        await Promise.all([loadDuringRecord, recordOp]);
        expect(coldStore.getRuns().map((r: SyncRunRecord) => r.id)).toEqual([
            "fresh-run",
            "seed-run"
        ]);
        delayReads = false;
    });

    it("blocks ReDoS messages and redacts huge truncated credential URLs without leaking password prefixes", async () => {
        const { adapter, files } = createMockHistoryAdapter();
        const store: SyncHistoryStore = new SyncHistoryStore(
            adapter,
            historyPath,
            ".obsidian"
        );

        const redosMsg: string = "a".repeat(100_000);
        const hugeSecretUrl: string = `Failed: https://alice:${"p".repeat(30_000)}@cloud.example.com/dav`;
        const startMs: number = performance.now();
        await store.recordRun(
            makeRun({
                events: [
                    { kind: "error", message: redosMsg, path: "Redos.md" },
                    { kind: "error", message: hugeSecretUrl, path: "Secret.md" }
                ],
                finishedAt: baseNow,
                id: "redos-run",
                status: "partial",
                summary: { ...createEmptyRunSummary(), errors: 2 }
            }),
            30,
            baseNow
        );
        const elapsedMs: number = performance.now() - startMs;

        expect(elapsedMs).toBeLessThan(250);
        const persisted: string = files.get(historyPath) ?? "";
        expect(persisted).not.toContain("alice:");
        expect(persisted).not.toContain("pppppp");
        expect(persisted).toContain("https://[REDACTED]");
    });

    it("handles O(N) large-scale run eviction, Phase C priority sorting, stat() pre-check, and 4 MB read limit", async () => {
        // 1. O(N) eviction with 20,000 runs (10k newer routine + 10k older critical)
        const manyRuns: SyncRunRecord[] = [];
        for (let i: number = 0; i < 10_000; i += 1) {
            manyRuns.push(
                makeRun({
                    finishedAt: baseNow - (20 * dayMs) + i * 1000,
                    id: `old-crit-${i}`,
                    status: "failed",
                    summary: { ...createEmptyRunSummary(), errors: 1 }
                })
            );
            manyRuns.push(
                makeRun({
                    finishedAt: baseNow - (5 * dayMs) + i * 1000,
                    id: `new-clean-${i}`,
                    summary: { ...createEmptyRunSummary(), uploaded: 1 }
                })
            );
        }
        const startPruneMs: number = performance.now();
        const pruned: SyncRunRecord[] = pruneHistoryRuns(
            manyRuns,
            baseNow,
            30,
            MAX_HISTORY_RUNS
        );
        const pruneElapsedMs: number = performance.now() - startPruneMs;
        expect(pruneElapsedMs).toBeLessThan(300);
        expect(pruned.length).toBe(MAX_HISTORY_RUNS);
        expect(pruned.every((r: SyncRunRecord) => isCriticalRun(r))).toBe(true);
        expect(pruned[0]?.id).toBe("old-crit-9999");

        // 2. Phase C must prioritize an error even when it appears at the END of latest.events
        const tailErrorEvents: SyncLogEvent[] = [];
        for (let i: number = 0; i < 40; i += 1) {
            tailErrorEvents.push({
                kind: "upload",
                path: `Folder/SubFolder/RoutineUploadItem-${i}.md`,
                size: 512
            });
        }
        tailErrorEvents.push({
            kind: "error",
            message: "Critical tail failure",
            path: "Critical.md"
        });
        const phaseCRun: SyncRunRecord = makeRun({
            events: tailErrorEvents,
            finishedAt: baseNow,
            id: "phase-c-tail-error",
            status: "partial",
            summary: { ...createEmptyRunSummary(), errors: 1, uploaded: 40 }
        });
        const trimmedPhaseC: SyncRunRecord[] = pruneHistoryRuns(
            [phaseCRun],
            baseNow,
            30,
            100,
            1200
        );
        expect(trimmedPhaseC.length).toBe(1);
        expect(trimmedPhaseC[0]?.events[0]?.kind).toBe("error");
        expect(trimmedPhaseC[0]?.events[0]?.path).toBe("Critical.md");
        expect(
            new TextEncoder().encode(
                JSON.stringify({
                    runs: trimmedPhaseC,
                    version: CURRENT_HISTORY_VERSION
                })
            ).byteLength
        ).toBeLessThanOrEqual(1200);

        // 3. load() rejects huge file via stat() BEFORE calling read()
        const readSpy = vi.fn(async (): Promise<string> => '{"runs":[],"version":1}');
        const statAdapter: DataAdapter = {
            exists: async (): Promise<boolean> => true,
            mkdir: async (): Promise<void> => undefined,
            read: readSpy,
            stat: async () => ({
                ctime: 0,
                mtime: 0,
                size: 10 * 1024 * 1024,
                type: "file" as const
            }),
            write: async (): Promise<void> => undefined
        } as unknown as DataAdapter;
        const warnSpy = vi.spyOn(log, "warn").mockImplementation((): void => undefined);
        const statStore: SyncHistoryStore = new SyncHistoryStore(
            statAdapter,
            historyPath,
            ".obsidian"
        );
        const oversizedStatResult = await statStore.load(30, baseNow);
        expect(oversizedStatResult.runs).toEqual([]);
        expect(readSpy).not.toHaveBeenCalled();

        // 4. load() rejects >4 MB file even when stat() is unavailable
        const { adapter: bigAdapter, files: bigFiles } = createMockHistoryAdapter();
        bigFiles.set(historyPath, "x".repeat(4 * 1024 * 1024 + 1));
        const bigStore: SyncHistoryStore = new SyncHistoryStore(
            bigAdapter,
            historyPath,
            ".obsidian"
        );
        const oversizedReadResult = await bigStore.load(30, baseNow);
        expect(oversizedReadResult.runs).toEqual([]);
        warnSpy.mockRestore();
    });

    it("rejects unsafe integer overflows and Object.prototype event kind lookups", async () => {
        const { adapter, files } = createMockHistoryAdapter();
        const extremePayload: string = JSON.stringify({
            runs: [
                {
                    collapsedCount: 1e308,
                    detailsPruned: false,
                    durationMs: 1e308,
                    events: [
                        {
                            kind: "upload",
                            path: "Extreme.md",
                            size: Number.MAX_SAFE_INTEGER + 100
                        }
                    ],
                    finishedAt: baseNow - 2000,
                    id: "extreme-overflow",
                    omittedEvents: 1e308,
                    startedAt: baseNow - 2100,
                    status: "success",
                    summary: {
                        ...createEmptyRunSummary(),
                        deletedLocal: 1e308,
                        uploaded: Number.MAX_VALUE
                    },
                    trigger: "manual"
                },
                {
                    collapsedCount: Number.MAX_SAFE_INTEGER,
                    detailsPruned: false,
                    durationMs: 10,
                    events: [],
                    finishedAt: baseNow - 1000,
                    id: "noop-max",
                    omittedEvents: 0,
                    startedAt: baseNow - 1010,
                    status: "success",
                    summary: createEmptyRunSummary(),
                    trigger: "auto"
                }
            ],
            version: CURRENT_HISTORY_VERSION
        });
        files.set(historyPath, extremePayload);

        const store: SyncHistoryStore = new SyncHistoryStore(
            adapter,
            historyPath,
            ".obsidian"
        );
        await store.load(30, baseNow);
        const loadedRuns: SyncRunRecord[] = store.getRuns();
        const extremeRun: SyncRunRecord | undefined = loadedRuns.find(
            (r: SyncRunRecord) => r.id === "extreme-overflow"
        );
        expect(extremeRun?.collapsedCount).toBe(1);
        expect(extremeRun?.durationMs).toBe(100);
        expect(extremeRun?.omittedEvents).toBe(0);
        expect(extremeRun?.summary.deletedLocal).toBe(0);
        expect(extremeRun?.summary.uploaded).toBe(0);
        expect(extremeRun?.events[0]?.size).toBeUndefined();

        // Folding onto a MAX_SAFE_INTEGER no-op saturates instead of overflowing to Infinity/null
        await store.recordRun(
            makeRun({
                collapsedCount: 5,
                finishedAt: baseNow,
                id: "noop-fold-overflow",
                startedAt: baseNow - 5,
                trigger: "auto"
            }),
            30,
            baseNow
        );
        const afterFold: SyncRunRecord | undefined = store.getRuns()[0];
        expect(afterFold?.collapsedCount).toBe(Number.MAX_SAFE_INTEGER);
        expect(Number.isSafeInteger(afterFold?.collapsedCount)).toBe(true);
        expect(files.get(historyPath)).not.toContain('"collapsedCount":null');

        // Prototype keys in capRunEvents() must not resolve to Object.prototype functions
        const protoEvents: SyncLogEvent[] = [
            { kind: "toString" as unknown as SyncLogEvent["kind"], path: "Proto.md" },
            { kind: "constructor" as unknown as SyncLogEvent["kind"], path: "Ctor.md" },
            { kind: "error", message: "Real error", path: "Err.md" }
        ];
        const capped = capRunEvents(protoEvents, 1);
        expect(capped.events).toEqual([
            { kind: "error", message: "Real error", path: "Err.md" }
        ]);
        expect(capped.omittedEvents).toBe(2);
    });

    it("persists bytesUploaded/bytesDownloaded and backfills legacy runs missing byte totals from events", async () => {
        const { adapter, files }: MockHistoryFs = createMockHistoryAdapter();
        const historyPath: string = ".obsidian/plugins/vaultdav/sync-history.json";
        const baseNow: number = Date.UTC(2026, 10, 24, 18, 0, 0);

        const legacyPayload: string = JSON.stringify({
            runs: [
                {
                    collapsedCount: 1,
                    detailsPruned: false,
                    durationMs: 400,
                    events: [
                        { isDirectory: false, kind: "upload", path: "A.md", size: 120 },
                        { isDirectory: false, kind: "download", path: "B.md", size: 300 },
                        {
                            conflictCopyPath: "C.conflict-20261124-120000.md",
                            isDirectory: false,
                            kind: "conflict",
                            path: "C.md",
                            resolution: "keep_both",
                            size: 80
                        },
                        {
                            isDirectory: false,
                            kind: "conflict",
                            path: "D.md",
                            resolution: "identical",
                            size: 50
                        }
                    ],
                    finishedAt: baseNow - 5000,
                    id: "legacy-run",
                    omittedEvents: 0,
                    startedAt: baseNow - 5400,
                    status: "success",
                    summary: {
                        conflictsIdentical: 1,
                        conflictsKeepBoth: 1,
                        conflictsNewestWins: 0,
                        conflictsResolved: 2,
                        deletedLocal: 0,
                        deletedLocalDirs: 0,
                        deletedRemote: 0,
                        deletedRemoteDirs: 0,
                        dirsCreatedLocal: 0,
                        dirsCreatedRemote: 0,
                        downloaded: 1,
                        errors: 0,
                        uploaded: 1,
                        warnings: 0
                    },
                    trigger: "manual"
                },
                {
                    collapsedCount: 1,
                    detailsPruned: false,
                    durationMs: 300,
                    events: [],
                    finishedAt: baseNow - 1000,
                    id: "modern-run",
                    omittedEvents: 0,
                    startedAt: baseNow - 1300,
                    status: "success",
                    summary: {
                        ...createEmptyRunSummary(),
                        bytesDownloaded: 2048,
                        bytesUploaded: 1024,
                        downloaded: 1,
                        uploaded: 1
                    },
                    trigger: "manual"
                }
            ],
            version: CURRENT_HISTORY_VERSION
        });
        files.set(historyPath, legacyPayload);

        const store: SyncHistoryStore = new SyncHistoryStore(
            adapter,
            historyPath,
            ".obsidian"
        );
        await store.load(30, baseNow);
        const loadedRuns: SyncRunRecord[] = store.getRuns();
        const modernRun: SyncRunRecord | undefined = loadedRuns.find(
            (r: SyncRunRecord) => r.id === "modern-run"
        );
        const legacyRun: SyncRunRecord | undefined = loadedRuns.find(
            (r: SyncRunRecord) => r.id === "legacy-run"
        );
        expect(modernRun?.summary.bytesUploaded).toBe(1024);
        expect(modernRun?.summary.bytesDownloaded).toBe(2048);
        expect(legacyRun?.summary.bytesUploaded).toBe(200);
        expect(legacyRun?.summary.bytesDownloaded).toBe(350);
    });
});
