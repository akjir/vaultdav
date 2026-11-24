import type { App, TFile } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { log } from "../src/log";
import type VaultDavPlugin from "../src/main";
import { createEmptyRunSummary } from "../src/sync/history";
import type { SyncLogEvent, SyncRunRecord } from "../src/types";
import {
    collectActiveConflicts,
    formatDuration,
    formatRunSummaryMarkdown,
    formatTimestamp,
    matchesEventFilter,
    SYNC_LOG_VIEW_TYPE,
    SyncLogView
} from "../src/ui/sync_log_view";
import { WorkspaceLeaf as MockWorkspaceLeaf } from "./obsidian_mock";

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

    it("formats durations, timestamps, active conflicts, event filters, and Markdown summaries accurately", () => {
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

        const run: SyncRunRecord = createSampleRun({
            events: [conflictEvent],
            id: "run-1",
            summary: {
                ...createEmptyRunSummary(),
                conflictsKeepBoth: 1,
                conflictsResolved: 1,
                uploaded: 2
            }
        });
        const markdown: string = formatRunSummaryMarkdown(run, active);
        expect(markdown).toContain("# VaultDAV sync summary");
        expect(markdown).toContain("Notes/Daily.conflict-20261124-100000.md");
        expect(markdown).toContain("## Active conflict copies (2)");
    });

    it("renders overview, active conflict copies, run selector, filters, path search, file opening, copy summary, and two-step clear without inline styles or innerHTML", async () => {
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

        // Verify zero inline styles anywhere in rendered DOM
        expect(view.contentEl.querySelectorAll("[style]").length).toBe(0);
        expect(view.contentEl.textContent).toContain("Active conflict copies (1)");
        expect(view.contentEl.textContent).toContain(
            "Notes/Daily.conflict-20261124-100000.md"
        );
        expect(view.contentEl.textContent).toContain(
            "12 routine event(s) omitted"
        );

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

        // Filter chip "Conflicts (1)" narrows events to only the conflict row
        const conflictChip: HTMLButtonElement | undefined = Array.from(
            view.contentEl.querySelectorAll("button")
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
        if (searchInput !== null) {
            searchInput.value = "does-not-exist";
            searchInput.dispatchEvent(new Event("input"));
        }
        expect(view.contentEl.textContent).toContain(
            "No events match the current filter."
        );

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

        await view.onClose();
        expect(view.contentEl.childElementCount).toBe(0);
    });
});
