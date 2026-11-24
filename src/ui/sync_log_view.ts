import { ItemView, type TAbstractFile, type TFile, type WorkspaceLeaf } from "obsidian";
import { log } from "../log";
import type VaultDavPlugin from "../main";
import { isNoopRun } from "../sync/history";
import type {
    ActiveConflictItem,
    ConflictResolutionMode,
    SyncEventKind,
    SyncLogEvent,
    SyncRunRecord,
    SyncRunSummary
} from "../types";
import { util } from "../utilities";

export type SyncLogFilter =
    | "all"
    | "conflicts"
    | "deletions"
    | "downloads"
    | "folders"
    | "issues"
    | "uploads";

export const SYNC_LOG_VIEW_TYPE: string = "vaultdav-sync-log";

interface FilterChipSpec {
    id: SyncLogFilter;
    label: string;
}

const CONFLICT_RESOLUTION_LABELS: Readonly<Record<ConflictResolutionMode, string>> =
    Object.freeze({
        identical: "Local and remote contents matched (no copy created)",
        keep_both: "Conflict copy created",
        newest_wins_local: "Local version overwrote remote",
        newest_wins_remote: "Remote version overwrote local"
    });
const EVENT_KIND_BADGE_CLASSES: Readonly<Record<SyncEventKind, string>> =
    Object.freeze({
        conflict: "vaultdav-log-badge-warning",
        create_local_dir: "vaultdav-log-badge-muted",
        create_remote_dir: "vaultdav-log-badge-muted",
        delete_local: "vaultdav-log-badge-danger",
        delete_remote: "vaultdav-log-badge-danger",
        download: "vaultdav-log-badge-info",
        error: "vaultdav-log-badge-danger",
        upload: "vaultdav-log-badge-success",
        warning: "vaultdav-log-badge-warning"
    });
const EVENT_KIND_LABELS: Readonly<Record<SyncEventKind, string>> = Object.freeze({
    conflict: "Conflict",
    create_local_dir: "Local folder",
    create_remote_dir: "Remote folder",
    delete_local: "Deleted locally",
    delete_remote: "Deleted remotely",
    download: "Downloaded",
    error: "Error",
    upload: "Uploaded",
    warning: "Warning"
});
const FILTER_CHIPS: ReadonlyArray<FilterChipSpec> = Object.freeze([
    { id: "all", label: "All" },
    { id: "conflicts", label: "Conflicts" },
    { id: "issues", label: "Errors & warnings" },
    { id: "uploads", label: "Uploads" },
    { id: "downloads", label: "Downloads" },
    { id: "deletions", label: "Deletions" },
    { id: "folders", label: "Folders" }
]);
const MAX_SAFE_TIMESTAMP_MS: number = 8_640_000_000_000_000;

export function collectActiveConflicts(
    files: ReadonlyArray<TFile>
): ActiveConflictItem[] {
    const conflicts: ActiveConflictItem[] = [];
    for (const file of files) {
        const parsed: { originalPath: string; timestampUtc: string } | null =
            util.parseConflictCopyPath(file.path);
        if (parsed === null) {
            continue;
        }
        const mtime: number =
            file.stat !== undefined &&
            Number.isFinite(file.stat.mtime) &&
            file.stat.mtime > 0
                ? Math.floor(file.stat.mtime)
                : 0;
        const size: number =
            file.stat !== undefined &&
            Number.isFinite(file.stat.size) &&
            file.stat.size > 0
                ? Math.floor(file.stat.size)
                : 0;
        conflicts.push({
            conflictPath: file.path,
            mtime,
            originalPath: parsed.originalPath,
            size,
            timestampUtc: parsed.timestampUtc
        });
    }
    conflicts.sort((a: ActiveConflictItem, b: ActiveConflictItem): number => {
        if (b.mtime !== a.mtime) {
            return b.mtime - a.mtime;
        }
        return a.conflictPath < b.conflictPath
            ? -1
            : a.conflictPath > b.conflictPath
              ? 1
              : 0;
    });
    return conflicts;
}

function countFilterMatches(
    events: ReadonlyArray<SyncLogEvent>,
    filter: SyncLogFilter
): number {
    if (filter === "all") {
        return events.length;
    }
    let count: number = 0;
    for (const event of events) {
        if (matchesEventFilter(event, filter, "")) {
            count += 1;
        }
    }
    return count;
}

export function formatDuration(durationMs: number): string {
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
        return "0 ms";
    }
    const safeMs: number = Math.floor(durationMs);
    if (safeMs < 1000) {
        return `${safeMs} ms`;
    }
    const totalSeconds: number = safeMs / 1000;
    if (totalSeconds < 60) {
        return `${totalSeconds.toFixed(1)} s`;
    }
    const minutes: number = Math.floor(totalSeconds / 60);
    const seconds: number = Math.round(totalSeconds % 60);
    return `${minutes}m ${seconds}s`;
}

export function formatRunSummaryMarkdown(
    run: SyncRunRecord | null,
    activeConflicts: ReadonlyArray<ActiveConflictItem>
): string {
    const lines: string[] = ["# VaultDAV sync summary"];
    if (run === null) {
        lines.push("", "No sync runs recorded yet.");
    } else {
        const s: SyncRunSummary = run.summary;
        const statusLabel: string = getRunStatusMeta(run).label;
        const totalDeleted: number =
            s.deletedLocal +
            s.deletedLocalDirs +
            s.deletedRemote +
            s.deletedRemoteDirs;
        const totalDirsCreated: number =
            s.dirsCreatedLocal + s.dirsCreatedRemote;
        lines.push(
            "",
            `- Status: ${statusLabel}`,
            `- Finished: ${formatTimestamp(run.finishedAt)}`,
            `- Trigger: ${run.trigger}`,
            `- Duration: ${formatDuration(run.durationMs)}`,
            `- Uploaded: ${s.uploaded}`,
            `- Downloaded: ${s.downloaded}`,
            `- Conflicts: ${s.conflictsResolved} (keep both: ${s.conflictsKeepBoth}, newest wins: ${s.conflictsNewestWins}, identical: ${s.conflictsIdentical})`,
            `- Deleted: ${totalDeleted} (local files: ${s.deletedLocal}, remote files: ${s.deletedRemote}, local folders: ${s.deletedLocalDirs}, remote folders: ${s.deletedRemoteDirs})`,
            `- Folders created: ${totalDirsCreated}`,
            `- Warnings: ${s.warnings}`,
            `- Errors: ${s.errors}`
        );
        if (run.collapsedCount > 1) {
            lines.push(
                `- Consecutive no-op checks: ${run.collapsedCount}`
            );
        }
        if (run.events.length > 0) {
            lines.push("", "## Events");
            for (const event of run.events) {
                const label: string = EVENT_KIND_LABELS[event.kind] ?? event.kind;
                const target: string = event.path ?? "";
                const parts: string[] = [`- [${label}]`];
                if (target !== "") {
                    parts.push(target);
                }
                if (event.resolution !== undefined) {
                    const resText: string =
                        CONFLICT_RESOLUTION_LABELS[event.resolution];
                    parts.push(`(${resText})`);
                }
                if (event.conflictCopyPath !== undefined) {
                    parts.push(`-> ${event.conflictCopyPath}`);
                }
                if (event.size !== undefined) {
                    parts.push(`[${util.formatByteSize(event.size)}]`);
                }
                if (event.message !== undefined) {
                    parts.push(`: ${event.message}`);
                }
                lines.push(parts.join(" "));
            }
        }
        if (run.omittedEvents > 0) {
            lines.push(
                "",
                `Note: ${run.omittedEvents} additional routine event(s) omitted.`
            );
        }
    }

    if (activeConflicts.length > 0) {
        lines.push("", `## Active conflict copies (${activeConflicts.length})`);
        for (const item of activeConflicts) {
            lines.push(
                `- ${item.conflictPath} (original: ${item.originalPath}, ${item.timestampUtc})`
            );
        }
    }
    return lines.join("\n");
}

export function formatTimestamp(timestampMs: number): string {
    if (
        !Number.isFinite(timestampMs) ||
        timestampMs <= 0 ||
        timestampMs > MAX_SAFE_TIMESTAMP_MS
    ) {
        return "Unknown time";
    }
    const date: Date = new Date(Math.floor(timestampMs));
    if (!Number.isFinite(date.getTime())) {
        return "Unknown time";
    }
    const yyyy: string = String(date.getFullYear()).padStart(4, "0");
    const mm: string = String(date.getMonth() + 1).padStart(2, "0");
    const dd: string = String(date.getDate()).padStart(2, "0");
    const hh: string = String(date.getHours()).padStart(2, "0");
    const min: string = String(date.getMinutes()).padStart(2, "0");
    const ss: string = String(date.getSeconds()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`;
}

function getCompactRunSummaryText(run: SyncRunRecord): string {
    if (isNoopRun(run)) {
        return run.collapsedCount > 1
            ? `No changes (${run.collapsedCount} checks)`
            : "No changes";
    }
    const s: SyncRunSummary = run.summary;
    const parts: string[] = [];
    if (s.uploaded > 0) {
        parts.push(`${s.uploaded} up`);
    }
    if (s.downloaded > 0) {
        parts.push(`${s.downloaded} down`);
    }
    if (s.conflictsResolved > 0) {
        parts.push(
            s.conflictsResolved === 1
                ? "1 conflict"
                : `${s.conflictsResolved} conflicts`
        );
    }
    const deletedTotal: number =
        s.deletedLocal +
        s.deletedLocalDirs +
        s.deletedRemote +
        s.deletedRemoteDirs;
    if (deletedTotal > 0) {
        parts.push(`${deletedTotal} deleted`);
    }
    const dirsCreated: number = s.dirsCreatedLocal + s.dirsCreatedRemote;
    if (dirsCreated > 0) {
        parts.push(
            dirsCreated === 1 ? "1 folder" : `${dirsCreated} folders`
        );
    }
    if (s.warnings > 0) {
        parts.push(s.warnings === 1 ? "1 warning" : `${s.warnings} warnings`);
    }
    if (s.errors > 0) {
        parts.push(s.errors === 1 ? "1 error" : `${s.errors} errors`);
    }
    if (parts.length === 0) {
        return run.status === "failed" ? "Sync failed" : "No changes";
    }
    return parts.join(" · ");
}

function getRunStatusMeta(run: SyncRunRecord): {
    badgeCls: string;
    label: string;
} {
    if (run.status === "failed") {
        return { badgeCls: "vaultdav-log-badge-danger", label: "Failed" };
    }
    if (run.status === "partial" || run.summary.errors > 0) {
        return { badgeCls: "vaultdav-log-badge-danger", label: "Errors" };
    }
    if (run.summary.conflictsResolved > 0) {
        return { badgeCls: "vaultdav-log-badge-warning", label: "Conflicts" };
    }
    if (run.summary.warnings > 0) {
        return { badgeCls: "vaultdav-log-badge-warning", label: "Warnings" };
    }
    if (isNoopRun(run)) {
        return { badgeCls: "vaultdav-log-badge-muted", label: "No changes" };
    }
    return { badgeCls: "vaultdav-log-badge-success", label: "Synced" };
}

export function matchesEventFilter(
    event: SyncLogEvent,
    filter: SyncLogFilter,
    queryLower: string
): boolean {
    if (filter === "conflicts" && event.kind !== "conflict") {
        return false;
    }
    if (
        filter === "issues" &&
        event.kind !== "error" &&
        event.kind !== "warning"
    ) {
        return false;
    }
    if (filter === "uploads" && event.kind !== "upload") {
        return false;
    }
    if (filter === "downloads" && event.kind !== "download") {
        return false;
    }
    if (
        filter === "deletions" &&
        event.kind !== "delete_local" &&
        event.kind !== "delete_remote"
    ) {
        return false;
    }
    if (
        filter === "folders" &&
        event.kind !== "create_local_dir" &&
        event.kind !== "create_remote_dir"
    ) {
        return false;
    }
    if (queryLower === "") {
        return true;
    }
    const pathMatch: boolean =
        event.path !== undefined &&
        event.path.toLowerCase().includes(queryLower);
    const conflictCopyMatch: boolean =
        event.conflictCopyPath !== undefined &&
        event.conflictCopyPath.toLowerCase().includes(queryLower);
    const messageMatch: boolean =
        event.message !== undefined &&
        event.message.toLowerCase().includes(queryLower);
    return pathMatch || conflictCopyMatch || messageMatch;
}

export class SyncLogView extends ItemView {
    private activeFilter: SyncLogFilter = "all";
    private confirmingClear: boolean = false;
    private readonly plugin: VaultDavPlugin;
    private searchQuery: string = "";
    private selectedRunId: string | null = null;

    public constructor(leaf: WorkspaceLeaf, plugin: VaultDavPlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    private createStatCard(
        container: HTMLElement,
        label: string,
        value: string,
        modifierCls: string = ""
    ): void {
        const cardCls: string =
            modifierCls !== ""
                ? `vaultdav-log-stat-card ${modifierCls}`
                : "vaultdav-log-stat-card";
        const card: HTMLElement = container.createDiv({ cls: cardCls });
        card.createDiv({ cls: "vaultdav-log-stat-value", text: value });
        card.createDiv({ cls: "vaultdav-log-stat-label", text: label });
    }

    private getActiveConflicts(): ActiveConflictItem[] {
        if (typeof this.app.vault.getFiles !== "function") {
            return [];
        }
        return collectActiveConflicts(this.app.vault.getFiles());
    }

    public getDisplayText(): string {
        return "Sync log";
    }

    public getIcon(): string {
        return "history";
    }

    private getSelectedRun(
        runs: ReadonlyArray<SyncRunRecord>
    ): SyncRunRecord | null {
        if (runs.length === 0) {
            return null;
        }
        if (this.selectedRunId !== null) {
            const matched: SyncRunRecord | undefined = runs.find(
                (run: SyncRunRecord) => run.id === this.selectedRunId
            );
            if (matched !== undefined) {
                return matched;
            }
        }
        return runs[0] ?? null;
    }

    public getViewType(): string {
        return SYNC_LOG_VIEW_TYPE;
    }

    private async handleClearHistory(): Promise<void> {
        this.confirmingClear = false;
        this.selectedRunId = null;
        await this.plugin.clearSyncHistory();
        log.notify("Sync history cleared.");
        this.render();
    }

    private async handleCopySummary(
        run: SyncRunRecord | null,
        activeConflicts: ReadonlyArray<ActiveConflictItem>
    ): Promise<void> {
        const text: string = formatRunSummaryMarkdown(run, activeConflicts);
        if (
            typeof navigator !== "undefined" &&
            navigator.clipboard !== undefined &&
            typeof navigator.clipboard.writeText === "function"
        ) {
            try {
                await navigator.clipboard.writeText(text);
                log.notify("Sync summary copied to clipboard.");
                return;
            } catch (err: unknown) {
                log.warn("Failed to copy sync summary to clipboard:", err);
            }
        }
        log.notify("Clipboard is unavailable on this device.");
    }

    private async handleOpenVaultPath(path: string): Promise<void> {
        const normalized: string = util.normalizeVaultPath(path);
        if (normalized === "") {
            return;
        }
        if (typeof this.app.vault.getAbstractFileByPath === "function") {
            const existing: TAbstractFile | null =
                this.app.vault.getAbstractFileByPath(normalized);
            if (existing === null) {
                log.notify("File no longer exists in vault.");
                return;
            }
        }
        if (
            this.app.workspace !== undefined &&
            typeof this.app.workspace.openLinkText === "function"
        ) {
            await this.app.workspace.openLinkText(normalized, "", false);
        }
    }

    public async onClose(): Promise<void> {
        this.confirmingClear = false;
        if (typeof this.contentEl.empty === "function") {
            this.contentEl.empty();
        } else {
            this.contentEl.replaceChildren();
        }
        await Promise.resolve();
    }

    public async onOpen(): Promise<void> {
        this.contentEl.classList.add("vaultdav-log");
        await this.plugin.loadSyncHistory();
        this.render();
    }

    public refresh(): void {
        this.render();
    }

    private render(): void {
        const container: HTMLElement = this.contentEl;
        if (typeof container.empty === "function") {
            container.empty();
        } else {
            container.replaceChildren();
        }
        container.classList.add("vaultdav-log");

        const runs: SyncRunRecord[] = this.plugin.getSyncHistoryRuns();
        const activeConflicts: ActiveConflictItem[] = this.getActiveConflicts();
        const selectedRun: SyncRunRecord | null = this.getSelectedRun(runs);
        if (selectedRun !== null) {
            this.selectedRunId = selectedRun.id;
        }

        this.renderToolbar(container, selectedRun, activeConflicts, runs.length > 0);
        this.renderOverview(container, runs[0] ?? null, activeConflicts.length);
        this.renderActiveConflicts(container, activeConflicts);
        this.renderRunHistory(container, runs, selectedRun);
        this.renderRunDetails(container, selectedRun);
    }

    private renderActiveConflicts(
        container: HTMLElement,
        activeConflicts: ReadonlyArray<ActiveConflictItem>
    ): void {
        const section: HTMLElement = container.createDiv({
            cls: "vaultdav-log-section"
        });
        const headingText: string =
            activeConflicts.length > 0
                ? `Active conflict copies (${activeConflicts.length})`
                : "Active conflict copies";
        section.createDiv({
            cls: "vaultdav-log-section-title",
            text: headingText
        });

        if (activeConflicts.length === 0) {
            section.createDiv({
                cls: "vaultdav-log-empty",
                text: "No active conflict copies found in this vault."
            });
            return;
        }

        const list: HTMLElement = section.createDiv({
            cls: "vaultdav-log-conflict-list"
        });
        for (const item of activeConflicts) {
            const row: HTMLElement = list.createDiv({
                cls: "vaultdav-log-conflict-item"
            });
            const info: HTMLElement = row.createDiv({
                cls: "vaultdav-log-conflict-info"
            });
            const conflictLink: HTMLButtonElement = info.createEl("button", {
                cls: "vaultdav-log-path-link",
                text: item.conflictPath
            });
            conflictLink.type = "button";
            conflictLink.addEventListener("click", (): void => {
                void this.handleOpenVaultPath(item.conflictPath);
            });

            const meta: HTMLElement = info.createDiv({
                cls: "vaultdav-log-meta"
            });
            meta.createSpan({
                text: `Original: ${item.originalPath} · ${item.timestampUtc}`
            });
            if (item.size > 0) {
                meta.createSpan({
                    text: ` · ${util.formatByteSize(item.size)}`
                });
            }

            const actions: HTMLElement = row.createDiv({
                cls: "vaultdav-log-conflict-actions"
            });
            const openCopyBtn: HTMLButtonElement = actions.createEl("button", {
                cls: "vaultdav-log-mini-btn",
                text: "Open copy"
            });
            openCopyBtn.type = "button";
            openCopyBtn.addEventListener("click", (): void => {
                void this.handleOpenVaultPath(item.conflictPath);
            });

            const openOriginalBtn: HTMLButtonElement = actions.createEl(
                "button",
                {
                    cls: "vaultdav-log-mini-btn",
                    text: "Open original"
                }
            );
            openOriginalBtn.type = "button";
            openOriginalBtn.addEventListener("click", (): void => {
                void this.handleOpenVaultPath(item.originalPath);
            });
        }
    }

    private renderEventRow(
        container: HTMLElement,
        event: SyncLogEvent
    ): void {
        const row: HTMLElement = container.createDiv({
            cls: "vaultdav-log-event-row"
        });
        const header: HTMLElement = row.createDiv({
            cls: "vaultdav-log-event-header"
        });
        const badgeCls: string =
            EVENT_KIND_BADGE_CLASSES[event.kind] ?? "vaultdav-log-badge-muted";
        const badgeLabel: string = EVENT_KIND_LABELS[event.kind] ?? event.kind;
        header.createSpan({
            cls: `vaultdav-log-badge ${badgeCls}`,
            text: badgeLabel
        });

        if (event.path !== undefined && event.path !== "") {
            const canOpen: boolean =
                event.isDirectory !== true &&
                event.kind !== "delete_local" &&
                event.kind !== "delete_remote";
            if (canOpen) {
                const pathBtn: HTMLButtonElement = header.createEl("button", {
                    cls: "vaultdav-log-path-link",
                    text: event.path
                });
                pathBtn.type = "button";
                const targetPath: string = event.path;
                pathBtn.addEventListener("click", (): void => {
                    void this.handleOpenVaultPath(targetPath);
                });
            } else {
                header.createSpan({
                    cls: "vaultdav-log-path-text",
                    text: event.path
                });
            }
        }

        if (event.size !== undefined) {
            header.createSpan({
                cls: "vaultdav-log-size",
                text: util.formatByteSize(event.size)
            });
        }

        if (event.resolution !== undefined) {
            const detail: HTMLElement = row.createDiv({
                cls: "vaultdav-log-event-detail"
            });
            detail.createSpan({
                text: CONFLICT_RESOLUTION_LABELS[event.resolution]
            });
            if (event.conflictCopyPath !== undefined) {
                detail.createSpan({ text: ": " });
                const copyBtn: HTMLButtonElement = detail.createEl("button", {
                    cls: "vaultdav-log-path-link",
                    text: event.conflictCopyPath
                });
                copyBtn.type = "button";
                const copyPath: string = event.conflictCopyPath;
                copyBtn.addEventListener("click", (): void => {
                    void this.handleOpenVaultPath(copyPath);
                });
            }
        }

        if (event.message !== undefined && event.message !== "") {
            row.createDiv({
                cls: "vaultdav-log-event-message",
                text: event.message
            });
        }
    }

    private renderOverview(
        container: HTMLElement,
        latestRun: SyncRunRecord | null,
        activeConflictCount: number
    ): void {
        const section: HTMLElement = container.createDiv({
            cls: "vaultdav-log-section"
        });
        section.createDiv({
            cls: "vaultdav-log-section-title",
            text: "Overview"
        });

        if (latestRun === null) {
            section.createDiv({
                cls: "vaultdav-log-empty",
                text: "No sync runs recorded yet."
            });
            return;
        }

        const statusLine: HTMLElement = section.createDiv({
            cls: "vaultdav-log-status-line"
        });
        const meta: { badgeCls: string; label: string } =
            getRunStatusMeta(latestRun);
        statusLine.createSpan({
            cls: `vaultdav-log-badge ${meta.badgeCls}`,
            text: meta.label
        });
        statusLine.createSpan({
            cls: "vaultdav-log-meta",
            text: `Last sync: ${formatTimestamp(latestRun.finishedAt)} · ${formatDuration(latestRun.durationMs)} · ${latestRun.trigger}`
        });

        const s: SyncRunSummary = latestRun.summary;
        const deletedTotal: number =
            s.deletedLocal +
            s.deletedLocalDirs +
            s.deletedRemote +
            s.deletedRemoteDirs;
        const grid: HTMLElement = section.createDiv({
            cls: "vaultdav-log-stat-grid"
        });
        this.createStatCard(grid, "Uploaded", String(s.uploaded));
        this.createStatCard(grid, "Downloaded", String(s.downloaded));
        this.createStatCard(
            grid,
            "Conflicts",
            String(s.conflictsResolved),
            s.conflictsResolved > 0 ? "vaultdav-log-stat-warn" : ""
        );
        this.createStatCard(grid, "Deleted", String(deletedTotal));
        this.createStatCard(
            grid,
            "Errors",
            String(s.errors),
            s.errors > 0 ? "vaultdav-log-stat-error" : ""
        );
        this.createStatCard(
            grid,
            "Active copies",
            String(activeConflictCount),
            activeConflictCount > 0 ? "vaultdav-log-stat-warn" : ""
        );
    }

    private renderRunDetails(
        container: HTMLElement,
        selectedRun: SyncRunRecord | null
    ): void {
        const section: HTMLElement = container.createDiv({
            cls: "vaultdav-log-section"
        });
        section.createDiv({
            cls: "vaultdav-log-section-title",
            text: "Run details"
        });

        if (selectedRun === null) {
            section.createDiv({
                cls: "vaultdav-log-empty",
                text: "Select a sync run to inspect detailed events."
            });
            return;
        }

        const metaRow: HTMLElement = section.createDiv({
            cls: "vaultdav-log-detail-meta"
        });
        const statusMeta: { badgeCls: string; label: string } =
            getRunStatusMeta(selectedRun);
        metaRow.createSpan({
            cls: `vaultdav-log-badge ${statusMeta.badgeCls}`,
            text: statusMeta.label
        });
        metaRow.createSpan({
            cls: "vaultdav-log-meta",
            text: `${formatTimestamp(selectedRun.finishedAt)} · ${formatDuration(selectedRun.durationMs)} · ${selectedRun.trigger}`
        });
        if (
            selectedRun.collapsedCount > 1 &&
            selectedRun.firstCollapsedAt !== undefined
        ) {
            section.createDiv({
                cls: "vaultdav-log-notice-box",
                text: `${selectedRun.collapsedCount} consecutive no-op checks folded (${formatTimestamp(selectedRun.firstCollapsedAt)} to ${formatTimestamp(selectedRun.finishedAt)}).`
            });
        }

        const filterBar: HTMLElement = section.createDiv({
            cls: "vaultdav-log-filters"
        });
        for (const chip of FILTER_CHIPS) {
            const count: number = countFilterMatches(
                selectedRun.events,
                chip.id
            );
            const isActive: boolean = this.activeFilter === chip.id;
            const chipCls: string = isActive
                ? "vaultdav-log-chip is-active"
                : "vaultdav-log-chip";
            const btn: HTMLButtonElement = filterBar.createEl("button", {
                cls: chipCls,
                text: `${chip.label} (${count})`
            });
            btn.type = "button";
            btn.addEventListener("click", (): void => {
                this.activeFilter = chip.id;
                this.render();
            });
        }

        const searchWrap: HTMLElement = section.createDiv({
            cls: "vaultdav-log-search-wrap"
        });
        const searchInput: HTMLInputElement = searchWrap.createEl("input", {
            cls: "vaultdav-log-search-input"
        });
        searchInput.type = "search";
        searchInput.placeholder = "Filter by file path";
        searchInput.value = this.searchQuery;

        const eventsList: HTMLElement = section.createDiv({
            cls: "vaultdav-log-events"
        });

        const populateEvents = (): void => {
            if (typeof eventsList.empty === "function") {
                eventsList.empty();
            } else {
                eventsList.replaceChildren();
            }
            if (selectedRun.detailsPruned) {
                eventsList.createDiv({
                    cls: "vaultdav-log-notice-box",
                    text: "Detailed events for this older run were compacted to stay within storage limits. Summary totals remain complete."
                });
            }
            const queryLower: string = this.searchQuery.trim().toLowerCase();
            const filtered: SyncLogEvent[] = selectedRun.events.filter(
                (event: SyncLogEvent): boolean =>
                    matchesEventFilter(event, this.activeFilter, queryLower)
            );
            if (filtered.length === 0) {
                const emptyMsg: string =
                    selectedRun.events.length === 0
                        ? "No changes were needed during this sync."
                        : "No events match the current filter.";
                eventsList.createDiv({
                    cls: "vaultdav-log-empty",
                    text: emptyMsg
                });
            } else {
                for (const event of filtered) {
                    this.renderEventRow(eventsList, event);
                }
            }
            if (!selectedRun.detailsPruned && selectedRun.omittedEvents > 0) {
                eventsList.createDiv({
                    cls: "vaultdav-log-notice-box",
                    text: `${selectedRun.omittedEvents} routine event(s) omitted to stay within per-run storage limits. Conflicts, errors, and totals remain complete.`
                });
            }
        };

        searchInput.addEventListener("input", (): void => {
            this.searchQuery = searchInput.value;
            populateEvents();
        });
        populateEvents();
    }

    private renderRunHistory(
        container: HTMLElement,
        runs: ReadonlyArray<SyncRunRecord>,
        selectedRun: SyncRunRecord | null
    ): void {
        if (runs.length === 0) {
            return;
        }
        const section: HTMLElement = container.createDiv({
            cls: "vaultdav-log-section"
        });
        section.createDiv({
            cls: "vaultdav-log-section-title",
            text: `Sync history (${runs.length})`
        });

        const list: HTMLElement = section.createDiv({
            cls: "vaultdav-log-run-list"
        });
        for (const run of runs) {
            const isSelected: boolean =
                selectedRun !== null && selectedRun.id === run.id;
            const rowCls: string = isSelected
                ? "vaultdav-log-run-item is-selected"
                : "vaultdav-log-run-item";
            const itemBtn: HTMLButtonElement = list.createEl("button", {
                cls: rowCls
            });
            itemBtn.type = "button";
            itemBtn.addEventListener("click", (): void => {
                this.selectedRunId = run.id;
                this.render();
            });

            const topRow: HTMLElement = itemBtn.createDiv({
                cls: "vaultdav-log-run-top"
            });
            const meta: { badgeCls: string; label: string } =
                getRunStatusMeta(run);
            topRow.createSpan({
                cls: `vaultdav-log-badge ${meta.badgeCls}`,
                text: meta.label
            });
            topRow.createSpan({
                cls: "vaultdav-log-run-time",
                text: formatTimestamp(run.finishedAt)
            });

            const bottomRow: HTMLElement = itemBtn.createDiv({
                cls: "vaultdav-log-run-summary"
            });
            bottomRow.createSpan({
                text: getCompactRunSummaryText(run)
            });
        }
    }

    private renderToolbar(
        container: HTMLElement,
        selectedRun: SyncRunRecord | null,
        activeConflicts: ReadonlyArray<ActiveConflictItem>,
        hasHistory: boolean
    ): void {
        const toolbar: HTMLElement = container.createDiv({
            cls: "vaultdav-log-toolbar"
        });

        const syncBtn: HTMLButtonElement = toolbar.createEl("button", {
            cls: "mod-cta",
            text: this.plugin.isSyncing ? "Syncing..." : "Synchronize now"
        });
        syncBtn.type = "button";
        syncBtn.disabled = this.plugin.isSyncing;
        syncBtn.addEventListener("click", (): void => {
            void this.plugin.triggerSync("manual");
        });

        const refreshBtn: HTMLButtonElement = toolbar.createEl("button", {
            text: "Refresh"
        });
        refreshBtn.type = "button";
        refreshBtn.addEventListener("click", (): void => {
            this.render();
        });

        const copyBtn: HTMLButtonElement = toolbar.createEl("button", {
            text: "Copy summary"
        });
        copyBtn.type = "button";
        copyBtn.addEventListener("click", (): void => {
            void this.handleCopySummary(selectedRun, activeConflicts);
        });

        if (hasHistory) {
            if (this.confirmingClear) {
                const confirmBtn: HTMLButtonElement = toolbar.createEl(
                    "button",
                    {
                        cls: "mod-warning",
                        text: "Confirm clear"
                    }
                );
                confirmBtn.type = "button";
                confirmBtn.addEventListener("click", (): void => {
                    void this.handleClearHistory();
                });

                const cancelBtn: HTMLButtonElement = toolbar.createEl("button", {
                    text: "Cancel"
                });
                cancelBtn.type = "button";
                cancelBtn.addEventListener("click", (): void => {
                    this.confirmingClear = false;
                    this.render();
                });
            } else {
                const clearBtn: HTMLButtonElement = toolbar.createEl("button", {
                    text: "Clear history"
                });
                clearBtn.type = "button";
                clearBtn.addEventListener("click", (): void => {
                    this.confirmingClear = true;
                    this.render();
                });
            }
        }
    }
}
