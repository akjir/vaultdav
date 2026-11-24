import type { App, TFile } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { log } from "../src/log";
import type VaultDavPlugin from "../src/main";
import { createEmptyRunSummary } from "../src/sync/history";
import type {
    ActiveConflictItem,
    ConflictResolutionMode,
    SyncEventKind,
    SyncLogEvent,
    SyncRunRecord
} from "../src/types";
import {
    calculateTotalTransferBytes,
    collectActiveConflicts,
    CONFLICT_PAGE_SIZE,
    EVENT_PAGE_SIZE,
    formatDateGroupLabel,
    formatDuration,
    formatRunSummaryMarkdown,
    formatTimeOfDay,
    formatTimestamp,
    matchesEventFilter,
    matchesRunFilter,
    RUN_PAGE_SIZE,
    SYNC_LOG_VIEW_TYPE,
    SyncLogView
} from "../src/ui/sync_log_view";
import {
    TFile as MockTFile,
    TFolder as MockTFolder,
    WorkspaceLeaf as MockWorkspaceLeaf
} from "./obsidian_mock";

function createMockTFile(path: string, mtime: number, size: number): TFile {
    return {
        basename: path,
        extension: "md",
        name: path.split("/").pop() ?? path,
        path,
        stat: {
            ctime: mtime,
            mtime,
            size
        }
    } as unknown as TFile;
}

function createSampleRun(
    overrides: Partial<SyncRunRecord> & { id: string }
): SyncRunRecord {
    return {
        collapsedCount: overrides.collapsedCount ?? 1,
        detailsPruned: overrides.detailsPruned ?? false,
        durationMs: overrides.durationMs ?? 1450,
        events: overrides.events ?? [],
        finishedAt: overrides.finishedAt ?? 1_760_000_000_000,
        firstCollapsedAt: overrides.firstCollapsedAt,
        id: overrides.id,
        omittedEvents: overrides.omittedEvents ?? 0,
        startedAt: overrides.startedAt ?? 1_759_999_998_550,
        status: overrides.status ?? "success",
        summary: {
            ...createEmptyRunSummary(),
            ...(overrides.summary ?? {})
        },
        trigger: overrides.trigger ?? "manual"
    };
}

describe("SyncLogView and formatting helpers", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it("formats durations, timestamps, date groups, active conflicts, run/event filters, and Markdown summaries accurately", () => {
        expect(formatDuration(0)).toBe("0 ms");
        expect(formatDuration(Number.NaN)).toBe("0 ms");
        expect(formatDuration(450)).toBe("450 ms");
        expect(formatDuration(1450)).toBe("1.4 s");
        expect(formatDuration(125_000)).toBe("2m 5s");

        expect(formatTimestamp(0)).toBe("Unknown time");
        expect(formatTimestamp(Number.NaN)).toBe("Unknown time");
        expect(formatTimestamp(1_760_000_000_000)).toMatch(
            /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/
        );
        expect(formatTimeOfDay(0)).toBe("Unknown time");
        expect(formatTimeOfDay(Number.NaN)).toBe("Unknown time");
        expect(formatTimeOfDay(1_760_000_000_000)).toMatch(
            /^\d{2}:\d{2}:\d{2}$/
        );

        const referenceNow: number = new Date(2026, 10, 24, 15, 0, 0).getTime();
        const sameDayTs: number = new Date(2026, 10, 24, 9, 30, 0).getTime();
        const yesterdayTs: number = new Date(2026, 10, 23, 21, 15, 0).getTime();
        const olderTs: number = new Date(2026, 10, 20, 8, 0, 0).getTime();
        expect(formatDateGroupLabel(0, referenceNow)).toBe("Unknown date");
        expect(formatDateGroupLabel(Number.NaN, referenceNow)).toBe(
            "Unknown date"
        );
        expect(formatDateGroupLabel(sameDayTs, referenceNow)).toBe("Today");
        expect(formatDateGroupLabel(yesterdayTs, referenceNow)).toBe(
            "Yesterday"
        );
        expect(formatDateGroupLabel(olderTs, referenceNow)).toBe("2026-11-20");

        const files: TFile[] = [
            createMockTFile("Notes/Daily.md", 1000, 100),
            createMockTFile(
                "Notes/Daily.conflict-20261124-100000.md",
                2000,
                512
            ),
            createMockTFile(
                "Notes/Meeting.conflict-20261124-120000-2.md",
                5000,
                1024
            )
        ];
        const active = collectActiveConflicts(files);
        expect(active).toEqual([
            {
                conflictPath: "Notes/Meeting.conflict-20261124-120000-2.md",
                mtime: 5000,
                originalPath: "Notes/Meeting.md",
                size: 1024,
                timestampUtc: "2026-11-24 12:00:00 UTC"
            },
            {
                conflictPath: "Notes/Daily.conflict-20261124-100000.md",
                mtime: 2000,
                originalPath: "Notes/Daily.md",
                size: 512,
                timestampUtc: "2026-11-24 10:00:00 UTC"
            }
        ]);

        const conflictEvent: SyncLogEvent = {
            conflictCopyPath: "Notes/Daily.conflict-20261124-100000.md",
            kind: "conflict",
            path: "Notes/Daily.md",
            resolution: "keep_both",
            size: 512
        };
        expect(matchesEventFilter(conflictEvent, "conflicts", "")).toBe(true);
        expect(matchesEventFilter(conflictEvent, "uploads", "")).toBe(false);
        expect(matchesEventFilter(conflictEvent, "all", "daily.conflict")).toBe(
            true
        );
        expect(matchesEventFilter(conflictEvent, "all", "nonexistent")).toBe(
            false
        );

        const conflictRun: SyncRunRecord = createSampleRun({
            events: [conflictEvent],
            id: "run-1",
            summary: {
                ...createEmptyRunSummary(),
                conflictsKeepBoth: 1,
                conflictsResolved: 1,
                uploaded: 2
            }
        });
        const noopRun: SyncRunRecord = createSampleRun({
            collapsedCount: 4,
            events: [],
            id: "run-noop",
            trigger: "auto"
        });
        const uploadRun: SyncRunRecord = createSampleRun({
            events: [
                {
                    isDirectory: false,
                    kind: "upload",
                    path: "Projects/Budget.md",
                    size: 1024
                }
            ],
            id: "run-upload",
            summary: {
                ...createEmptyRunSummary(),
                uploaded: 1
            }
        });

        expect(matchesRunFilter(noopRun, "all", "")).toBe(true);
        expect(matchesRunFilter(noopRun, "changes", "")).toBe(false);
        expect(matchesRunFilter(noopRun, "issues", "")).toBe(false);
        expect(matchesRunFilter(uploadRun, "changes", "")).toBe(true);
        expect(matchesRunFilter(uploadRun, "issues", "")).toBe(false);
        expect(matchesRunFilter(conflictRun, "issues", "")).toBe(true);
        expect(matchesRunFilter(uploadRun, "all", "budget.md")).toBe(true);
        expect(matchesRunFilter(uploadRun, "all", "missing-note")).toBe(false);

        const totals = calculateTotalTransferBytes([
            conflictRun,
            noopRun,
            uploadRun
        ]);
        expect(totals).toEqual({ downloaded: 0, uploaded: 1536 });

        const markdown: string = formatRunSummaryMarkdown(conflictRun, active);
        expect(markdown).toContain("# VaultDAV sync summary");
        expect(markdown).toContain("- Uploaded: 2 (512 B)");
        expect(markdown).toContain("- Downloaded: 0 (0 B)");
        expect(markdown).toContain("Notes/Daily.conflict-20261124-100000.md");
        expect(markdown).toContain("## Active conflict copies (2)");
    });

    it("omits Overview, renders active conflicts, grouped run history, inline run details, filters, search, file opening, copy summary, and two-step clear without inline styles", async () => {
        const notifySpy = vi
            .spyOn(log, "notify")
            .mockImplementation((): void => undefined);
        const openLinkTextSpy = vi.fn().mockResolvedValue(undefined);
        const vaultFiles: TFile[] = [
            createMockTFile("Notes/Daily.md", 1000, 100),
            createMockTFile(
                "Notes/Daily.conflict-20261124-100000.md",
                2000,
                2048
            )
        ];
        const existingSet: Set<string> = new Set<string>(
            vaultFiles.map((f: TFile) => f.path)
        );

        const mockApp: App = {
            vault: {
                getAbstractFileByPath: (path: string) =>
                    existingSet.has(path) ? ({ path } as TFile) : null,
                getFiles: (): TFile[] => vaultFiles
            },
            workspace: {
                openLinkText: openLinkTextSpy
            }
        } as unknown as App;

        let historyRuns: SyncRunRecord[] = [
            createSampleRun({
                events: [
                    {
                        conflictCopyPath:
                            "Notes/Daily.conflict-20261124-100000.md",
                        isDirectory: false,
                        kind: "conflict",
                        path: "Notes/Daily.md",
                        resolution: "keep_both",
                        size: 2048
                    },
                    {
                        isDirectory: false,
                        kind: "upload",
                        path: "Notes/Alpha.md",
                        size: 512
                    },
                    {
                        isDirectory: false,
                        kind: "error",
                        message: "HTTP 423 Locked",
                        path: "Notes/Missing.md"
                    }
                ],
                id: "run-latest",
                omittedEvents: 12,
                status: "partial",
                summary: {
                    ...createEmptyRunSummary(),
                    conflictsKeepBoth: 1,
                    conflictsResolved: 1,
                    errors: 1,
                    uploaded: 1
                }
            }),
            createSampleRun({
                collapsedCount: 5,
                events: [],
                finishedAt: 1_759_999_000_000,
                firstCollapsedAt: 1_759_995_000_000,
                id: "run-noop",
                status: "success",
                trigger: "auto"
            })
        ];

        const triggerSyncSpy = vi.fn().mockResolvedValue(null);
        const clearSyncHistorySpy = vi.fn(async (): Promise<void> => {
            historyRuns = [];
        });
        const mockPlugin: VaultDavPlugin = {
            clearSyncHistory: clearSyncHistorySpy,
            getSyncHistoryRuns: (): SyncRunRecord[] => historyRuns,
            isSyncing: false,
            loadSyncHistory: vi.fn(async (): Promise<SyncRunRecord[]> => historyRuns),
            triggerSync: triggerSyncSpy
        } as unknown as VaultDavPlugin;

        const leaf: MockWorkspaceLeaf = new MockWorkspaceLeaf(mockApp);
        const view: SyncLogView = new SyncLogView(
            leaf as unknown as import("obsidian").WorkspaceLeaf,
            mockPlugin
        );

        expect(view.getViewType()).toBe(SYNC_LOG_VIEW_TYPE);
        expect(view.getDisplayText()).toBe("Sync log");
        expect(view.getIcon()).toBe("history");

        await view.onOpen();

        // Overview section and stat grid must be completely removed
        expect(view.contentEl.querySelectorAll("[style]").length).toBe(0);
        expect(view.contentEl.querySelector(".vaultdav-log-stat-grid")).toBeNull();
        const sectionTitles: string[] = Array.from(
            view.contentEl.querySelectorAll(".vaultdav-log-section-title")
        ).map((el: Element) => el.textContent ?? "");
        expect(sectionTitles).not.toContain("Overview");

        // Active conflicts remain intact and clickable
        expect(view.contentEl.textContent).toContain("Active conflict copies (1)");
        expect(view.contentEl.textContent).toContain(
            "Notes/Daily.conflict-20261124-100000.md"
        );
        expect(view.contentEl.textContent).toContain(
            "12 routine event(s) omitted"
        );

        // Zero-count event filter chips (Downloads, Deletions, Folders) are omitted
        const chipLabels: string[] = Array.from(
            view.contentEl.querySelectorAll(
                ".vaultdav-log-details-section .vaultdav-log-chip"
            )
        ).map((el: Element) => el.textContent ?? "");
        expect(chipLabels).toEqual([
            "All (3)",
            "Conflicts (1)",
            "Errors & warnings (1)",
            "Uploads (1)"
        ]);

        // Clicking an active conflict copy opens it in Obsidian workspace
        const openCopyBtn: HTMLButtonElement | undefined = Array.from(
            view.contentEl.querySelectorAll("button")
        ).find((btn: HTMLButtonElement) => btn.textContent === "Open copy");
        expect(openCopyBtn).toBeDefined();
        openCopyBtn?.click();
        await Promise.resolve();
        expect(openLinkTextSpy).toHaveBeenCalledWith(
            "Notes/Daily.conflict-20261124-100000.md",
            "",
            false
        );

        // Clicking a missing file path notifies instead of creating an empty note
        const missingBtn: HTMLButtonElement | undefined = Array.from(
            view.contentEl.querySelectorAll("button")
        ).find((btn: HTMLButtonElement) => btn.textContent === "Notes/Missing.md");
        expect(missingBtn).toBeDefined();
        missingBtn?.click();
        await Promise.resolve();
        expect(notifySpy).toHaveBeenCalledWith(
            "File no longer exists in vault."
        );

        // Event filter chip "Conflicts (1)" narrows events to only the conflict row
        const conflictChip: HTMLButtonElement | undefined = Array.from(
            view.contentEl.querySelectorAll<HTMLButtonElement>(
                ".vaultdav-log-details-section button"
            )
        ).find((btn: HTMLButtonElement) => btn.textContent === "Conflicts (1)");
        expect(conflictChip).toBeDefined();
        conflictChip?.click();
        expect(view.contentEl.querySelectorAll(".vaultdav-log-event-row").length).toBe(
            1
        );

        // Path search filter filters visible events dynamically
        const searchInput: HTMLInputElement | null = view.contentEl.querySelector(
            ".vaultdav-log-search-input"
        );
        expect(searchInput).not.toBeNull();
        expect(searchInput?.getAttribute("autocapitalize")).toBe("none");
        expect(searchInput?.getAttribute("autocorrect")).toBe("off");
        expect(searchInput?.autocomplete).toBe("off");
        expect(searchInput?.spellcheck).toBe(false);
        if (searchInput !== null) {
            searchInput.value = "does-not-exist";
            searchInput.dispatchEvent(new Event("input"));
        }
        expect(view.contentEl.textContent).toContain(
            "No events match the current filter."
        );

        // Clicking a run updates Run details in place without rebuilding the run list
        const runListBefore: Element | null = view.contentEl.querySelector(
            ".vaultdav-log-run-list"
        );
        const runItems: HTMLButtonElement[] = Array.from(
            view.contentEl.querySelectorAll(".vaultdav-log-run-item")
        );
        expect(runItems.length).toBe(2);
        runItems[1]?.click();
        expect(view.contentEl.querySelector(".vaultdav-log-run-list")).toBe(
            runListBefore
        );
        expect(runItems[1]?.classList.contains("is-selected")).toBe(true);
        expect(runItems[0]?.classList.contains("is-selected")).toBe(false);
        expect(view.contentEl.textContent).toContain(
            "5 consecutive no-op checks folded"
        );
        // Zero-event no-op run hides redundant event search input
        expect(
            view.contentEl.querySelector(
                ".vaultdav-log-details-section .vaultdav-log-search-input"
            )
        ).toBeNull();

        // Copy summary uses clipboard
        const writeTextSpy = vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            value: { writeText: writeTextSpy }
        });
        const copyBtn: HTMLButtonElement | undefined = Array.from(
            view.contentEl.querySelectorAll("button")
        ).find((btn: HTMLButtonElement) => btn.textContent === "Copy summary");
        copyBtn?.click();
        await Promise.resolve();
        expect(writeTextSpy).toHaveBeenCalledTimes(1);
        expect(notifySpy).toHaveBeenCalledWith(
            "Sync summary copied to clipboard."
        );

        // Two-step clear history
        const clearBtn: HTMLButtonElement | undefined = Array.from(
            view.contentEl.querySelectorAll("button")
        ).find((btn: HTMLButtonElement) => btn.textContent === "Clear history");
        clearBtn?.click();
        expect(clearSyncHistorySpy).not.toHaveBeenCalled();

        const confirmBtn: HTMLButtonElement | undefined = Array.from(
            view.contentEl.querySelectorAll("button")
        ).find((btn: HTMLButtonElement) => btn.textContent === "Confirm clear");
        expect(confirmBtn).toBeDefined();
        confirmBtn?.click();
        await Promise.resolve();
        expect(clearSyncHistorySpy).toHaveBeenCalledTimes(1);
        expect(view.contentEl.textContent).toContain(
            "No sync runs recorded yet."
        );
        expect(
            view.contentEl.querySelector(".vaultdav-log-details-section")
        ).toBeNull();

        await view.onClose();
        expect(view.contentEl.childElementCount).toBe(0);
    });

    it("stays clean and responsive with 120+ sync runs, 120+ events, 15+ conflict copies, run filters, pagination, and auto-follow selection", async () => {
        const baseNow: number = Date.now();
        const manyConflicts: TFile[] = [];
        for (let i: number = 0; i < CONFLICT_PAGE_SIZE + 5; i += 1) {
            const pad: string = String(i).padStart(2, "0");
            manyConflicts.push(
                createMockTFile(
                    `Notes/Note-${pad}.conflict-20261124-1000${pad}.md`,
                    baseNow - i * 1000,
                    256 + i
                )
            );
        }

        const largeEventList: SyncLogEvent[] = [];
        for (let i: number = 0; i < EVENT_PAGE_SIZE + 25; i += 1) {
            largeEventList.push({
                isDirectory: false,
                kind: "upload",
                path: `Bulk/File-${String(i).padStart(3, "0")}.md`,
                size: 128 + i
            });
        }

        const totalRuns: number = 120;
        let historyRuns: SyncRunRecord[] = [];
        for (let i: number = 0; i < totalRuns; i += 1) {
            const finishedAt: number = baseNow - i * 3_600_000;
            if (i === 0) {
                historyRuns.push(
                    createSampleRun({
                        events: largeEventList,
                        finishedAt,
                        id: "run-000",
                        startedAt: finishedAt - 2000,
                        summary: {
                            ...createEmptyRunSummary(),
                            uploaded: largeEventList.length
                        }
                    })
                );
            } else if (i % 30 === 0) {
                historyRuns.push(
                    createSampleRun({
                        events: [
                            {
                                isDirectory: false,
                                kind: "error",
                                message: `Timeout on file ${i}`,
                                path: `Errors/Fail-${i}.md`
                            }
                        ],
                        finishedAt,
                        id: `run-${String(i).padStart(3, "0")}`,
                        startedAt: finishedAt - 500,
                        status: "partial",
                        summary: {
                            ...createEmptyRunSummary(),
                            errors: 1
                        }
                    })
                );
            } else if (i % 2 === 0) {
                historyRuns.push(
                    createSampleRun({
                        events: [
                            {
                                isDirectory: false,
                                kind: "download",
                                path: `Sync/Item-${i}.md`,
                                size: 512
                            }
                        ],
                        finishedAt,
                        id: `run-${String(i).padStart(3, "0")}`,
                        startedAt: finishedAt - 300,
                        summary: {
                            ...createEmptyRunSummary(),
                            downloaded: 1
                        }
                    })
                );
            } else {
                historyRuns.push(
                    createSampleRun({
                        collapsedCount: 3,
                        events: [],
                        finishedAt,
                        firstCollapsedAt: finishedAt - 900_000,
                        id: `run-${String(i).padStart(3, "0")}`,
                        startedAt: finishedAt - 100,
                        trigger: "auto"
                    })
                );
            }
        }

        const mockApp: App = {
            vault: {
                getAbstractFileByPath: (): TFile | null => null,
                getFiles: (): TFile[] => manyConflicts
            },
            workspace: {
                openLinkText: vi.fn().mockResolvedValue(undefined)
            }
        } as unknown as App;

        const mockPlugin: VaultDavPlugin = {
            clearSyncHistory: vi.fn().mockResolvedValue(undefined),
            getSyncHistoryRuns: (): SyncRunRecord[] => historyRuns,
            isSyncing: false,
            loadSyncHistory: vi.fn(async (): Promise<SyncRunRecord[]> => historyRuns),
            triggerSync: vi.fn().mockResolvedValue(null)
        } as unknown as VaultDavPlugin;

        const leaf: MockWorkspaceLeaf = new MockWorkspaceLeaf(mockApp);
        const view: SyncLogView = new SyncLogView(
            leaf as unknown as import("obsidian").WorkspaceLeaf,
            mockPlugin
        );

        await view.onOpen();

        // Active conflicts paginate cleanly at CONFLICT_PAGE_SIZE
        expect(
            view.contentEl.querySelectorAll(".vaultdav-log-conflict-item").length
        ).toBe(CONFLICT_PAGE_SIZE);
        const moreConflictsBtn: HTMLButtonElement | undefined = Array.from(
            view.contentEl.querySelectorAll("button")
        ).find((btn: HTMLButtonElement) =>
            (btn.textContent ?? "").startsWith("Show more conflicts")
        );
        expect(moreConflictsBtn).toBeDefined();
        moreConflictsBtn?.click();
        expect(
            view.contentEl.querySelectorAll(".vaultdav-log-conflict-item").length
        ).toBe(CONFLICT_PAGE_SIZE + 5);

        // Run history paginates cleanly at RUN_PAGE_SIZE and groups runs by date
        expect(
            view.contentEl.querySelectorAll(".vaultdav-log-run-item").length
        ).toBe(RUN_PAGE_SIZE);
        expect(
            view.contentEl.querySelectorAll(".vaultdav-log-date-group").length
        ).toBeGreaterThanOrEqual(1);
        expect(view.contentEl.textContent).toContain(
            `Showing ${RUN_PAGE_SIZE} of ${totalRuns} runs`
        );

        // Clicking "Show more" reveals the next page of runs
        const showMoreRunsBtn: HTMLButtonElement | undefined = Array.from(
            view.contentEl.querySelectorAll("button")
        ).find((btn: HTMLButtonElement) =>
            (btn.textContent ?? "").startsWith("Show more (")
        );
        expect(showMoreRunsBtn).toBeDefined();
        showMoreRunsBtn?.click();
        expect(
            view.contentEl.querySelectorAll(".vaultdav-log-run-item").length
        ).toBe(RUN_PAGE_SIZE * 2);

        // Large single-run event list paginates cleanly at EVENT_PAGE_SIZE
        expect(
            view.contentEl.querySelectorAll(".vaultdav-log-event-row").length
        ).toBe(EVENT_PAGE_SIZE);
        const showMoreEventsBtn: HTMLButtonElement | undefined = Array.from(
            view.contentEl.querySelectorAll("button")
        ).find((btn: HTMLButtonElement) =>
            (btn.textContent ?? "").startsWith("Show more events")
        );
        expect(showMoreEventsBtn).toBeDefined();
        showMoreEventsBtn?.click();
        expect(
            view.contentEl.querySelectorAll(".vaultdav-log-event-row").length
        ).toBe(largeEventList.length);

        // Run filter "Issues" isolates only the 3 error runs out of 120
        const issuesRunChip: HTMLButtonElement | undefined = Array.from(
            view.contentEl.querySelectorAll<HTMLButtonElement>(
                ".vaultdav-log-history-section .vaultdav-log-chip"
            )
        ).find((btn: HTMLButtonElement) => btn.textContent === "Issues (3)");
        expect(issuesRunChip).toBeDefined();
        issuesRunChip?.click();
        expect(
            view.contentEl.querySelectorAll(".vaultdav-log-run-item").length
        ).toBe(3);
        expect(view.contentEl.textContent).toContain("Errors/Fail-30.md");

        // Cross-run search locates a specific run across all 120 entries
        const allRunChip: HTMLButtonElement | undefined = Array.from(
            view.contentEl.querySelectorAll<HTMLButtonElement>(
                ".vaultdav-log-history-section .vaultdav-log-chip"
            )
        ).find((btn: HTMLButtonElement) => btn.textContent === "All (120)");
        allRunChip?.click();

        const runSearchInput: HTMLInputElement | null =
            view.contentEl.querySelector(".vaultdav-log-run-search-input");
        expect(runSearchInput).not.toBeNull();
        expect(runSearchInput?.getAttribute("autocapitalize")).toBe("none");
        expect(runSearchInput?.getAttribute("autocorrect")).toBe("off");
        expect(runSearchInput?.autocomplete).toBe("off");
        expect(runSearchInput?.spellcheck).toBe(false);
        if (runSearchInput !== null) {
            runSearchInput.value = "Fail-90";
            runSearchInput.dispatchEvent(new Event("input"));
        }
        expect(
            view.contentEl.querySelectorAll(".vaultdav-log-run-item").length
        ).toBe(1);
        expect(view.contentEl.textContent).toContain("Errors/Fail-90.md");

        // Clear search and select latest run, then verify refresh auto-follows a newly arriving run
        if (runSearchInput !== null) {
            runSearchInput.value = "";
            runSearchInput.dispatchEvent(new Event("input"));
        }
        const firstRunBtn: HTMLButtonElement | null =
            view.contentEl.querySelector(".vaultdav-log-run-item");
        firstRunBtn?.click();

        const brandNewRun: SyncRunRecord = createSampleRun({
            events: [
                {
                    isDirectory: false,
                    kind: "upload",
                    path: "Notes/BrandNew.md",
                    size: 42
                }
            ],
            finishedAt: baseNow + 60_000,
            id: "run-newest",
            startedAt: baseNow + 59_500,
            summary: {
                ...createEmptyRunSummary(),
                uploaded: 1
            }
        });
        historyRuns = [brandNewRun, ...historyRuns];
        view.refresh();
        expect(view.contentEl.textContent).toContain("Notes/BrandNew.md");

        // When user explicitly selects an older run, a background refresh preserves their selection
        const secondRunBtn: HTMLButtonElement | undefined = Array.from(
            view.contentEl.querySelectorAll<HTMLButtonElement>(
                ".vaultdav-log-run-item"
            )
        )[1];
        secondRunBtn?.click();
        expect(view.contentEl.textContent).toContain("Bulk/File-000.md");

        const backgroundRun: SyncRunRecord = createSampleRun({
            events: [],
            finishedAt: baseNow + 120_000,
            id: "run-bg-noop",
            startedAt: baseNow + 119_900,
            trigger: "auto"
        });
        historyRuns = [backgroundRun, ...historyRuns];
        view.refresh();
        expect(view.contentEl.textContent).toContain("Bulk/File-000.md");
    });

    it("renders compact empty conflict indicator when no active conflicts exist", async () => {
        const mockApp: App = {
            vault: {
                getAbstractFileByPath: (): TFile | null => null,
                getFiles: (): TFile[] => []
            },
            workspace: {
                openLinkText: vi.fn().mockResolvedValue(undefined)
            }
        } as unknown as App;
        const mockPlugin: VaultDavPlugin = {
            clearSyncHistory: vi.fn().mockResolvedValue(undefined),
            getSyncHistoryRuns: (): SyncRunRecord[] => [],
            isSyncing: false,
            loadSyncHistory: vi.fn().mockResolvedValue([]),
            triggerSync: vi.fn().mockResolvedValue(null)
        } as unknown as VaultDavPlugin;

        const leaf: MockWorkspaceLeaf = new MockWorkspaceLeaf(mockApp);
        const view: SyncLogView = new SyncLogView(
            leaf as unknown as import("obsidian").WorkspaceLeaf,
            mockPlugin
        );
        await view.onOpen();

        expect(
            view.contentEl.querySelector(".vaultdav-log-conflicts-empty")
        ).not.toBeNull();
        expect(view.contentEl.textContent).toContain("Active conflict copies");
        expect(view.contentEl.textContent).toContain("None");
        expect(view.contentEl.textContent).toContain(
            "No sync runs recorded yet."
        );
        expect(view.contentEl.querySelectorAll("[style]").length).toBe(0);
    });

    it("displays inline summary pills and compaction notice for detailsPruned runs without showing empty filter controls", async () => {
        const prunedRun: SyncRunRecord = createSampleRun({
            detailsPruned: true,
            events: [],
            id: "run-pruned",
            omittedEvents: 42,
            summary: {
                ...createEmptyRunSummary(),
                bytesDownloaded: 2048,
                bytesUploaded: 3072,
                downloaded: 4,
                uploaded: 12
            }
        });
        const mockApp: App = {
            vault: {
                getAbstractFileByPath: (): TFile | null => null,
                getFiles: (): TFile[] => []
            },
            workspace: {
                openLinkText: vi.fn().mockResolvedValue(undefined)
            }
        } as unknown as App;
        const mockPlugin: VaultDavPlugin = {
            clearSyncHistory: vi.fn().mockResolvedValue(undefined),
            getSyncHistoryRuns: (): SyncRunRecord[] => [prunedRun],
            isSyncing: false,
            loadSyncHistory: vi.fn().mockResolvedValue([prunedRun]),
            triggerSync: vi.fn().mockResolvedValue(null)
        } as unknown as VaultDavPlugin;

        const leaf: MockWorkspaceLeaf = new MockWorkspaceLeaf(mockApp);
        const view: SyncLogView = new SyncLogView(
            leaf as unknown as import("obsidian").WorkspaceLeaf,
            mockPlugin
        );
        await view.onOpen();

        expect(view.contentEl.textContent).toContain("Up 3.0 KB");
        expect(view.contentEl.textContent).toContain("Down 2.0 KB");
        expect(view.contentEl.textContent).toContain("12 uploaded (3.0 KB)");
        expect(view.contentEl.textContent).toContain("4 downloaded (2.0 KB)");
        expect(view.contentEl.textContent).toContain(
            "Detailed events for this older run were compacted"
        );
        expect(view.contentEl.textContent).not.toContain(
            "No changes were needed during this sync."
        );
        expect(
            view.contentEl.querySelector(
                ".vaultdav-log-details-section .vaultdav-log-search-input"
            )
        ).toBeNull();
    });

    it("displays cumulative up/down byte totals in Sync history and updates them when filtering runs", async () => {
        const runs: SyncRunRecord[] = [
            createSampleRun({
                events: [
                    {
                        isDirectory: false,
                        kind: "upload",
                        path: "Docs/Report.pdf",
                        size: 2048
                    },
                    {
                        isDirectory: false,
                        kind: "download",
                        path: "Docs/Guide.pdf",
                        size: 1024
                    }
                ],
                finishedAt: 1_760_000_200_000,
                id: "run-a",
                summary: {
                    ...createEmptyRunSummary(),
                    bytesDownloaded: 1024,
                    bytesUploaded: 2048,
                    downloaded: 1,
                    uploaded: 1
                }
            }),
            createSampleRun({
                events: [
                    {
                        isDirectory: false,
                        kind: "download",
                        path: "Images/Photo.png",
                        size: 4096
                    },
                    {
                        isDirectory: false,
                        kind: "error",
                        message: "HTTP 503",
                        path: "Images/Broken.png"
                    }
                ],
                finishedAt: 1_760_000_100_000,
                id: "run-b",
                status: "partial",
                summary: {
                    ...createEmptyRunSummary(),
                    bytesDownloaded: 4096,
                    bytesUploaded: 512,
                    downloaded: 1,
                    errors: 1
                }
            })
        ];
        const mockApp: App = {
            vault: {
                getAbstractFileByPath: (): TFile | null => null,
                getFiles: (): TFile[] => []
            },
            workspace: {
                openLinkText: vi.fn().mockResolvedValue(undefined)
            }
        } as unknown as App;
        const mockPlugin: VaultDavPlugin = {
            clearSyncHistory: vi.fn().mockResolvedValue(undefined),
            getSyncHistoryRuns: (): SyncRunRecord[] => runs,
            isSyncing: false,
            loadSyncHistory: vi.fn().mockResolvedValue(runs),
            triggerSync: vi.fn().mockResolvedValue(null)
        } as unknown as VaultDavPlugin;

        const leaf: MockWorkspaceLeaf = new MockWorkspaceLeaf(mockApp);
        const view: SyncLogView = new SyncLogView(
            leaf as unknown as import("obsidian").WorkspaceLeaf,
            mockPlugin
        );
        await view.onOpen();

        const totalsBar: Element | null = view.contentEl.querySelector(
            ".vaultdav-log-totals-bar"
        );
        expect(totalsBar).not.toBeNull();
        expect(totalsBar?.textContent).toContain("Up 2.5 KB");
        expect(totalsBar?.textContent).toContain("Down 5.0 KB");

        const issuesChip: HTMLButtonElement | undefined = Array.from(
            view.contentEl.querySelectorAll<HTMLButtonElement>(
                ".vaultdav-log-history-section .vaultdav-log-chip"
            )
        ).find((btn: HTMLButtonElement) => btn.textContent === "Issues (1)");
        issuesChip?.click();

        expect(totalsBar?.textContent).toContain("Up 512 B");
        expect(totalsBar?.textContent).toContain("Down 4.0 KB");
    });

    it("blocks opening excluded config paths, folders, fail-open targets, and linktext (#/|) injection", async () => {
        const notifySpy = vi
            .spyOn(log, "notify")
            .mockImplementation((): void => undefined);
        const warnSpy = vi
            .spyOn(log, "warn")
            .mockImplementation((): void => undefined);

        const hashFile: MockTFile = new MockTFile();
        hashFile.path = "Notes/Report#2026.md";
        const pipeFile: MockTFile = new MockTFile();
        pipeFile.path = "Notes/A|B.md";
        const configFile: MockTFile = new MockTFile();
        configFile.path = "obsidian-config/plugins/vaultdav/data.json";
        const folderEntry: MockTFolder = new MockTFolder();
        folderEntry.path = "Projects";

        const fileMap: Map<string, MockTFile | MockTFolder> = new Map<
            string,
            MockTFile | MockTFolder
        >([
            [configFile.path, configFile],
            [folderEntry.path, folderEntry],
            [hashFile.path, hashFile],
            [pipeFile.path, pipeFile]
        ]);

        const openFileSpy = vi.fn().mockResolvedValue(undefined);
        const openLinkTextSpy = vi.fn().mockResolvedValue(undefined);
        const mockApp: App = {
            vault: {
                configDir: "obsidian-config",
                getAbstractFileByPath: (path: string) => fileMap.get(path) ?? null,
                getFileByPath: (path: string) => {
                    const entry: MockTFile | MockTFolder | undefined =
                        fileMap.get(path);
                    return entry instanceof MockTFile ? entry : null;
                },
                getFiles: (): TFile[] => []
            },
            workspace: {
                getLeaf: vi.fn().mockReturnValue({
                    openFile: openFileSpy
                }),
                openLinkText: openLinkTextSpy
            }
        } as unknown as App;

        const attackRun: SyncRunRecord = createSampleRun({
            events: [
                {
                    conflictCopyPath:
                        "obsidian-config/plugins/vaultdav/data.json",
                    isDirectory: false,
                    kind: "conflict",
                    path: "obsidian-config/plugins/vaultdav/data.json",
                    resolution: "keep_both"
                },
                {
                    kind: "create_local_dir",
                    path: "Projects"
                },
                {
                    isDirectory: false,
                    kind: "upload",
                    path: "Notes/Report#2026.md",
                    size: 128
                },
                {
                    isDirectory: false,
                    kind: "upload",
                    path: "Notes/A|B.md",
                    size: 64
                },
                {
                    isDirectory: false,
                    kind: "error",
                    message: "Folder mismatch",
                    path: "Projects"
                }
            ],
            id: "run-open-attacks",
            status: "partial",
            summary: {
                ...createEmptyRunSummary(),
                conflictsKeepBoth: 1,
                conflictsResolved: 1,
                errors: 1,
                uploaded: 2
            }
        });

        const mockPlugin: VaultDavPlugin = {
            clearSyncHistory: vi.fn().mockResolvedValue(undefined),
            getSyncHistoryRuns: (): SyncRunRecord[] => [attackRun],
            isSyncing: false,
            loadSyncHistory: vi.fn().mockResolvedValue([attackRun]),
            triggerSync: vi.fn().mockResolvedValue(null)
        } as unknown as VaultDavPlugin;

        const leaf: MockWorkspaceLeaf = new MockWorkspaceLeaf(mockApp);
        const view: SyncLogView = new SyncLogView(
            leaf as unknown as import("obsidian").WorkspaceLeaf,
            mockPlugin
        );
        await view.onOpen();

        // Excluded config paths and create_local_dir without isDirectory must not render as clickable buttons
        const clickableTexts: string[] = Array.from(
            view.contentEl.querySelectorAll("button.vaultdav-log-path-link")
        ).map((el: Element) => el.textContent ?? "");
        expect(clickableTexts).not.toContain(
            "obsidian-config/plugins/vaultdav/data.json"
        );

        // Files with # or | open directly via leaf.openFile(TFile), never openLinkText
        const hashBtn: HTMLButtonElement | undefined = Array.from(
            view.contentEl.querySelectorAll<HTMLButtonElement>(
                "button.vaultdav-log-path-link"
            )
        ).find((btn: HTMLButtonElement) => btn.textContent === "Notes/Report#2026.md");
        expect(hashBtn).toBeDefined();
        hashBtn?.click();
        await Promise.resolve();
        expect(openFileSpy).toHaveBeenCalledWith(hashFile);
        expect(openLinkTextSpy).not.toHaveBeenCalled();

        // Clicking an event whose path resolves to a TFolder must never open or create a note
        openFileSpy.mockClear();
        const folderErrorBtn: HTMLButtonElement | undefined = Array.from(
            view.contentEl.querySelectorAll<HTMLButtonElement>(
                "button.vaultdav-log-path-link"
            )
        ).find((btn: HTMLButtonElement) => btn.textContent === "Projects");
        folderErrorBtn?.click();
        await Promise.resolve();
        expect(openFileSpy).not.toHaveBeenCalled();
        expect(openLinkTextSpy).not.toHaveBeenCalled();

        // Fallback mode without getLeaf/openFile must refuse linktext metacharacters (#, |)
        const fallbackOpenLinkSpy = vi.fn().mockResolvedValue(undefined);
        const fallbackApp: App = {
            vault: {
                configDir: "obsidian-config",
                getAbstractFileByPath: (path: string) => fileMap.get(path) ?? null,
                getFiles: (): TFile[] => []
            },
            workspace: {
                openLinkText: fallbackOpenLinkSpy
            }
        } as unknown as App;
        const fallbackView: SyncLogView = new SyncLogView(
            new MockWorkspaceLeaf(
                fallbackApp
            ) as unknown as import("obsidian").WorkspaceLeaf,
            mockPlugin
        );
        await fallbackView.onOpen();

        const fallbackHashBtn: HTMLButtonElement | undefined = Array.from(
            fallbackView.contentEl.querySelectorAll<HTMLButtonElement>(
                "button.vaultdav-log-path-link"
            )
        ).find((btn: HTMLButtonElement) => btn.textContent === "Notes/Report#2026.md");
        fallbackHashBtn?.click();
        await Promise.resolve();
        expect(fallbackOpenLinkSpy).not.toHaveBeenCalled();
        expect(notifySpy).toHaveBeenCalledWith(
            "Cannot open file path safely in this workspace."
        );

        // Fallback mode must also reject TFolder returned by getAbstractFileByPath
        const fallbackFolderBtn: HTMLButtonElement | undefined = Array.from(
            fallbackView.contentEl.querySelectorAll<HTMLButtonElement>(
                "button.vaultdav-log-path-link"
            )
        ).find((btn: HTMLButtonElement) => btn.textContent === "Projects");
        fallbackFolderBtn?.click();
        await Promise.resolve();
        expect(fallbackOpenLinkSpy).not.toHaveBeenCalled();

        // Fail-closed when vault lookup methods are absent
        const noLookupOpenLinkSpy = vi.fn().mockResolvedValue(undefined);
        const noLookupApp: App = {
            vault: {
                configDir: "obsidian-config",
                getFiles: (): TFile[] => []
            },
            workspace: {
                openLinkText: noLookupOpenLinkSpy
            }
        } as unknown as App;
        const safeRun: SyncRunRecord = createSampleRun({
            events: [
                {
                    isDirectory: false,
                    kind: "upload",
                    path: "Notes/Safe.md",
                    size: 32
                }
            ],
            id: "run-safe",
            summary: { ...createEmptyRunSummary(), uploaded: 1 }
        });
        const noLookupPlugin: VaultDavPlugin = {
            clearSyncHistory: vi.fn().mockResolvedValue(undefined),
            getSyncHistoryRuns: (): SyncRunRecord[] => [safeRun],
            isSyncing: false,
            loadSyncHistory: vi.fn().mockResolvedValue([safeRun]),
            triggerSync: vi.fn().mockResolvedValue(null)
        } as unknown as VaultDavPlugin;
        const noLookupView: SyncLogView = new SyncLogView(
            new MockWorkspaceLeaf(
                noLookupApp
            ) as unknown as import("obsidian").WorkspaceLeaf,
            noLookupPlugin
        );
        await noLookupView.onOpen();
        const safeBtn: HTMLButtonElement | undefined = Array.from(
            noLookupView.contentEl.querySelectorAll<HTMLButtonElement>(
                "button.vaultdav-log-path-link"
            )
        ).find((btn: HTMLButtonElement) => btn.textContent === "Notes/Safe.md");
        safeBtn?.click();
        await Promise.resolve();
        expect(noLookupOpenLinkSpy).not.toHaveBeenCalled();

        // Rejected openFile errors are caught cleanly without unhandled rejections
        openFileSpy.mockRejectedValueOnce(new Error("Workspace locked"));
        hashBtn?.click();
        await Promise.resolve();
        await Promise.resolve();
        expect(warnSpy).toHaveBeenCalled();
        expect(notifySpy).toHaveBeenCalledWith("Failed to open file in vault.");
    });

    it("excludes custom configDir, ignored paths, and excluded conflict originals while surviving null file.stat", async () => {
        const nullStatFile: TFile = {
            basename: "NullStat.conflict-20261124-100000",
            extension: "md",
            name: "NullStat.conflict-20261124-100000.md",
            path: "Notes\\NullStat.conflict-20261124-100000.md",
            stat: null
        } as unknown as TFile;

        const vaultFiles: TFile[] = [
            createMockTFile(
                "obsidian-config/plugins/vaultdav/data.conflict-20261124-100000.json",
                5000,
                512
            ),
            createMockTFile(
                "obsidian-config.conflict-20261124-100000",
                4500,
                128
            ),
            createMockTFile(
                "node_modules/pkg/index.conflict-20261124-100000.js",
                4000,
                256
            ),
            createMockTFile(
                "Thumbs.conflict-20261124-100000.db",
                3500,
                64
            ),
            createMockTFile(
                ".git/HEAD.conflict-20261124-100000",
                3000,
                64
            ),
            nullStatFile
        ];

        const active: ActiveConflictItem[] = collectActiveConflicts(
            vaultFiles,
            "obsidian-config"
        );
        expect(active).toEqual([
            {
                conflictPath: "Notes/NullStat.conflict-20261124-100000.md",
                mtime: 0,
                originalPath: "Notes/NullStat.md",
                size: 0,
                timestampUtc: "2026-11-24 10:00:00 UTC"
            }
        ]);

        // SyncLogView passes app.vault.configDir so custom configDir conflicts never render in DOM
        const mockApp: App = {
            vault: {
                configDir: "obsidian-config",
                getAbstractFileByPath: (): TFile | null => null,
                getFiles: (): TFile[] => vaultFiles
            },
            workspace: {
                openLinkText: vi.fn().mockResolvedValue(undefined)
            }
        } as unknown as App;
        const mockPlugin: VaultDavPlugin = {
            clearSyncHistory: vi.fn().mockResolvedValue(undefined),
            getSyncHistoryRuns: (): SyncRunRecord[] => [],
            isSyncing: false,
            loadSyncHistory: vi.fn().mockResolvedValue([]),
            triggerSync: vi.fn().mockResolvedValue(null)
        } as unknown as VaultDavPlugin;

        const view: SyncLogView = new SyncLogView(
            new MockWorkspaceLeaf(
                mockApp
            ) as unknown as import("obsidian").WorkspaceLeaf,
            mockPlugin
        );
        await view.onOpen();

        expect(view.contentEl.textContent).toContain("Active conflict copies (1)");
        expect(view.contentEl.textContent).toContain(
            "Notes/NullStat.conflict-20261124-100000.md"
        );
        expect(view.contentEl.textContent).not.toContain("obsidian-config");
        expect(view.contentEl.textContent).not.toContain("node_modules");
        expect(view.contentEl.textContent).not.toContain("Thumbs");
    });

    it("redacts credentials, neutralizes Markdown/URI injection, bounds clipboard exports, and guards non-finite totals", async () => {
        const hugeEvents: SyncLogEvent[] = [
            {
                conflictCopyPath: "Notes/Basic c2VjcmV0OnBhc3M=.md",
                isDirectory: false,
                kind: "error",
                message:
                    "Auth Basic dXNlcjpzZWNyZXQ= https://alice:supersecret@cloud.example.com/dav\n\n## Spoofed heading\n- Errors: 0\n[Reset sync](obsidian://shell?cmd=evil)<script>alert(1)</script>\u0000",
                path: "obsidian-config/plugins/vaultdav/data.json"
            }
        ];
        for (let i: number = 0; i < 650; i += 1) {
            hugeEvents.push({
                isDirectory: false,
                kind: "upload",
                path: `Bulk/Item-${i}.md`,
                size: 16
            });
        }
        const hugeConflicts: ActiveConflictItem[] = [];
        for (let i: number = 0; i < 650; i += 1) {
            hugeConflicts.push({
                conflictPath: `Conflicts/Note-${i}.conflict-20261124-100000.md`,
                mtime: 1000 + i,
                originalPath: `Conflicts/Note-${i}.md`,
                size: 100,
                timestampUtc: "2026-11-24 10:00:00 UTC"
            });
        }
        hugeConflicts.unshift(
            {
                conflictPath:
                    "Notes/[click](obsidian://evil).conflict-20261124-100000.md",
                mtime: 999_999,
                originalPath: "Notes/Basic c2VjcmV0dG9rZW4=.md",
                size: 100,
                timestampUtc: "2026-11-24 10:00:00 UTC"
            },
            {
                conflictPath:
                    "Notes/[click](/evil)[[Secret]].conflict-20261124-100000.md",
                mtime: 999_998,
                originalPath: "Notes/Basic c2VjcmV0dG9rZW4=.md",
                size: 100,
                timestampUtc: "2026-11-24 10:00:00 UTC"
            }
        );

        const poisonedRun: SyncRunRecord = createSampleRun({
            events: hugeEvents,
            id: "run-poisoned",
            status: "partial",
            summary: {
                ...createEmptyRunSummary(),
                deletedLocal: Number.NaN,
                deletedRemote: 2,
                errors: 1,
                uploaded: Number.POSITIVE_INFINITY
            }
        });

        const markdown: string = formatRunSummaryMarkdown(
            poisonedRun,
            hugeConflicts,
            "obsidian-config"
        );

        // Credentials must be redacted
        expect(markdown).not.toContain("dXNlcjpzZWNyZXQ=");
        expect(markdown).not.toContain("supersecret");
        expect(markdown).not.toContain("c2VjcmV0OnBhc3M=");
        expect(markdown).not.toContain("c2VjcmV0dG9rZW4=");
        expect(markdown).toContain("Basic [REDACTED]");
        expect(markdown).toContain("https://[REDACTED]@cloud.example.com/dav");

        // Excluded paths must not leak
        expect(markdown).not.toContain(
            "obsidian-config/plugins/vaultdav/data.json"
        );

        // Multi-line Markdown, HTML, and clickable link injections must be neutralized
        expect(markdown).not.toContain("\n## Spoofed heading");
        expect(markdown).not.toContain("\n- Errors: 0");
        expect(markdown).not.toContain("[Reset sync](obsidian://");
        expect(markdown).not.toContain("<script>");
        expect(markdown).not.toContain("\u0000");
        expect(markdown).not.toContain("[click](obsidian://evil)");
        expect(markdown).not.toContain("[click](/evil)");
        expect(markdown).not.toContain("[[Secret]]");
        expect(markdown).toContain("[click\\](/evil)");
        expect(markdown).toContain("\\[\\[Secret\\]\\]");

        // Non-finite summary counts must never render NaN or Infinity
        expect(markdown).not.toContain("NaN");
        expect(markdown).not.toContain("Infinity");

        // Output must be bounded for events and active conflicts
        expect(markdown).not.toContain("Bulk/Item-600.md");
        expect(markdown).not.toContain("Conflicts/Note-600.conflict");
        expect(markdown).toContain("omitted");

        // DOM rendering also redacts sensitive tokens in messages and paths
        const mockApp: App = {
            vault: {
                configDir: "obsidian-config",
                getAbstractFileByPath: (): TFile | null => null,
                getFiles: (): TFile[] => []
            },
            workspace: {
                openLinkText: vi.fn().mockResolvedValue(undefined)
            }
        } as unknown as App;
        const domRun: SyncRunRecord = createSampleRun({
            events: [hugeEvents[0] as SyncLogEvent],
            id: "run-dom-redact",
            status: "partial",
            summary: { ...createEmptyRunSummary(), errors: 1 }
        });
        const mockPlugin: VaultDavPlugin = {
            clearSyncHistory: vi.fn().mockResolvedValue(undefined),
            getSyncHistoryRuns: (): SyncRunRecord[] => [domRun],
            isSyncing: false,
            loadSyncHistory: vi.fn().mockResolvedValue([domRun]),
            triggerSync: vi.fn().mockResolvedValue(null)
        } as unknown as VaultDavPlugin;
        const view: SyncLogView = new SyncLogView(
            new MockWorkspaceLeaf(
                mockApp
            ) as unknown as import("obsidian").WorkspaceLeaf,
            mockPlugin
        );
        await view.onOpen();
        expect(view.contentEl.textContent).not.toContain("dXNlcjpzZWNyZXQ=");
        expect(view.contentEl.textContent).not.toContain("supersecret");
        expect(view.contentEl.textContent).not.toContain("c2VjcmV0OnBhc3M=");
    });

    it("resists prototype-chain property lookups on event kind and conflict resolution tables", async () => {
        const protoRun: SyncRunRecord = createSampleRun({
            events: [
                {
                    kind: "toString" as unknown as SyncEventKind,
                    path: "Notes/Proto1.md",
                    resolution: "valueOf" as unknown as ConflictResolutionMode
                },
                {
                    kind: "constructor" as unknown as SyncEventKind,
                    path: "Notes/Proto2.md",
                    resolution: "unknown_mode" as unknown as ConflictResolutionMode
                }
            ],
            id: "run-proto",
            summary: { ...createEmptyRunSummary(), uploaded: 2 }
        });

        const markdown: string = formatRunSummaryMarkdown(protoRun, []);
        expect(markdown).not.toContain("native code");
        expect(markdown).not.toContain("function ");
        expect(markdown).not.toContain("(undefined)");

        const mockApp: App = {
            vault: {
                configDir: "obsidian-config",
                getAbstractFileByPath: (): TFile | null => null,
                getFiles: (): TFile[] => []
            },
            workspace: {
                openLinkText: vi.fn().mockResolvedValue(undefined)
            }
        } as unknown as App;
        const mockPlugin: VaultDavPlugin = {
            clearSyncHistory: vi.fn().mockResolvedValue(undefined),
            getSyncHistoryRuns: (): SyncRunRecord[] => [protoRun],
            isSyncing: false,
            loadSyncHistory: vi.fn().mockResolvedValue([protoRun]),
            triggerSync: vi.fn().mockResolvedValue(null)
        } as unknown as VaultDavPlugin;
        const view: SyncLogView = new SyncLogView(
            new MockWorkspaceLeaf(
                mockApp
            ) as unknown as import("obsidian").WorkspaceLeaf,
            mockPlugin
        );
        await view.onOpen();

        expect(view.contentEl.textContent).not.toContain("native code");
        expect(view.contentEl.textContent).not.toContain("function ");
        expect(view.contentEl.textContent).not.toContain("undefined");
        const badges: Element[] = Array.from(
            view.contentEl.querySelectorAll(
                ".vaultdav-log-event-row .vaultdav-log-badge"
            )
        );
        expect(badges.length).toBe(2);
        for (const badge of badges) {
            expect(badge.classList.contains("vaultdav-log-badge-muted")).toBe(
                true
            );
            expect(badge.className).not.toContain("function");
        }
    });

    it("prevents post-close DOM rendering, duplicate clear calls, and state corruption when clearing history fails", async () => {
        const notifySpy = vi
            .spyOn(log, "notify")
            .mockImplementation((): void => undefined);
        const warnSpy = vi
            .spyOn(log, "warn")
            .mockImplementation((): void => undefined);

        const sampleRun: SyncRunRecord = createSampleRun({
            events: [
                {
                    isDirectory: false,
                    kind: "upload",
                    path: "Notes/Alpha.md",
                    size: 100
                }
            ],
            id: "run-1",
            summary: { ...createEmptyRunSummary(), uploaded: 1 }
        });

        // 1. Race: onClose() while loadSyncHistory() is still pending
        let resolveLoad: ((runs: SyncRunRecord[]) => void) | null = null;
        const pendingLoad: Promise<SyncRunRecord[]> = new Promise<
            SyncRunRecord[]
        >((resolve: (runs: SyncRunRecord[]) => void) => {
            resolveLoad = resolve;
        });

        const mockApp: App = {
            vault: {
                configDir: "obsidian-config",
                getAbstractFileByPath: (): TFile | null => null,
                getFiles: (): TFile[] => []
            },
            workspace: {
                openLinkText: vi.fn().mockResolvedValue(undefined)
            }
        } as unknown as App;

        const clearSyncHistorySpy = vi.fn<() => Promise<void>>();
        const mockPlugin: VaultDavPlugin = {
            clearSyncHistory: clearSyncHistorySpy,
            getSyncHistoryRuns: (): SyncRunRecord[] => [sampleRun],
            isSyncing: false,
            loadSyncHistory: vi.fn(() => pendingLoad),
            triggerSync: vi.fn().mockResolvedValue(null)
        } as unknown as VaultDavPlugin;

        const view: SyncLogView = new SyncLogView(
            new MockWorkspaceLeaf(
                mockApp
            ) as unknown as import("obsidian").WorkspaceLeaf,
            mockPlugin
        );
        const openPromise: Promise<void> = view.onOpen();
        await view.onClose();
        if (resolveLoad !== null) {
            (resolveLoad as (runs: SyncRunRecord[]) => void)([sampleRun]);
        }
        await openPromise;
        expect(view.contentEl.childElementCount).toBe(0);

        // refresh() after onClose() must also stay empty
        view.refresh();
        expect(view.contentEl.childElementCount).toBe(0);

        // 2. Re-open cleanly and test clearSyncHistory() failure recovery
        (mockPlugin.loadSyncHistory as ReturnType<typeof vi.fn>).mockResolvedValue(
            [sampleRun]
        );
        await view.onOpen();
        expect(view.contentEl.textContent).toContain("Notes/Alpha.md");

        clearSyncHistorySpy.mockRejectedValueOnce(new Error("Disk full"));
        const clearBtn: HTMLButtonElement | undefined = Array.from(
            view.contentEl.querySelectorAll("button")
        ).find((btn: HTMLButtonElement) => btn.textContent === "Clear history");
        clearBtn?.click();

        const confirmBtn: HTMLButtonElement | undefined = Array.from(
            view.contentEl.querySelectorAll("button")
        ).find((btn: HTMLButtonElement) => btn.textContent === "Confirm clear");
        confirmBtn?.click();
        await Promise.resolve();
        await Promise.resolve();

        expect(warnSpy).toHaveBeenCalled();
        expect(notifySpy).toHaveBeenCalledWith("Failed to clear sync history.");
        // Toolbar recovers to "Clear history" instead of staying stuck on "Confirm clear"
        const recoveredClearBtn: HTMLButtonElement | undefined = Array.from(
            view.contentEl.querySelectorAll("button")
        ).find((btn: HTMLButtonElement) => btn.textContent === "Clear history");
        expect(recoveredClearBtn).toBeDefined();
        expect(view.contentEl.textContent).toContain("Notes/Alpha.md");

        // 3. Double-clicking Confirm clear while in-flight fires clearSyncHistory once,
        // and closing mid-clear prevents post-close DOM re-render
        let resolveClear: (() => void) | null = null;
        clearSyncHistorySpy.mockImplementationOnce(
            (): Promise<void> =>
                new Promise<void>((resolve: () => void) => {
                    resolveClear = resolve;
                })
        );
        clearSyncHistorySpy.mockClear();
        recoveredClearBtn?.click();
        const confirmAgainBtn: HTMLButtonElement | undefined = Array.from(
            view.contentEl.querySelectorAll("button")
        ).find((btn: HTMLButtonElement) => btn.textContent === "Confirm clear");
        confirmAgainBtn?.click();
        confirmAgainBtn?.click();
        expect(clearSyncHistorySpy).toHaveBeenCalledTimes(1);

        await view.onClose();
        if (resolveClear !== null) {
            (resolveClear as () => void)();
        }
        await Promise.resolve();
        await Promise.resolve();
        expect(view.contentEl.childElementCount).toBe(0);
    });
});
