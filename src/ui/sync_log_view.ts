import {
    ItemView,
    TFile,
    TFolder,
    type TAbstractFile,
    type WorkspaceLeaf
} from "obsidian";
import { log, redactSensitiveText } from "../log";
import type VaultDavPlugin from "../main";
import { isCriticalRun, isNoopRun } from "../sync/history";
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

export type SyncRunFilter = "all" | "changes" | "issues";

export const CONFLICT_PAGE_SIZE: number = 10;
export const EVENT_PAGE_SIZE: number = 50;
export const MAX_MARKDOWN_CONFLICTS: number = 500;
export const MAX_MARKDOWN_EVENTS: number = 500;
export const RUN_PAGE_SIZE: number = 20;
export const SYNC_LOG_VIEW_TYPE: string = "vaultdav-sync-log";

interface FilterChipSpec {
    id: SyncLogFilter;
    label: string;
}

interface RunFilterChipSpec {
    id: SyncRunFilter;
    label: string;
}

interface SummaryPillSpec {
    badgeCls: string;
    label: string;
}

export interface TransferByteTotals {
    downloaded: number;
    uploaded: number;
}

const CONFLICT_RESOLUTION_LABELS: ReadonlyMap<ConflictResolutionMode, string> =
    new Map<ConflictResolutionMode, string>([
        ["identical", "Local and remote contents matched (no copy created)"],
        ["keep_both", "Conflict copy created"],
        ["newest_wins_local", "Local version overwrote remote"],
        ["newest_wins_remote", "Remote version overwrote local"]
    ]);
const EVENT_KIND_BADGE_CLASSES: ReadonlyMap<SyncEventKind, string> = new Map<
    SyncEventKind,
    string
>([
    ["conflict", "vaultdav-log-badge-warning"],
    ["create_local_dir", "vaultdav-log-badge-muted"],
    ["create_remote_dir", "vaultdav-log-badge-muted"],
    ["delete_local", "vaultdav-log-badge-danger"],
    ["delete_remote", "vaultdav-log-badge-danger"],
    ["download", "vaultdav-log-badge-info"],
    ["error", "vaultdav-log-badge-danger"],
    ["upload", "vaultdav-log-badge-success"],
    ["warning", "vaultdav-log-badge-warning"]
]);
const EVENT_KIND_LABELS: ReadonlyMap<SyncEventKind, string> = new Map<
    SyncEventKind,
    string
>([
    ["conflict", "Conflict"],
    ["create_local_dir", "Local folder"],
    ["create_remote_dir", "Remote folder"],
    ["delete_local", "Deleted locally"],
    ["delete_remote", "Deleted remotely"],
    ["download", "Downloaded"],
    ["error", "Error"],
    ["upload", "Uploaded"],
    ["warning", "Warning"]
]);
const FILTER_CHIPS: ReadonlyArray<FilterChipSpec> = Object.freeze([
    { id: "all", label: "All" },
    { id: "conflicts", label: "Conflicts" },
    { id: "issues", label: "Errors & warnings" },
    { id: "uploads", label: "Uploads" },
    { id: "downloads", label: "Downloads" },
    { id: "deletions", label: "Deletions" },
    { id: "folders", label: "Folders" }
]);
const LINKTEXT_META_REGEX: RegExp = /[#|[\]]/;
const MARKDOWN_INLINE_ESCAPES: ReadonlyMap<string, string> = new Map<
    string,
    string
>([
    ["<", "&lt;"],
    [">", "&gt;"],
    ["[[", "\\[\\["],
    ["](", "\\]("],
    ["][", "\\]["],
    ["]]", "\\]\\]"]
]);
const MARKDOWN_INLINE_TOKEN_REGEX: RegExp = /\[\[|\]\]|\]\(|\]\[|[<>]/g;
const MAX_SAFE_TIMESTAMP_MS: number = 8_640_000_000_000_000;
const RUN_FILTER_CHIPS: ReadonlyArray<RunFilterChipSpec> = Object.freeze([
    { id: "all", label: "All" },
    { id: "changes", label: "Changes" },
    { id: "issues", label: "Issues" }
]);
const WHITESPACE_RUN_REGEX: RegExp = /\s+/g;

function addSafeBytes(current: number, delta: number): number {
    const safeCurrent: number =
        Number.isFinite(current) && current > 0
            ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(current))
            : 0;
    const safeDelta: number =
        Number.isFinite(delta) && delta > 0
            ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(delta))
            : 0;
    if (safeCurrent >= Number.MAX_SAFE_INTEGER - safeDelta) {
        return Number.MAX_SAFE_INTEGER;
    }
    return safeCurrent + safeDelta;
}

function buildSummaryPills(run: SyncRunRecord): SummaryPillSpec[] {
    const summary: SyncRunSummary = run.summary;
    const bytes: TransferByteTotals = resolveRunTransferBytes(run);
    const pills: SummaryPillSpec[] = [];
    const uploadedCount: number = toSafeCount(summary.uploaded);
    const downloadedCount: number = toSafeCount(summary.downloaded);
    const conflictsCount: number = toSafeCount(summary.conflictsResolved);
    const warningsCount: number = toSafeCount(summary.warnings);
    const errorsCount: number = toSafeCount(summary.errors);

    if (uploadedCount > 0) {
        pills.push({
            badgeCls: "vaultdav-log-badge-success",
            label: `${uploadedCount} uploaded (${util.formatByteSize(bytes.uploaded)})`
        });
    } else if (bytes.uploaded > 0) {
        pills.push({
            badgeCls: "vaultdav-log-badge-success",
            label: `Uploaded ${util.formatByteSize(bytes.uploaded)}`
        });
    }
    if (downloadedCount > 0) {
        pills.push({
            badgeCls: "vaultdav-log-badge-info",
            label: `${downloadedCount} downloaded (${util.formatByteSize(bytes.downloaded)})`
        });
    } else if (bytes.downloaded > 0) {
        pills.push({
            badgeCls: "vaultdav-log-badge-info",
            label: `Downloaded ${util.formatByteSize(bytes.downloaded)}`
        });
    }
    if (conflictsCount > 0) {
        pills.push({
            badgeCls: "vaultdav-log-badge-warning",
            label:
                conflictsCount === 1
                    ? "1 conflict"
                    : `${conflictsCount} conflicts`
        });
    }
    const deletedTotal: number = addSafeBytes(
        addSafeBytes(summary.deletedLocal, summary.deletedLocalDirs),
        addSafeBytes(summary.deletedRemote, summary.deletedRemoteDirs)
    );
    if (deletedTotal > 0) {
        pills.push({
            badgeCls: "vaultdav-log-badge-danger",
            label: `${deletedTotal} deleted`
        });
    }
    const dirsCreated: number = addSafeBytes(
        summary.dirsCreatedLocal,
        summary.dirsCreatedRemote
    );
    if (dirsCreated > 0) {
        pills.push({
            badgeCls: "vaultdav-log-badge-muted",
            label: dirsCreated === 1 ? "1 folder" : `${dirsCreated} folders`
        });
    }
    if (warningsCount > 0) {
        pills.push({
            badgeCls: "vaultdav-log-badge-warning",
            label:
                warningsCount === 1
                    ? "1 warning"
                    : `${warningsCount} warnings`
        });
    }
    if (errorsCount > 0) {
        pills.push({
            badgeCls: "vaultdav-log-badge-danger",
            label: errorsCount === 1 ? "1 error" : `${errorsCount} errors`
        });
    }
    return pills;
}

export function calculateTotalTransferBytes(
    runs: ReadonlyArray<SyncRunRecord>
): TransferByteTotals {
    let downloaded: number = 0;
    let uploaded: number = 0;
    for (const run of runs) {
        const bytes: TransferByteTotals = resolveRunTransferBytes(run);
        downloaded = addSafeBytes(downloaded, bytes.downloaded);
        uploaded = addSafeBytes(uploaded, bytes.uploaded);
    }
    return { downloaded, uploaded };
}

function clearElement(el: HTMLElement): void {
    if (typeof el.empty === "function") {
        el.empty();
    } else {
        el.replaceChildren();
    }
}

export function collectActiveConflicts(
    files: ReadonlyArray<TFile>,
    configDir: string = ""
): ActiveConflictItem[] {
    const conflicts: ActiveConflictItem[] = [];
    for (const file of files) {
        if (
            file === null ||
            file === undefined ||
            typeof file.path !== "string"
        ) {
            continue;
        }
        const normalizedPath: string = util.normalizeVaultPath(file.path);
        if (
            normalizedPath === "" ||
            util.isExcludedPath(normalizedPath, configDir)
        ) {
            continue;
        }
        const parsed: { originalPath: string; timestampUtc: string } | null =
            util.parseConflictCopyPath(normalizedPath);
        if (
            parsed === null ||
            util.isExcludedPath(parsed.originalPath, configDir)
        ) {
            continue;
        }
        const stat: { mtime: number; size: number } | null | undefined =
            file.stat;
        const mtime: number =
            stat !== undefined &&
            stat !== null &&
            Number.isFinite(stat.mtime) &&
            stat.mtime > 0
                ? Math.floor(stat.mtime)
                : 0;
        const size: number =
            stat !== undefined &&
            stat !== null &&
            Number.isFinite(stat.size) &&
            stat.size > 0
                ? Math.floor(stat.size)
                : 0;
        conflicts.push({
            conflictPath: normalizedPath,
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

function countRunFilterMatches(
    runs: ReadonlyArray<SyncRunRecord>,
    filter: SyncRunFilter
): number {
    if (filter === "all") {
        return runs.length;
    }
    let count: number = 0;
    for (const run of runs) {
        if (matchesRunFilter(run, filter, "")) {
            count += 1;
        }
    }
    return count;
}

function escapeMarkdownInlineToken(token: string): string {
    return MARKDOWN_INLINE_ESCAPES.get(token) ?? token;
}

export function formatDateGroupLabel(
    timestampMs: number,
    nowMs: number = Date.now()
): string {
    if (
        !Number.isFinite(timestampMs) ||
        timestampMs <= 0 ||
        timestampMs > MAX_SAFE_TIMESTAMP_MS
    ) {
        return "Unknown date";
    }
    const date: Date = new Date(Math.floor(timestampMs));
    if (!Number.isFinite(date.getTime())) {
        return "Unknown date";
    }
    if (
        Number.isFinite(nowMs) &&
        nowMs > 0 &&
        nowMs <= MAX_SAFE_TIMESTAMP_MS
    ) {
        const today: Date = new Date(Math.floor(nowMs));
        if (Number.isFinite(today.getTime())) {
            if (
                date.getFullYear() === today.getFullYear() &&
                date.getMonth() === today.getMonth() &&
                date.getDate() === today.getDate()
            ) {
                return "Today";
            }
            const yesterday: Date = new Date(
                today.getFullYear(),
                today.getMonth(),
                today.getDate() - 1
            );
            if (
                date.getFullYear() === yesterday.getFullYear() &&
                date.getMonth() === yesterday.getMonth() &&
                date.getDate() === yesterday.getDate()
            ) {
                return "Yesterday";
            }
        }
    }
    const yyyy: string = String(date.getFullYear()).padStart(4, "0");
    const mm: string = String(date.getMonth() + 1).padStart(2, "0");
    const dd: string = String(date.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
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
    activeConflicts: ReadonlyArray<ActiveConflictItem>,
    configDir: string = ""
): string {
    const lines: string[] = ["# VaultDAV sync summary"];
    if (run === null) {
        lines.push("", "No sync runs recorded yet.");
    } else {
        const s: SyncRunSummary = run.summary;
        const bytes: TransferByteTotals = resolveRunTransferBytes(run);
        const statusLabel: string = getRunStatusMeta(run).label;
        const uploadedCount: number = toSafeCount(s.uploaded);
        const downloadedCount: number = toSafeCount(s.downloaded);
        const conflictsResolved: number = toSafeCount(s.conflictsResolved);
        const conflictsKeepBoth: number = toSafeCount(s.conflictsKeepBoth);
        const conflictsNewestWins: number = toSafeCount(s.conflictsNewestWins);
        const conflictsIdentical: number = toSafeCount(s.conflictsIdentical);
        const deletedLocal: number = toSafeCount(s.deletedLocal);
        const deletedLocalDirs: number = toSafeCount(s.deletedLocalDirs);
        const deletedRemote: number = toSafeCount(s.deletedRemote);
        const deletedRemoteDirs: number = toSafeCount(s.deletedRemoteDirs);
        const totalDeleted: number = addSafeBytes(
            addSafeBytes(deletedLocal, deletedLocalDirs),
            addSafeBytes(deletedRemote, deletedRemoteDirs)
        );
        const totalDirsCreated: number = addSafeBytes(
            s.dirsCreatedLocal,
            s.dirsCreatedRemote
        );
        const warningsCount: number = toSafeCount(s.warnings);
        const errorsCount: number = toSafeCount(s.errors);
        const collapsedCount: number = toSafeCount(run.collapsedCount);
        const safeTrigger: string = sanitizeMarkdownInline(String(run.trigger));

        lines.push(
            "",
            `- Status: ${statusLabel}`,
            `- Finished: ${formatTimestamp(run.finishedAt)}`,
            `- Trigger: ${safeTrigger}`,
            `- Duration: ${formatDuration(run.durationMs)}`,
            `- Uploaded: ${uploadedCount} (${util.formatByteSize(bytes.uploaded)})`,
            `- Downloaded: ${downloadedCount} (${util.formatByteSize(bytes.downloaded)})`,
            `- Conflicts: ${conflictsResolved} (keep both: ${conflictsKeepBoth}, newest wins: ${conflictsNewestWins}, identical: ${conflictsIdentical})`,
            `- Deleted: ${totalDeleted} (local files: ${deletedLocal}, remote files: ${deletedRemote}, local folders: ${deletedLocalDirs}, remote folders: ${deletedRemoteDirs})`,
            `- Folders created: ${totalDirsCreated}`,
            `- Warnings: ${warningsCount}`,
            `- Errors: ${errorsCount}`
        );
        if (collapsedCount > 1) {
            lines.push(`- Consecutive no-op checks: ${collapsedCount}`);
        }
        let truncatedEvents: number = 0;
        if (run.events.length > 0) {
            const visibleEvents: number = Math.min(
                run.events.length,
                MAX_MARKDOWN_EVENTS
            );
            truncatedEvents = run.events.length - visibleEvents;
            lines.push("", "## Events");
            for (let i: number = 0; i < visibleEvents; i += 1) {
                const event: SyncLogEvent | undefined = run.events[i];
                if (event === undefined) {
                    continue;
                }
                const label: string = getEventKindLabel(event.kind);
                const parts: string[] = [`- [${label}]`];
                if (event.path !== undefined && event.path !== "") {
                    parts.push(sanitizeMarkdownPath(event.path, configDir));
                }
                if (event.resolution !== undefined) {
                    const resText: string | null = getConflictResolutionLabel(
                        event.resolution
                    );
                    if (resText !== null) {
                        parts.push(`(${resText})`);
                    }
                }
                if (
                    event.conflictCopyPath !== undefined &&
                    event.conflictCopyPath !== ""
                ) {
                    parts.push(
                        `-> ${sanitizeMarkdownPath(event.conflictCopyPath, configDir)}`
                    );
                }
                if (event.size !== undefined) {
                    parts.push(`[${util.formatByteSize(event.size)}]`);
                }
                if (event.message !== undefined && event.message !== "") {
                    const safeMessage: string = sanitizeMarkdownInline(
                        event.message
                    );
                    if (safeMessage !== "") {
                        parts.push(`: ${safeMessage}`);
                    }
                }
                lines.push(parts.join(" "));
            }
        }
        const totalOmittedEvents: number = addSafeBytes(
            toSafeCount(run.omittedEvents),
            truncatedEvents
        );
        if (totalOmittedEvents > 0) {
            lines.push(
                "",
                truncatedEvents > 0
                    ? `Note: ${totalOmittedEvents} additional event(s) omitted.`
                    : `Note: ${totalOmittedEvents} additional routine event(s) omitted.`
            );
        }
    }

    const safeConflicts: ActiveConflictItem[] = [];
    for (const item of activeConflicts) {
        if (
            !util.isExcludedPath(item.conflictPath, configDir) &&
            !util.isExcludedPath(item.originalPath, configDir)
        ) {
            safeConflicts.push(item);
        }
    }
    if (safeConflicts.length > 0) {
        const visibleConflicts: number = Math.min(
            safeConflicts.length,
            MAX_MARKDOWN_CONFLICTS
        );
        lines.push("", `## Active conflict copies (${safeConflicts.length})`);
        for (let i: number = 0; i < visibleConflicts; i += 1) {
            const item: ActiveConflictItem | undefined = safeConflicts[i];
            if (item === undefined) {
                continue;
            }
            const conflictPath: string = sanitizeMarkdownInline(
                item.conflictPath
            );
            const originalPath: string = sanitizeMarkdownInline(
                item.originalPath
            );
            const timestampUtc: string = sanitizeMarkdownInline(
                item.timestampUtc
            );
            lines.push(
                `- ${conflictPath} (original: ${originalPath}, ${timestampUtc})`
            );
        }
        const omittedConflicts: number =
            safeConflicts.length - visibleConflicts;
        if (omittedConflicts > 0) {
            lines.push(
                "",
                `Note: ${omittedConflicts} additional conflict copies omitted.`
            );
        }
    }
    return lines.join("\n");
}

export function formatTimeOfDay(timestampMs: number): string {
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
    const hh: string = String(date.getHours()).padStart(2, "0");
    const min: string = String(date.getMinutes()).padStart(2, "0");
    const ss: string = String(date.getSeconds()).padStart(2, "0");
    return `${hh}:${min}:${ss}`;
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
        const collapsedCount: number = toSafeCount(run.collapsedCount);
        return collapsedCount > 1
            ? `No changes (${collapsedCount} checks)`
            : "No changes";
    }
    const s: SyncRunSummary = run.summary;
    const bytes: TransferByteTotals = resolveRunTransferBytes(run);
    const parts: string[] = [];
    const uploadedCount: number = toSafeCount(s.uploaded);
    const downloadedCount: number = toSafeCount(s.downloaded);
    const conflictsCount: number = toSafeCount(s.conflictsResolved);
    const warningsCount: number = toSafeCount(s.warnings);
    const errorsCount: number = toSafeCount(s.errors);

    if (uploadedCount > 0) {
        parts.push(
            `${uploadedCount} up (${util.formatByteSize(bytes.uploaded)})`
        );
    } else if (bytes.uploaded > 0) {
        parts.push(`up ${util.formatByteSize(bytes.uploaded)}`);
    }
    if (downloadedCount > 0) {
        parts.push(
            `${downloadedCount} down (${util.formatByteSize(bytes.downloaded)})`
        );
    } else if (bytes.downloaded > 0) {
        parts.push(`down ${util.formatByteSize(bytes.downloaded)}`);
    }
    if (conflictsCount > 0) {
        parts.push(
            conflictsCount === 1
                ? "1 conflict"
                : `${conflictsCount} conflicts`
        );
    }
    const deletedTotal: number = addSafeBytes(
        addSafeBytes(s.deletedLocal, s.deletedLocalDirs),
        addSafeBytes(s.deletedRemote, s.deletedRemoteDirs)
    );
    if (deletedTotal > 0) {
        parts.push(`${deletedTotal} deleted`);
    }
    const dirsCreated: number = addSafeBytes(
        s.dirsCreatedLocal,
        s.dirsCreatedRemote
    );
    if (dirsCreated > 0) {
        parts.push(
            dirsCreated === 1 ? "1 folder" : `${dirsCreated} folders`
        );
    }
    if (warningsCount > 0) {
        parts.push(
            warningsCount === 1 ? "1 warning" : `${warningsCount} warnings`
        );
    }
    if (errorsCount > 0) {
        parts.push(errorsCount === 1 ? "1 error" : `${errorsCount} errors`);
    }
    if (parts.length === 0) {
        return run.status === "failed" ? "Sync failed" : "No changes";
    }
    return parts.join(" · ");
}

function getConflictResolutionLabel(
    resolution: ConflictResolutionMode
): string | null {
    return CONFLICT_RESOLUTION_LABELS.get(resolution) ?? null;
}

function getEventKindBadgeClass(kind: SyncEventKind): string {
    return EVENT_KIND_BADGE_CLASSES.get(kind) ?? "vaultdav-log-badge-muted";
}

function getEventKindLabel(kind: SyncEventKind): string {
    return EVENT_KIND_LABELS.get(kind) ?? "Unknown";
}

function getRunStatusMeta(run: SyncRunRecord): {
    badgeCls: string;
    label: string;
} {
    if (run.status === "failed") {
        return { badgeCls: "vaultdav-log-badge-danger", label: "Failed" };
    }
    if (run.status === "partial" || toSafeCount(run.summary.errors) > 0) {
        return { badgeCls: "vaultdav-log-badge-danger", label: "Errors" };
    }
    if (toSafeCount(run.summary.conflictsResolved) > 0) {
        return { badgeCls: "vaultdav-log-badge-warning", label: "Conflicts" };
    }
    if (toSafeCount(run.summary.warnings) > 0) {
        return { badgeCls: "vaultdav-log-badge-warning", label: "Warnings" };
    }
    if (isNoopRun(run)) {
        return { badgeCls: "vaultdav-log-badge-muted", label: "No changes" };
    }
    return { badgeCls: "vaultdav-log-badge-success", label: "Synced" };
}

function isVaultFileHandle(
    candidate: TAbstractFile | null
): candidate is TFile {
    if (candidate === null || typeof candidate !== "object") {
        return false;
    }
    if (candidate instanceof TFolder) {
        return false;
    }
    if (
        ("children" in candidate &&
            Array.isArray((candidate as { children?: unknown }).children)) ||
        typeof (candidate as { isRoot?: unknown }).isRoot === "function"
    ) {
        return false;
    }
    if (candidate instanceof TFile) {
        return true;
    }
    return typeof candidate.path === "string" && candidate.path !== "";
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

export function matchesRunFilter(
    run: SyncRunRecord,
    filter: SyncRunFilter,
    queryLower: string
): boolean {
    if (filter === "changes" && isNoopRun(run)) {
        return false;
    }
    if (filter === "issues" && !isCriticalRun(run)) {
        return false;
    }
    if (queryLower === "") {
        return true;
    }
    if (formatTimestamp(run.finishedAt).toLowerCase().includes(queryLower)) {
        return true;
    }
    if (getRunStatusMeta(run).label.toLowerCase().includes(queryLower)) {
        return true;
    }
    if (run.trigger.toLowerCase().includes(queryLower)) {
        return true;
    }
    if (getCompactRunSummaryText(run).toLowerCase().includes(queryLower)) {
        return true;
    }
    for (const event of run.events) {
        if (matchesEventFilter(event, "all", queryLower)) {
            return true;
        }
    }
    return false;
}

function resolveRunTransferBytes(run: SyncRunRecord): TransferByteTotals {
    let uploaded: number = addSafeBytes(0, run.summary.bytesUploaded);
    let downloaded: number = addSafeBytes(0, run.summary.bytesDownloaded);
    const needsUploadFallback: boolean =
        uploaded === 0 &&
        (toSafeCount(run.summary.uploaded) > 0 ||
            toSafeCount(run.summary.conflictsResolved) > 0);
    const needsDownloadFallback: boolean =
        downloaded === 0 &&
        (toSafeCount(run.summary.downloaded) > 0 ||
            toSafeCount(run.summary.conflictsResolved) > 0);

    if (
        (needsUploadFallback || needsDownloadFallback) &&
        run.events.length > 0
    ) {
        let fallbackUp: number = 0;
        let fallbackDown: number = 0;
        for (const event of run.events) {
            if (event.size === undefined) {
                continue;
            }
            if (event.kind === "upload") {
                fallbackUp = addSafeBytes(fallbackUp, event.size);
            } else if (event.kind === "download") {
                fallbackDown = addSafeBytes(fallbackDown, event.size);
            } else if (event.kind === "conflict") {
                if (
                    event.resolution === "keep_both" ||
                    event.resolution === "newest_wins_local"
                ) {
                    fallbackUp = addSafeBytes(fallbackUp, event.size);
                } else if (
                    event.resolution === "identical" ||
                    event.resolution === "newest_wins_remote"
                ) {
                    fallbackDown = addSafeBytes(fallbackDown, event.size);
                }
            }
        }
        if (needsUploadFallback && fallbackUp > 0) {
            uploaded = fallbackUp;
        }
        if (needsDownloadFallback && fallbackDown > 0) {
            downloaded = fallbackDown;
        }
    }
    return { downloaded, uploaded };
}

function sanitizeMarkdownInline(value: string): string {
    const redacted: string = redactSensitiveText(value);
    const flattened: string = stripAndFlattenControlChars(redacted)
        .replace(WHITESPACE_RUN_REGEX, " ")
        .trim();
    return flattened.replace(
        MARKDOWN_INLINE_TOKEN_REGEX,
        escapeMarkdownInlineToken
    );
}

function sanitizeMarkdownPath(path: string, configDir: string): string {
    const normalized: string = util.normalizeVaultPath(path);
    if (normalized === "" || util.isExcludedPath(normalized, configDir)) {
        return "(excluded path)";
    }
    return sanitizeMarkdownInline(normalized);
}

function stripAndFlattenControlChars(value: string): string {
    let result: string = "";
    let changed: boolean = false;
    let sliceStart: number = 0;
    for (let i: number = 0; i < value.length; i += 1) {
        const code: number = value.charCodeAt(i);
        const isLineBreakOrTab: boolean =
            code === 9 ||
            code === 10 ||
            code === 13 ||
            code === 0x2028 ||
            code === 0x2029;
        const isOtherControl: boolean =
            (code <= 0x1f && !isLineBreakOrTab) || code === 0x7f;
        if (isLineBreakOrTab || isOtherControl) {
            changed = true;
            if (i > sliceStart) {
                result += value.slice(sliceStart, i);
            }
            if (isLineBreakOrTab) {
                result += " ";
            }
            sliceStart = i + 1;
        }
    }
    if (!changed) {
        return value;
    }
    if (sliceStart < value.length) {
        result += value.slice(sliceStart);
    }
    return result;
}

function toSafeCount(value: number): number {
    if (!Number.isFinite(value) || value <= 0) {
        return 0;
    }
    return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value));
}

export class SyncLogView extends ItemView {
    private activeConflictsCache: ActiveConflictItem[] = [];
    private activeEventFilter: SyncLogFilter = "all";
    private activeRunFilter: SyncRunFilter = "all";
    private confirmingClear: boolean = false;
    private detailsSectionEl: HTMLElement | null = null;
    private eventSearchQuery: string = "";
    private filteredRunsCache: SyncRunRecord[] = [];
    private historyCountEl: HTMLElement | null = null;
    private isClearingHistory: boolean = false;
    private isViewOpen: boolean = false;
    private lastLatestRunId: string | null = null;
    private lifecycleVersion: number = 0;
    private readonly plugin: VaultDavPlugin;
    private readonly runButtonMap: Map<string, HTMLButtonElement> = new Map<
        string,
        HTMLButtonElement
    >();
    private runFilterBarEl: HTMLElement | null = null;
    private runFooterEl: HTMLElement | null = null;
    private runListEl: HTMLElement | null = null;
    private runSearchQuery: string = "";
    private runsCache: SyncRunRecord[] = [];
    private selectedRunId: string | null = null;
    private toolbarEl: HTMLElement | null = null;
    private totalsBarEl: HTMLElement | null = null;
    private visibleConflictLimit: number = CONFLICT_PAGE_SIZE;
    private visibleEventLimit: number = EVENT_PAGE_SIZE;
    private visibleRunLimit: number = RUN_PAGE_SIZE;

    public constructor(leaf: WorkspaceLeaf, plugin: VaultDavPlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    private clearDomReferences(): void {
        this.detailsSectionEl = null;
        this.historyCountEl = null;
        this.runButtonMap.clear();
        this.runFilterBarEl = null;
        this.runFooterEl = null;
        this.runListEl = null;
        this.toolbarEl = null;
        this.totalsBarEl = null;
    }

    private getActiveConflicts(): ActiveConflictItem[] {
        if (typeof this.app.vault.getFiles !== "function") {
            return [];
        }
        return collectActiveConflicts(
            this.app.vault.getFiles(),
            this.getConfigDir()
        );
    }

    private getConfigDir(): string {
        return typeof this.app.vault?.configDir === "string"
            ? this.app.vault.configDir
            : "";
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
        if (this.isClearingHistory || !this.isViewOpen) {
            return;
        }
        const clearVersion: number = this.lifecycleVersion;
        this.isClearingHistory = true;
        this.renderToolbar();
        try {
            await this.plugin.clearSyncHistory();
        } catch (err: unknown) {
            log.warn("Failed to clear sync history:", err);
            log.notify("Failed to clear sync history.");
            if (this.isViewOpen && this.lifecycleVersion === clearVersion) {
                this.isClearingHistory = false;
                this.confirmingClear = false;
                this.renderToolbar();
            }
            return;
        }
        if (!this.isViewOpen || this.lifecycleVersion !== clearVersion) {
            return;
        }
        this.isClearingHistory = false;
        this.confirmingClear = false;
        this.selectedRunId = null;
        this.lastLatestRunId = null;
        this.activeRunFilter = "all";
        this.runSearchQuery = "";
        this.activeEventFilter = "all";
        this.eventSearchQuery = "";
        this.visibleConflictLimit = CONFLICT_PAGE_SIZE;
        this.visibleEventLimit = EVENT_PAGE_SIZE;
        this.visibleRunLimit = RUN_PAGE_SIZE;
        log.notify("Sync history cleared.");
        this.render();
    }

    private async handleCopySummary(
        run: SyncRunRecord | null,
        activeConflicts: ReadonlyArray<ActiveConflictItem>
    ): Promise<void> {
        const text: string = formatRunSummaryMarkdown(
            run,
            activeConflicts,
            this.getConfigDir()
        );
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
        if (
            normalized === "" ||
            util.isExcludedPath(normalized, this.getConfigDir())
        ) {
            return;
        }
        const file: TFile | null = this.resolveVaultFile(normalized);
        if (file === null) {
            log.notify("File no longer exists in vault.");
            return;
        }
        try {
            if (this.app.workspace === undefined) {
                return;
            }
            if (typeof this.app.workspace.getLeaf === "function") {
                const leaf: WorkspaceLeaf | null =
                    this.app.workspace.getLeaf(false);
                if (leaf !== null && typeof leaf.openFile === "function") {
                    await leaf.openFile(file);
                    return;
                }
            }
            if (typeof this.app.workspace.openLinkText === "function") {
                if (LINKTEXT_META_REGEX.test(normalized)) {
                    log.notify(
                        "Cannot open file path safely in this workspace."
                    );
                    return;
                }
                await this.app.workspace.openLinkText(normalized, "", false);
            }
        } catch (err: unknown) {
            log.warn("Failed to open vault file:", err);
            log.notify("Failed to open file in vault.");
        }
    }

    private handleSelectRun(runId: string): void {
        if (this.selectedRunId === runId) {
            return;
        }
        if (this.selectedRunId !== null) {
            const prevBtn: HTMLButtonElement | undefined =
                this.runButtonMap.get(this.selectedRunId);
            if (prevBtn !== undefined) {
                prevBtn.classList.remove("is-selected");
                prevBtn.setAttribute("aria-pressed", "false");
            }
        }
        this.selectedRunId = runId;
        this.activeEventFilter = "all";
        this.eventSearchQuery = "";
        this.visibleEventLimit = EVENT_PAGE_SIZE;
        const nextBtn: HTMLButtonElement | undefined =
            this.runButtonMap.get(runId);
        if (nextBtn !== undefined) {
            nextBtn.classList.add("is-selected");
            nextBtn.setAttribute("aria-pressed", "true");
        }
        this.renderRunDetails();
    }

    private async handleTriggerSync(): Promise<void> {
        try {
            await this.plugin.triggerSync("manual");
        } catch (err: unknown) {
            log.warn("Failed to trigger manual sync:", err);
        }
    }

    private isOpenableVaultPath(path: string): boolean {
        const normalized: string = util.normalizeVaultPath(path);
        return (
            normalized !== "" &&
            !util.isExcludedPath(normalized, this.getConfigDir())
        );
    }

    public async onClose(): Promise<void> {
        this.isViewOpen = false;
        this.lifecycleVersion += 1;
        this.confirmingClear = false;
        this.isClearingHistory = false;
        this.runsCache = [];
        this.filteredRunsCache = [];
        this.activeConflictsCache = [];
        this.clearDomReferences();
        clearElement(this.contentEl);
        await Promise.resolve();
    }

    public async onOpen(): Promise<void> {
        this.isViewOpen = true;
        this.lifecycleVersion += 1;
        const openVersion: number = this.lifecycleVersion;
        this.contentEl.classList.add("vaultdav-log");
        try {
            await this.plugin.loadSyncHistory();
        } catch (err: unknown) {
            log.warn("Failed to load sync history:", err);
        }
        if (!this.isViewOpen || this.lifecycleVersion !== openVersion) {
            return;
        }
        this.render();
    }

    public refresh(): void {
        if (!this.isViewOpen) {
            return;
        }
        this.render();
    }

    private render(): void {
        const container: HTMLElement = this.contentEl;
        this.clearDomReferences();
        clearElement(container);
        container.classList.add("vaultdav-log");

        const runs: SyncRunRecord[] = this.plugin.getSyncHistoryRuns();
        const activeConflicts: ActiveConflictItem[] = this.getActiveConflicts();
        this.runsCache = runs;
        this.activeConflictsCache = activeConflicts;

        const newestRunId: string | null = runs[0]?.id ?? null;
        if (
            newestRunId !== null &&
            this.lastLatestRunId !== null &&
            newestRunId !== this.lastLatestRunId &&
            this.selectedRunId === this.lastLatestRunId
        ) {
            this.selectedRunId = newestRunId;
            this.activeEventFilter = "all";
            this.eventSearchQuery = "";
            this.visibleEventLimit = EVENT_PAGE_SIZE;
        }
        this.lastLatestRunId = newestRunId;

        this.toolbarEl = container.createDiv({ cls: "vaultdav-log-toolbar" });
        this.renderToolbar();
        this.renderActiveConflicts(container, activeConflicts);

        if (runs.length === 0) {
            const emptySection: HTMLElement = container.createDiv({
                cls: "vaultdav-log-section"
            });
            emptySection.createDiv({
                cls: "vaultdav-log-section-title",
                text: "Sync history"
            });
            emptySection.createDiv({
                cls: "vaultdav-log-empty",
                text: "No sync runs recorded yet."
            });
            this.filteredRunsCache = [];
            this.selectedRunId = null;
            return;
        }

        const workspace: HTMLElement = container.createDiv({
            cls: "vaultdav-log-workspace"
        });
        const workspaceGrid: HTMLElement = workspace.createDiv({
            cls: "vaultdav-log-workspace-grid"
        });
        this.renderRunHistorySection(workspaceGrid);
        this.detailsSectionEl = workspaceGrid.createDiv({
            cls: "vaultdav-log-section vaultdav-log-details-section"
        });
        this.updateRunListView(false);
    }

    private renderActiveConflicts(
        container: HTMLElement,
        activeConflicts: ReadonlyArray<ActiveConflictItem>
    ): void {
        if (activeConflicts.length === 0) {
            const compactBar: HTMLElement = container.createDiv({
                cls: "vaultdav-log-section vaultdav-log-conflicts-empty"
            });
            const headerRow: HTMLElement = compactBar.createDiv({
                cls: "vaultdav-log-section-header"
            });
            headerRow.createDiv({
                cls: "vaultdav-log-section-title",
                text: "Active conflict copies"
            });
            headerRow.createSpan({
                cls: "vaultdav-log-badge vaultdav-log-badge-muted",
                text: "None"
            });
            return;
        }

        const section: HTMLElement = container.createDiv({
            cls: "vaultdav-log-section vaultdav-log-conflicts-active"
        });
        const headerRow: HTMLElement = section.createDiv({
            cls: "vaultdav-log-section-header"
        });
        headerRow.createDiv({
            cls: "vaultdav-log-section-title",
            text: `Active conflict copies (${activeConflicts.length})`
        });

        const list: HTMLElement = section.createDiv({
            cls: "vaultdav-log-conflict-list"
        });
        const footer: HTMLElement = section.createDiv({
            cls: "vaultdav-log-conflict-footer"
        });

        const populateConflicts = (): void => {
            const prevScrollTop: number = list.scrollTop;
            clearElement(list);
            clearElement(footer);

            const visibleCount: number = Math.min(
                activeConflicts.length,
                this.visibleConflictLimit
            );
            for (let i: number = 0; i < visibleCount; i += 1) {
                const item: ActiveConflictItem | undefined = activeConflicts[i];
                if (item === undefined) {
                    continue;
                }
                const row: HTMLElement = list.createDiv({
                    cls: "vaultdav-log-conflict-item"
                });
                const info: HTMLElement = row.createDiv({
                    cls: "vaultdav-log-conflict-info"
                });
                const displayConflictPath: string = redactSensitiveText(
                    item.conflictPath
                );
                const displayOriginalPath: string = redactSensitiveText(
                    item.originalPath
                );
                const conflictLink: HTMLButtonElement = info.createEl(
                    "button",
                    {
                        cls: "vaultdav-log-path-link",
                        text: displayConflictPath
                    }
                );
                conflictLink.type = "button";
                conflictLink.addEventListener("click", (): void => {
                    void this.handleOpenVaultPath(item.conflictPath);
                });

                const meta: HTMLElement = info.createDiv({
                    cls: "vaultdav-log-meta"
                });
                meta.createSpan({
                    text: `Original: ${displayOriginalPath} · ${item.timestampUtc}`
                });
                if (item.size > 0) {
                    meta.createSpan({
                        text: ` · ${util.formatByteSize(item.size)}`
                    });
                }

                const actions: HTMLElement = row.createDiv({
                    cls: "vaultdav-log-conflict-actions"
                });
                const openCopyBtn: HTMLButtonElement = actions.createEl(
                    "button",
                    {
                        cls: "vaultdav-log-mini-btn",
                        text: "Open copy"
                    }
                );
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

            if (activeConflicts.length > visibleCount) {
                const remaining: number = activeConflicts.length - visibleCount;
                const pager: HTMLElement = footer.createDiv({
                    cls: "vaultdav-log-pagination"
                });
                pager.createSpan({
                    cls: "vaultdav-log-meta",
                    text: `Showing ${visibleCount} of ${activeConflicts.length} conflict copies`
                });
                const moreBtn: HTMLButtonElement = pager.createEl("button", {
                    cls: "vaultdav-log-mini-btn",
                    text: `Show more conflicts (${remaining} remaining)`
                });
                moreBtn.type = "button";
                moreBtn.addEventListener("click", (): void => {
                    this.visibleConflictLimit += CONFLICT_PAGE_SIZE;
                    populateConflicts();
                });
            }
            list.scrollTop = prevScrollTop;
        };

        populateConflicts();
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
        const badgeCls: string = getEventKindBadgeClass(event.kind);
        const badgeLabel: string = getEventKindLabel(event.kind);
        header.createSpan({
            cls: `vaultdav-log-badge ${badgeCls}`,
            text: badgeLabel
        });

        if (event.path !== undefined && event.path !== "") {
            const displayPath: string = redactSensitiveText(event.path);
            const canOpen: boolean =
                event.isDirectory !== true &&
                event.kind !== "create_local_dir" &&
                event.kind !== "create_remote_dir" &&
                event.kind !== "delete_local" &&
                event.kind !== "delete_remote" &&
                this.isOpenableVaultPath(event.path);
            if (canOpen) {
                const pathBtn: HTMLButtonElement = header.createEl("button", {
                    cls: "vaultdav-log-path-link",
                    text: displayPath
                });
                pathBtn.type = "button";
                const targetPath: string = event.path;
                pathBtn.addEventListener("click", (): void => {
                    void this.handleOpenVaultPath(targetPath);
                });
            } else {
                header.createSpan({
                    cls: "vaultdav-log-path-text",
                    text: displayPath
                });
            }
        }

        if (event.size !== undefined) {
            header.createSpan({
                cls: "vaultdav-log-size",
                text: util.formatByteSize(event.size)
            });
        }

        const resText: string | null =
            event.resolution !== undefined
                ? getConflictResolutionLabel(event.resolution)
                : null;
        const hasConflictCopy: boolean =
            event.conflictCopyPath !== undefined &&
            event.conflictCopyPath !== "";
        if (resText !== null || hasConflictCopy) {
            const detail: HTMLElement = row.createDiv({
                cls: "vaultdav-log-event-detail"
            });
            if (resText !== null) {
                detail.createSpan({
                    text: resText
                });
            }
            if (hasConflictCopy && event.conflictCopyPath !== undefined) {
                if (resText !== null) {
                    detail.createSpan({ text: ": " });
                }
                const copyPath: string = event.conflictCopyPath;
                const displayCopyPath: string = redactSensitiveText(copyPath);
                if (
                    event.isDirectory !== true &&
                    this.isOpenableVaultPath(copyPath)
                ) {
                    const copyBtn: HTMLButtonElement = detail.createEl(
                        "button",
                        {
                            cls: "vaultdav-log-path-link",
                            text: displayCopyPath
                        }
                    );
                    copyBtn.type = "button";
                    copyBtn.addEventListener("click", (): void => {
                        void this.handleOpenVaultPath(copyPath);
                    });
                } else {
                    detail.createSpan({
                        cls: "vaultdav-log-path-text",
                        text: displayCopyPath
                    });
                }
            }
        }

        if (event.message !== undefined && event.message !== "") {
            row.createDiv({
                cls: "vaultdav-log-event-message",
                text: redactSensitiveText(event.message)
            });
        }
    }

    private renderRunDetails(): void {
        if (this.detailsSectionEl === null) {
            return;
        }
        const section: HTMLElement = this.detailsSectionEl;
        clearElement(section);

        const selectedRun: SyncRunRecord | null = this.getSelectedRun(
            this.filteredRunsCache
        );
        const headerRow: HTMLElement = section.createDiv({
            cls: "vaultdav-log-section-header"
        });
        headerRow.createDiv({
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

        const copyBtn: HTMLButtonElement = headerRow.createEl("button", {
            cls: "vaultdav-log-mini-btn",
            text: "Copy summary"
        });
        copyBtn.type = "button";
        copyBtn.addEventListener("click", (): void => {
            void this.handleCopySummary(
                selectedRun,
                this.activeConflictsCache
            );
        });

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

        const summaryPills: SummaryPillSpec[] = buildSummaryPills(selectedRun);
        if (summaryPills.length > 0) {
            const pillsRow: HTMLElement = section.createDiv({
                cls: "vaultdav-log-summary-pills"
            });
            for (const pill of summaryPills) {
                pillsRow.createSpan({
                    cls: `vaultdav-log-badge ${pill.badgeCls}`,
                    text: pill.label
                });
            }
        }

        if (
            selectedRun.collapsedCount > 1 &&
            selectedRun.firstCollapsedAt !== undefined
        ) {
            section.createDiv({
                cls: "vaultdav-log-notice-box",
                text: `${selectedRun.collapsedCount} consecutive no-op checks folded (${formatTimestamp(selectedRun.firstCollapsedAt)} to ${formatTimestamp(selectedRun.finishedAt)}).`
            });
        }

        if (selectedRun.events.length === 0) {
            if (selectedRun.detailsPruned) {
                section.createDiv({
                    cls: "vaultdav-log-notice-box",
                    text: "Detailed events for this older run were compacted to stay within storage limits. Summary totals remain complete."
                });
            } else {
                section.createDiv({
                    cls: "vaultdav-log-empty",
                    text: "No changes were needed during this sync."
                });
            }
            return;
        }

        const filterBar: HTMLElement = section.createDiv({
            cls: "vaultdav-log-filters"
        });
        const chipButtons: Array<{
            btn: HTMLButtonElement;
            id: SyncLogFilter;
        }> = [];
        for (const chip of FILTER_CHIPS) {
            const count: number = countFilterMatches(
                selectedRun.events,
                chip.id
            );
            if (
                chip.id !== "all" &&
                count === 0 &&
                this.activeEventFilter !== chip.id
            ) {
                continue;
            }
            const isActive: boolean = this.activeEventFilter === chip.id;
            const chipCls: string = isActive
                ? "vaultdav-log-chip is-active"
                : "vaultdav-log-chip";
            const btn: HTMLButtonElement = filterBar.createEl("button", {
                cls: chipCls,
                text: `${chip.label} (${count})`
            });
            btn.type = "button";
            btn.setAttribute("aria-pressed", isActive ? "true" : "false");
            chipButtons.push({ btn, id: chip.id });
        }

        const searchWrap: HTMLElement = section.createDiv({
            cls: "vaultdav-log-search-wrap"
        });
        const searchInput: HTMLInputElement = searchWrap.createEl("input", {
            cls: "vaultdav-log-search-input"
        });
        searchInput.type = "search";
        searchInput.autocapitalize = "none";
        searchInput.setAttribute("autocapitalize", "none");
        searchInput.setAttribute("autocorrect", "off");
        searchInput.autocomplete = "off";
        searchInput.spellcheck = false;
        searchInput.placeholder = "Filter by file path";
        searchInput.value = this.eventSearchQuery;

        const eventsList: HTMLElement = section.createDiv({
            cls: "vaultdav-log-events"
        });

        const populateEvents = (): void => {
            clearElement(eventsList);
            if (selectedRun.detailsPruned) {
                eventsList.createDiv({
                    cls: "vaultdav-log-notice-box",
                    text: "Detailed events for this older run were compacted to stay within storage limits. Summary totals remain complete."
                });
            }
            const queryLower: string = this.eventSearchQuery
                .trim()
                .toLowerCase();
            const filtered: SyncLogEvent[] = selectedRun.events.filter(
                (event: SyncLogEvent): boolean =>
                    matchesEventFilter(
                        event,
                        this.activeEventFilter,
                        queryLower
                    )
            );
            if (filtered.length === 0) {
                eventsList.createDiv({
                    cls: "vaultdav-log-empty",
                    text: "No events match the current filter."
                });
            } else {
                const visibleCount: number = Math.min(
                    filtered.length,
                    this.visibleEventLimit
                );
                for (let i: number = 0; i < visibleCount; i += 1) {
                    const event: SyncLogEvent | undefined = filtered[i];
                    if (event !== undefined) {
                        this.renderEventRow(eventsList, event);
                    }
                }
                if (filtered.length > visibleCount) {
                    const remaining: number = filtered.length - visibleCount;
                    const pager: HTMLElement = eventsList.createDiv({
                        cls: "vaultdav-log-pagination"
                    });
                    pager.createSpan({
                        cls: "vaultdav-log-meta",
                        text: `Showing ${visibleCount} of ${filtered.length} events`
                    });
                    const moreBtn: HTMLButtonElement = pager.createEl(
                        "button",
                        {
                            cls: "vaultdav-log-mini-btn",
                            text: `Show more events (${remaining} remaining)`
                        }
                    );
                    moreBtn.type = "button";
                    moreBtn.addEventListener("click", (): void => {
                        this.visibleEventLimit += EVENT_PAGE_SIZE;
                        populateEvents();
                    });
                }
            }
            if (!selectedRun.detailsPruned && selectedRun.omittedEvents > 0) {
                eventsList.createDiv({
                    cls: "vaultdav-log-notice-box",
                    text: `${selectedRun.omittedEvents} routine event(s) omitted to stay within per-run storage limits. Conflicts, errors, and totals remain complete.`
                });
            }
        };

        for (const entry of chipButtons) {
            entry.btn.addEventListener("click", (): void => {
                this.activeEventFilter = entry.id;
                this.visibleEventLimit = EVENT_PAGE_SIZE;
                for (const item of chipButtons) {
                    const active: boolean = item.id === this.activeEventFilter;
                    item.btn.classList.toggle("is-active", active);
                    item.btn.setAttribute(
                        "aria-pressed",
                        active ? "true" : "false"
                    );
                }
                populateEvents();
            });
        }

        searchInput.addEventListener("input", (): void => {
            this.eventSearchQuery = searchInput.value;
            this.visibleEventLimit = EVENT_PAGE_SIZE;
            populateEvents();
        });
        populateEvents();
    }

    private renderRunFilterBar(): void {
        if (this.runFilterBarEl === null) {
            return;
        }
        clearElement(this.runFilterBarEl);
        for (const chip of RUN_FILTER_CHIPS) {
            const count: number = countRunFilterMatches(
                this.runsCache,
                chip.id
            );
            const isActive: boolean = this.activeRunFilter === chip.id;
            const chipCls: string = isActive
                ? "vaultdav-log-chip is-active"
                : "vaultdav-log-chip";
            const btn: HTMLButtonElement = this.runFilterBarEl.createEl(
                "button",
                {
                    cls: chipCls,
                    text: `${chip.label} (${count})`
                }
            );
            btn.type = "button";
            btn.setAttribute("aria-pressed", isActive ? "true" : "false");
            btn.addEventListener("click", (): void => {
                if (this.activeRunFilter === chip.id) {
                    return;
                }
                this.activeRunFilter = chip.id;
                this.visibleRunLimit = RUN_PAGE_SIZE;
                this.updateRunListView(true);
            });
        }
    }

    private renderRunHistorySection(container: HTMLElement): void {
        const section: HTMLElement = container.createDiv({
            cls: "vaultdav-log-section vaultdav-log-history-section"
        });
        const headerRow: HTMLElement = section.createDiv({
            cls: "vaultdav-log-section-header"
        });
        headerRow.createDiv({
            cls: "vaultdav-log-section-title",
            text: "Sync history"
        });
        this.historyCountEl = headerRow.createSpan({
            cls: "vaultdav-log-meta"
        });

        this.totalsBarEl = section.createDiv({
            cls: "vaultdav-log-totals-bar"
        });

        this.runFilterBarEl = section.createDiv({
            cls: "vaultdav-log-filters"
        });

        const searchWrap: HTMLElement = section.createDiv({
            cls: "vaultdav-log-search-wrap"
        });
        const runSearchInput: HTMLInputElement = searchWrap.createEl("input", {
            cls: "vaultdav-log-run-search-input"
        });
        runSearchInput.type = "search";
        runSearchInput.autocapitalize = "none";
        runSearchInput.setAttribute("autocapitalize", "none");
        runSearchInput.setAttribute("autocorrect", "off");
        runSearchInput.autocomplete = "off";
        runSearchInput.spellcheck = false;
        runSearchInput.placeholder = "Search runs by path, error, or date";
        runSearchInput.value = this.runSearchQuery;
        runSearchInput.addEventListener("input", (): void => {
            this.runSearchQuery = runSearchInput.value;
            this.visibleRunLimit = RUN_PAGE_SIZE;
            this.updateRunListView(true);
        });

        this.runListEl = section.createDiv({
            cls: "vaultdav-log-run-list"
        });
        this.runFooterEl = section.createDiv({
            cls: "vaultdav-log-run-footer"
        });
    }

    private renderRunList(preserveScroll: boolean): void {
        if (this.runListEl === null || this.runFooterEl === null) {
            return;
        }
        const prevScrollTop: number = preserveScroll
            ? this.runListEl.scrollTop
            : 0;
        clearElement(this.runListEl);
        clearElement(this.runFooterEl);
        this.runButtonMap.clear();

        if (this.historyCountEl !== null) {
            this.historyCountEl.textContent =
                this.filteredRunsCache.length === this.runsCache.length
                    ? `${this.runsCache.length}`
                    : `${this.filteredRunsCache.length} of ${this.runsCache.length}`;
        }

        if (this.totalsBarEl !== null) {
            clearElement(this.totalsBarEl);
            const totals: TransferByteTotals = calculateTotalTransferBytes(
                this.filteredRunsCache
            );
            this.totalsBarEl.createSpan({
                cls: "vaultdav-log-meta",
                text: "Total"
            });
            this.totalsBarEl.createSpan({
                cls: "vaultdav-log-badge vaultdav-log-badge-success",
                text: `Up ${util.formatByteSize(totals.uploaded)}`
            });
            this.totalsBarEl.createSpan({
                cls: "vaultdav-log-badge vaultdav-log-badge-info",
                text: `Down ${util.formatByteSize(totals.downloaded)}`
            });
        }

        if (this.filteredRunsCache.length === 0) {
            this.runListEl.createDiv({
                cls: "vaultdav-log-empty",
                text: "No sync runs match the current filter."
            });
            return;
        }

        const visibleCount: number = Math.min(
            this.filteredRunsCache.length,
            this.visibleRunLimit
        );
        const nowMs: number = Date.now();
        let currentDateGroup: string = "";

        for (let i: number = 0; i < visibleCount; i += 1) {
            const run: SyncRunRecord | undefined = this.filteredRunsCache[i];
            if (run === undefined) {
                continue;
            }
            const dateGroup: string = formatDateGroupLabel(
                run.finishedAt,
                nowMs
            );
            if (dateGroup !== currentDateGroup) {
                currentDateGroup = dateGroup;
                this.runListEl.createDiv({
                    cls: "vaultdav-log-date-group",
                    text: dateGroup
                });
            }

            const isSelected: boolean = this.selectedRunId === run.id;
            const rowCls: string = isSelected
                ? "vaultdav-log-run-item is-selected"
                : "vaultdav-log-run-item";
            const itemBtn: HTMLButtonElement = this.runListEl.createEl(
                "button",
                {
                    cls: rowCls
                }
            );
            itemBtn.type = "button";
            itemBtn.setAttribute("aria-pressed", isSelected ? "true" : "false");
            itemBtn.title = `${formatTimestamp(run.finishedAt)} · ${formatDuration(run.durationMs)} · ${run.trigger}`;
            const runId: string = run.id;
            itemBtn.addEventListener("click", (): void => {
                this.handleSelectRun(runId);
            });
            this.runButtonMap.set(runId, itemBtn);

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
                text: formatTimeOfDay(run.finishedAt)
            });

            const bottomRow: HTMLElement = itemBtn.createDiv({
                cls: "vaultdav-log-run-summary"
            });
            bottomRow.createSpan({
                text: getCompactRunSummaryText(run)
            });
        }

        if (this.filteredRunsCache.length > visibleCount) {
            const remaining: number =
                this.filteredRunsCache.length - visibleCount;
            const pager: HTMLElement = this.runFooterEl.createDiv({
                cls: "vaultdav-log-pagination"
            });
            pager.createSpan({
                cls: "vaultdav-log-meta",
                text: `Showing ${visibleCount} of ${this.filteredRunsCache.length} runs`
            });
            const moreBtn: HTMLButtonElement = pager.createEl("button", {
                cls: "vaultdav-log-mini-btn",
                text: `Show more (${remaining} remaining)`
            });
            moreBtn.type = "button";
            moreBtn.addEventListener("click", (): void => {
                this.visibleRunLimit += RUN_PAGE_SIZE;
                this.renderRunList(true);
            });
        }

        this.runListEl.scrollTop = prevScrollTop;
    }

    private renderToolbar(): void {
        if (this.toolbarEl === null) {
            return;
        }
        clearElement(this.toolbarEl);
        const toolbar: HTMLElement = this.toolbarEl;
        const hasHistory: boolean = this.runsCache.length > 0;

        const syncBtn: HTMLButtonElement = toolbar.createEl("button", {
            cls: "mod-cta",
            text: this.plugin.isSyncing ? "Syncing..." : "Synchronize now"
        });
        syncBtn.type = "button";
        syncBtn.disabled = this.plugin.isSyncing;
        syncBtn.addEventListener("click", (): void => {
            void this.handleTriggerSync();
        });

        const refreshBtn: HTMLButtonElement = toolbar.createEl("button", {
            text: "Refresh"
        });
        refreshBtn.type = "button";
        refreshBtn.addEventListener("click", (): void => {
            this.render();
        });

        if (hasHistory) {
            if (this.confirmingClear) {
                const confirmBtn: HTMLButtonElement = toolbar.createEl(
                    "button",
                    {
                        cls: "mod-warning",
                        text: this.isClearingHistory
                            ? "Clearing..."
                            : "Confirm clear"
                    }
                );
                confirmBtn.type = "button";
                confirmBtn.disabled = this.isClearingHistory;
                confirmBtn.addEventListener("click", (): void => {
                    void this.handleClearHistory();
                });

                const cancelBtn: HTMLButtonElement = toolbar.createEl(
                    "button",
                    {
                        text: "Cancel"
                    }
                );
                cancelBtn.type = "button";
                cancelBtn.disabled = this.isClearingHistory;
                cancelBtn.addEventListener("click", (): void => {
                    if (this.isClearingHistory) {
                        return;
                    }
                    this.confirmingClear = false;
                    this.renderToolbar();
                });
            } else {
                const clearBtn: HTMLButtonElement = toolbar.createEl("button", {
                    text: "Clear history"
                });
                clearBtn.type = "button";
                clearBtn.disabled = this.isClearingHistory;
                clearBtn.addEventListener("click", (): void => {
                    this.confirmingClear = true;
                    this.renderToolbar();
                });
            }
        }
    }

    private resolveVaultFile(normalized: string): TFile | null {
        const configDir: string = this.getConfigDir();
        if (util.isExcludedPath(normalized, configDir)) {
            return null;
        }
        let candidate: TAbstractFile | null = null;
        if (typeof this.app.vault.getFileByPath === "function") {
            candidate = this.app.vault.getFileByPath(normalized);
        } else if (
            typeof this.app.vault.getAbstractFileByPath === "function"
        ) {
            candidate = this.app.vault.getAbstractFileByPath(normalized);
        } else {
            return null;
        }
        if (!isVaultFileHandle(candidate)) {
            return null;
        }
        const candidateNormalized: string = util.normalizeVaultPath(
            candidate.path
        );
        if (
            candidateNormalized === "" ||
            candidateNormalized !== normalized ||
            util.isExcludedPath(candidateNormalized, configDir)
        ) {
            return null;
        }
        return candidate;
    }

    private updateRunListView(resetScroll: boolean): void {
        const queryLower: string = this.runSearchQuery.trim().toLowerCase();
        this.filteredRunsCache = this.runsCache.filter(
            (run: SyncRunRecord): boolean =>
                matchesRunFilter(run, this.activeRunFilter, queryLower)
        );

        const prevSelectedId: string | null = this.selectedRunId;
        if (this.filteredRunsCache.length === 0) {
            this.selectedRunId = null;
        } else if (resetScroll) {
            const visibleSlice: SyncRunRecord[] = this.filteredRunsCache.slice(
                0,
                this.visibleRunLimit
            );
            const stillVisible: boolean =
                this.selectedRunId !== null &&
                visibleSlice.some(
                    (run: SyncRunRecord) => run.id === this.selectedRunId
                );
            if (!stillVisible) {
                this.selectedRunId = this.filteredRunsCache[0]?.id ?? null;
            }
        } else {
            const matched: SyncRunRecord | null = this.getSelectedRun(
                this.filteredRunsCache
            );
            this.selectedRunId = matched?.id ?? null;
        }

        if (this.selectedRunId !== prevSelectedId) {
            this.activeEventFilter = "all";
            this.eventSearchQuery = "";
            this.visibleEventLimit = EVENT_PAGE_SIZE;
        }

        this.renderRunFilterBar();
        this.renderRunList(!resetScroll);
        this.renderRunDetails();
    }
}
