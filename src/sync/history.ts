import type { DataAdapter, Stat } from "obsidian";
import { log, redactSensitiveText } from "../log";
import type {
    ConflictResolutionMode,
    SyncEventKind,
    SyncHistoryData,
    SyncLogEvent,
    SyncRunRecord,
    SyncRunStatus,
    SyncRunSummary,
    SyncRunTrigger
} from "../types";
import { util } from "../utilities";

export const CURRENT_HISTORY_VERSION: number = 1;
export const DEFAULT_HISTORY_RETENTION_DAYS: number = 30;
export const MAX_EVENT_MESSAGE_LENGTH: number = 500;
export const MAX_EVENTS_PER_RUN: number = 500;
export const MAX_HISTORY_BYTES: number = 1024 * 1024;
export const MAX_HISTORY_FILE_BYTES: number = MAX_HISTORY_BYTES * 4;
export const MAX_HISTORY_RETENTION_DAYS: number = 365;
export const MAX_HISTORY_RUNS: number = 100;
export const MIN_HISTORY_RETENTION_DAYS: number = 1;

const EVENT_PRIORITY_MAP: ReadonlyMap<SyncEventKind, number> = new Map<
    SyncEventKind,
    number
>([
    ["conflict", 1],
    ["create_local_dir", 5],
    ["create_remote_dir", 5],
    ["delete_local", 3],
    ["delete_remote", 3],
    ["download", 4],
    ["error", 1],
    ["upload", 4],
    ["warning", 2]
]);
const FORBIDDEN_HISTORY_SEGMENTS_LOWER: ReadonlySet<string> = new Set<string>([
    ".ds_store",
    ".git",
    ".svn",
    ".trash",
    "desktop.ini",
    "node_modules",
    "thumbs.db"
]);
const MAX_EVENT_PRIORITY: number = 5;
const MAX_RAW_EVENT_MESSAGE_LENGTH: number = 16_384;
const MAX_SAFE_TIMESTAMP_MS: number = 8_640_000_000_000_000;
const MS_PER_DAY: number = 86_400_000;
const TEXT_ENCODER: TextEncoder = new TextEncoder();
const HISTORY_ENVELOPE_BYTES: number = TEXT_ENCODER.encode(
    JSON.stringify({
        runs: [],
        version: CURRENT_HISTORY_VERSION
    })
).byteLength;
const VALID_EVENT_KINDS: ReadonlySet<string> = new Set<SyncEventKind>([
    "conflict",
    "create_local_dir",
    "create_remote_dir",
    "delete_local",
    "delete_remote",
    "download",
    "error",
    "upload",
    "warning"
]);
const VALID_RESOLUTIONS: ReadonlySet<string> = new Set<ConflictResolutionMode>([
    "identical",
    "keep_both",
    "newest_wins_local",
    "newest_wins_remote"
]);
const VALID_RUN_STATUSES: ReadonlySet<string> = new Set<SyncRunStatus>([
    "failed",
    "partial",
    "success"
]);
const VALID_RUN_TRIGGERS: ReadonlySet<string> = new Set<SyncRunTrigger>([
    "auto",
    "manual"
]);
const WHITESPACE_CHAR_REGEX: RegExp = /\s/;

export function capRunEvents(
    events: ReadonlyArray<SyncLogEvent>,
    maxEvents: number = MAX_EVENTS_PER_RUN
): { events: SyncLogEvent[]; omittedEvents: number } {
    const safeMax: number =
        Number.isFinite(maxEvents) && maxEvents >= 0
            ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(maxEvents))
            : MAX_EVENTS_PER_RUN;
    if (safeMax === 0) {
        return {
            events: [],
            omittedEvents: events.length
        };
    }
    if (events.length <= safeMax) {
        return {
            events: events.map((event: SyncLogEvent) => cloneLogEvent(event)),
            omittedEvents: 0
        };
    }
    const buckets: SyncLogEvent[][] = [[], [], [], [], []];
    for (const event of events) {
        const priority: number = getEventPriority(event.kind);
        const bucket: SyncLogEvent[] | undefined = buckets[priority - 1];
        if (bucket !== undefined && bucket.length < safeMax) {
            bucket.push(cloneLogEvent(event));
        }
    }
    const kept: SyncLogEvent[] = drainPriorityBuckets(buckets, safeMax);
    return {
        events: kept,
        omittedEvents: events.length - kept.length
    };
}

function clampSafeNonNegativeAdd(a: number, b: number): number {
    const safeA: number =
        Number.isFinite(a) && a > 0
            ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(a))
            : 0;
    const safeB: number =
        Number.isFinite(b) && b > 0
            ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(b))
            : 0;
    if (safeA >= Number.MAX_SAFE_INTEGER - safeB) {
        return Number.MAX_SAFE_INTEGER;
    }
    return safeA + safeB;
}

function cloneLogEvent(event: SyncLogEvent): SyncLogEvent {
    const copy: SyncLogEvent = {
        kind: event.kind
    };
    if (event.path !== undefined) {
        copy.path = event.path;
    }
    if (event.conflictCopyPath !== undefined) {
        copy.conflictCopyPath = event.conflictCopyPath;
    }
    if (event.isDirectory !== undefined) {
        copy.isDirectory = event.isDirectory;
    }
    if (event.message !== undefined) {
        copy.message = event.message;
    }
    if (event.resolution !== undefined) {
        copy.resolution = event.resolution;
    }
    if (event.size !== undefined) {
        copy.size = event.size;
    }
    return copy;
}

function cloneRunRecord(run: SyncRunRecord): SyncRunRecord {
    const copy: SyncRunRecord = {
        collapsedCount: run.collapsedCount,
        detailsPruned: run.detailsPruned,
        durationMs: run.durationMs,
        events: run.events.map((event: SyncLogEvent) => cloneLogEvent(event)),
        finishedAt: run.finishedAt,
        id: run.id,
        omittedEvents: run.omittedEvents,
        startedAt: run.startedAt,
        status: run.status,
        summary: cloneRunSummary(run.summary),
        trigger: run.trigger
    };
    if (run.firstCollapsedAt !== undefined) {
        copy.firstCollapsedAt = run.firstCollapsedAt;
    }
    return copy;
}

function cloneRunSummary(summary: SyncRunSummary): SyncRunSummary {
    return {
        conflictsIdentical: summary.conflictsIdentical,
        conflictsKeepBoth: summary.conflictsKeepBoth,
        conflictsNewestWins: summary.conflictsNewestWins,
        conflictsResolved: summary.conflictsResolved,
        deletedLocal: summary.deletedLocal,
        deletedLocalDirs: summary.deletedLocalDirs,
        deletedRemote: summary.deletedRemote,
        deletedRemoteDirs: summary.deletedRemoteDirs,
        dirsCreatedLocal: summary.dirsCreatedLocal,
        dirsCreatedRemote: summary.dirsCreatedRemote,
        downloaded: summary.downloaded,
        errors: summary.errors,
        uploaded: summary.uploaded,
        warnings: summary.warnings
    };
}

export function createEmptyRunSummary(): SyncRunSummary {
    return {
        conflictsIdentical: 0,
        conflictsKeepBoth: 0,
        conflictsNewestWins: 0,
        conflictsResolved: 0,
        deletedLocal: 0,
        deletedLocalDirs: 0,
        deletedRemote: 0,
        deletedRemoteDirs: 0,
        dirsCreatedLocal: 0,
        dirsCreatedRemote: 0,
        downloaded: 0,
        errors: 0,
        uploaded: 0,
        warnings: 0
    };
}

function drainPriorityBuckets(
    buckets: ReadonlyArray<ReadonlyArray<SyncLogEvent>>,
    maxCount: number
): SyncLogEvent[] {
    const kept: SyncLogEvent[] = [];
    for (const bucket of buckets) {
        const remaining: number = maxCount - kept.length;
        if (remaining <= 0) {
            break;
        }
        if (bucket.length <= remaining) {
            for (const item of bucket) {
                kept.push(item);
            }
        } else {
            for (let i: number = 0; i < remaining; i += 1) {
                const item: SyncLogEvent | undefined = bucket[i];
                if (item !== undefined) {
                    kept.push(item);
                }
            }
            break;
        }
    }
    return kept;
}

function getEventPriority(kind: unknown): number {
    if (typeof kind !== "string") {
        return MAX_EVENT_PRIORITY;
    }
    return EVENT_PRIORITY_MAP.get(kind as SyncEventKind) ?? MAX_EVENT_PRIORITY;
}

export function isCriticalRun(run: SyncRunRecord): boolean {
    return (
        run.status !== "success" ||
        run.summary.conflictsResolved > 0 ||
        run.summary.errors > 0 ||
        run.summary.warnings > 0
    );
}

export function isNoopRun(run: SyncRunRecord): boolean {
    const s: SyncRunSummary = run.summary;
    return (
        run.status === "success" &&
        s.uploaded === 0 &&
        s.downloaded === 0 &&
        s.conflictsResolved === 0 &&
        s.deletedLocal === 0 &&
        s.deletedLocalDirs === 0 &&
        s.deletedRemote === 0 &&
        s.deletedRemoteDirs === 0 &&
        s.dirsCreatedLocal === 0 &&
        s.dirsCreatedRemote === 0 &&
        s.errors === 0 &&
        s.warnings === 0 &&
        run.events.length === 0 &&
        run.omittedEvents === 0
    );
}

function measureRunBytes(run: SyncRunRecord): number {
    return TEXT_ENCODER.encode(JSON.stringify(run)).byteLength;
}

function measureRunsTotalBytes(runBytes: ReadonlyArray<number>): number {
    if (runBytes.length === 0) {
        return HISTORY_ENVELOPE_BYTES;
    }
    let total: number = HISTORY_ENVELOPE_BYTES + runBytes.length - 1;
    for (let i: number = 0; i < runBytes.length; i += 1) {
        total += runBytes[i] ?? 0;
    }
    return total;
}

export function pruneHistoryRuns(
    runs: ReadonlyArray<SyncRunRecord>,
    now: number,
    retentionDays: number = DEFAULT_HISTORY_RETENTION_DAYS,
    maxRuns: number = MAX_HISTORY_RUNS,
    maxBytes: number = MAX_HISTORY_BYTES
): SyncRunRecord[] {
    const safeNow: number =
        Number.isFinite(now) && now > 0 && now <= MAX_SAFE_TIMESTAMP_MS
            ? Math.floor(now)
            : 0;
    const safeRetentionDays: number = sanitizeRetentionDays(retentionDays);
    const safeMaxRuns: number =
        Number.isFinite(maxRuns) && maxRuns >= 1
            ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(maxRuns))
            : MAX_HISTORY_RUNS;
    const safeMaxBytes: number =
        Number.isFinite(maxBytes) && maxBytes >= 1024
            ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(maxBytes))
            : MAX_HISTORY_BYTES;
    const cutoffMs: number =
        safeNow > 0 ? Math.max(0, safeNow - safeRetentionDays * MS_PER_DAY) : 0;

    let working: SyncRunRecord[] = [];
    for (const run of runs) {
        const cloned: SyncRunRecord = cloneRunRecord(run);
        if (cutoffMs > 0 && cloned.finishedAt > 0 && cloned.finishedAt < cutoffMs) {
            continue;
        }
        working.push(cloned);
    }

    working.sort((a: SyncRunRecord, b: SyncRunRecord): number => {
        const aFin: number = Number.isFinite(a.finishedAt) ? a.finishedAt : 0;
        const bFin: number = Number.isFinite(b.finishedAt) ? b.finishedAt : 0;
        if (bFin !== aFin) {
            return bFin - aFin;
        }
        const aStart: number = Number.isFinite(a.startedAt) ? a.startedAt : 0;
        const bStart: number = Number.isFinite(b.startedAt) ? b.startedAt : 0;
        return bStart - aStart;
    });

    if (working.length > safeMaxRuns) {
        let toEvict: number = working.length - safeMaxRuns;
        const evicted: Uint8Array = new Uint8Array(working.length);
        for (
            let i: number = working.length - 1;
            i >= 0 && toEvict > 0;
            i -= 1
        ) {
            const candidate: SyncRunRecord | undefined = working[i];
            if (candidate !== undefined && !isCriticalRun(candidate)) {
                evicted[i] = 1;
                toEvict -= 1;
            }
        }
        for (
            let i: number = working.length - 1;
            i >= 0 && toEvict > 0;
            i -= 1
        ) {
            if (evicted[i] === 0) {
                evicted[i] = 1;
                toEvict -= 1;
            }
        }
        const retained: SyncRunRecord[] = [];
        for (let i: number = 0; i < working.length; i += 1) {
            const run: SyncRunRecord | undefined = working[i];
            if (evicted[i] === 0 && run !== undefined) {
                retained.push(run);
            }
        }
        working = retained;
    }

    if (working.length === 0) {
        return working;
    }

    const runBytes: number[] = working.map((run: SyncRunRecord) =>
        measureRunBytes(run)
    );
    let totalBytes: number = measureRunsTotalBytes(runBytes);
    if (totalBytes <= safeMaxBytes) {
        return working;
    }

    // Phase A1: compact oldest non-critical runs (keep summary totals, drop events)
    for (let i: number = working.length - 1; i >= 1; i -= 1) {
        const run: SyncRunRecord | undefined = working[i];
        if (run !== undefined && !isCriticalRun(run) && run.events.length > 0) {
            const oldBytes: number = runBytes[i] ?? 0;
            run.omittedEvents = clampSafeNonNegativeAdd(
                run.omittedEvents,
                run.events.length
            );
            run.events = [];
            run.detailsPruned = true;
            const newBytes: number = measureRunBytes(run);
            runBytes[i] = newBytes;
            totalBytes += newBytes - oldBytes;
            if (totalBytes <= safeMaxBytes) {
                return working;
            }
        }
    }

    // Phase A2: compact oldest critical runs except latest run
    for (let i: number = working.length - 1; i >= 1; i -= 1) {
        const run: SyncRunRecord | undefined = working[i];
        if (run !== undefined && run.events.length > 0) {
            const oldBytes: number = runBytes[i] ?? 0;
            run.omittedEvents = clampSafeNonNegativeAdd(
                run.omittedEvents,
                run.events.length
            );
            run.events = [];
            run.detailsPruned = true;
            const newBytes: number = measureRunBytes(run);
            runBytes[i] = newBytes;
            totalBytes += newBytes - oldBytes;
            if (totalBytes <= safeMaxBytes) {
                return working;
            }
        }
    }

    // Phase B: evict oldest runs while preserving the most recent run
    if (working.length > 1 && totalBytes > safeMaxBytes) {
        const evicted: Uint8Array = new Uint8Array(working.length);
        for (
            let i: number = working.length - 1;
            i >= 1 && totalBytes > safeMaxBytes;
            i -= 1
        ) {
            const candidate: SyncRunRecord | undefined = working[i];
            if (candidate !== undefined && !isCriticalRun(candidate)) {
                evicted[i] = 1;
                totalBytes -= (runBytes[i] ?? 0) + 1;
            }
        }
        for (
            let i: number = working.length - 1;
            i >= 1 && totalBytes > safeMaxBytes;
            i -= 1
        ) {
            if (evicted[i] === 0) {
                evicted[i] = 1;
                totalBytes -= (runBytes[i] ?? 0) + 1;
            }
        }
        const retained: SyncRunRecord[] = [];
        for (let i: number = 0; i < working.length; i += 1) {
            const run: SyncRunRecord | undefined = working[i];
            if (evicted[i] === 0 && run !== undefined) {
                retained.push(run);
            }
        }
        working = retained;
    }

    // Phase C: if the latest run alone still exceeds maxBytes, trim its lower-priority events
    const latest: SyncRunRecord | undefined = working[0];
    if (latest !== undefined && totalBytes > safeMaxBytes) {
        latest.events = sortEventsByPriority(latest.events);
        totalBytes = HISTORY_ENVELOPE_BYTES + measureRunBytes(latest);
        while (latest.events.length > 0 && totalBytes > safeMaxBytes) {
            const dropCount: number = Math.max(
                1,
                Math.floor(latest.events.length / 2)
            );
            latest.events.splice(latest.events.length - dropCount, dropCount);
            latest.omittedEvents = clampSafeNonNegativeAdd(
                latest.omittedEvents,
                dropCount
            );
            if (latest.events.length === 0) {
                latest.detailsPruned = true;
            }
            totalBytes = HISTORY_ENVELOPE_BYTES + measureRunBytes(latest);
        }
    }

    return working;
}

function redactTruncatedUrlAuthority(text: string): string {
    const lastSchemeSep: number = text.lastIndexOf("://");
    if (lastSchemeSep === -1) {
        return text;
    }
    const authorityStart: number = lastSchemeSep + 3;
    for (let i: number = authorityStart; i < text.length; i += 1) {
        const code: number = text.charCodeAt(i);
        if (
            code === 47 ||
            code === 63 ||
            code === 35 ||
            code === 32 ||
            (code >= 9 && code <= 13) ||
            (code >= 128 && WHITESPACE_CHAR_REGEX.test(text.charAt(i)))
        ) {
            return text;
        }
    }
    return `${text.slice(0, authorityStart)}[REDACTED]`;
}

function resolveHistoryFilePath(
    historyFilePath: string,
    rawConfigDir: string
): string {
    const normalized: string = util.normalizeVaultPath(historyFilePath);
    if (normalized === "") {
        throw new Error(`Invalid sync history file path: ${historyFilePath}`);
    }
    const lower: string = normalized.toLowerCase();
    const expectedSuffix: string = `/${util.SYNC_HISTORY_RELATIVE_PATH}`;

    if (rawConfigDir !== "") {
        const normalizedConfigDir: string = util.normalizeVaultPath(rawConfigDir);
        if (normalizedConfigDir === "") {
            throw new Error(
                `Invalid sync history file path: ${historyFilePath}`
            );
        }
        const configSegments: string[] = normalizedConfigDir
            .toLowerCase()
            .split("/");
        for (const segment of configSegments) {
            if (FORBIDDEN_HISTORY_SEGMENTS_LOWER.has(segment)) {
                throw new Error(
                    `Invalid sync history file path: ${historyFilePath}`
                );
            }
        }
        const expectedPathLower: string = util
            .getSyncHistoryFilePath(normalizedConfigDir)
            .toLowerCase();
        if (
            lower !== expectedPathLower ||
            !util.isExcludedPath(normalized, normalizedConfigDir)
        ) {
            throw new Error(
                `Invalid sync history file path: ${historyFilePath}`
            );
        }
        return normalized;
    }

    if (!lower.endsWith(expectedSuffix)) {
        throw new Error(`Invalid sync history file path: ${historyFilePath}`);
    }
    const prefixLower: string = lower.slice(
        0,
        lower.length - expectedSuffix.length
    );
    if (
        prefixLower === "" ||
        !prefixLower.startsWith(".") ||
        prefixLower.includes("/") ||
        FORBIDDEN_HISTORY_SEGMENTS_LOWER.has(prefixLower) ||
        !util.isExcludedPath(normalized, "")
    ) {
        throw new Error(`Invalid sync history file path: ${historyFilePath}`);
    }
    return normalized;
}

function sanitizeEventMessage(raw: unknown): string | undefined {
    if (typeof raw !== "string") {
        return undefined;
    }
    const wasBounded: boolean = raw.length > MAX_RAW_EVENT_MESSAGE_LENGTH;
    const boundedRaw: string = wasBounded
        ? raw.slice(0, MAX_RAW_EVENT_MESSAGE_LENGTH)
        : raw;
    let redacted: string = redactSensitiveText(boundedRaw);
    if (wasBounded) {
        redacted = redactTruncatedUrlAuthority(redacted);
    }
    const trimmed: string = redacted.trim();
    if (trimmed === "") {
        return undefined;
    }
    if (trimmed.length > MAX_EVENT_MESSAGE_LENGTH) {
        return `${trimmed.slice(0, MAX_EVENT_MESSAGE_LENGTH - 3)}...`;
    }
    return trimmed;
}

function sanitizeLogEvent(raw: unknown): SyncLogEvent | null {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return null;
    }
    const record: Record<string, unknown> = raw as Record<string, unknown>;
    if (typeof record.kind !== "string" || !VALID_EVENT_KINDS.has(record.kind)) {
        return null;
    }
    const event: SyncLogEvent = {
        kind: record.kind as SyncEventKind
    };
    if (typeof record.path === "string") {
        const normPath: string = util.normalizeVaultPath(record.path);
        if (normPath !== "") {
            event.path = normPath;
        }
    }
    if (typeof record.conflictCopyPath === "string") {
        const normConflictPath: string = util.normalizeVaultPath(
            record.conflictCopyPath
        );
        if (normConflictPath !== "") {
            event.conflictCopyPath = normConflictPath;
        }
    }
    if (typeof record.isDirectory === "boolean") {
        event.isDirectory = record.isDirectory;
    }
    const safeMessage: string | undefined = sanitizeEventMessage(record.message);
    if (safeMessage !== undefined) {
        event.message = safeMessage;
    }
    if (
        typeof record.resolution === "string" &&
        VALID_RESOLUTIONS.has(record.resolution)
    ) {
        event.resolution = record.resolution as ConflictResolutionMode;
    }
    if (
        typeof record.size === "number" &&
        Number.isFinite(record.size) &&
        record.size >= 0 &&
        record.size <= Number.MAX_SAFE_INTEGER
    ) {
        event.size = Math.floor(record.size);
    }
    return event;
}

function sanitizeNonNegativeInt(value: unknown, fallback: number = 0): number {
    if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < 0 ||
        value > Number.MAX_SAFE_INTEGER
    ) {
        return fallback;
    }
    return Math.floor(value);
}

function sanitizePositiveTimestamp(value: unknown): number {
    if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value <= 0 ||
        value > MAX_SAFE_TIMESTAMP_MS
    ) {
        return 0;
    }
    return Math.floor(value);
}

function sanitizeRetentionDays(value: unknown): number {
    if (
        typeof value === "number" &&
        Number.isFinite(value) &&
        value >= MIN_HISTORY_RETENTION_DAYS
    ) {
        return Math.min(MAX_HISTORY_RETENTION_DAYS, Math.floor(value));
    }
    return DEFAULT_HISTORY_RETENTION_DAYS;
}

function sanitizeRunRecord(raw: unknown): SyncRunRecord | null {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return null;
    }
    const candidate: Record<string, unknown> = raw as Record<string, unknown>;
    const rawId: string =
        typeof candidate.id === "string" ? candidate.id.trim() : "";
    const startedAt: number = sanitizePositiveTimestamp(candidate.startedAt);
    const finishedAt: number = sanitizePositiveTimestamp(candidate.finishedAt);
    if (rawId === "" || util.hasControlChars(rawId) || finishedAt === 0) {
        return null;
    }
    const safeStartedAt: number = startedAt > 0 ? startedAt : finishedAt;
    const status: SyncRunStatus =
        typeof candidate.status === "string" &&
        VALID_RUN_STATUSES.has(candidate.status)
            ? (candidate.status as SyncRunStatus)
            : "success";
    const trigger: SyncRunTrigger =
        typeof candidate.trigger === "string" &&
        VALID_RUN_TRIGGERS.has(candidate.trigger)
            ? (candidate.trigger as SyncRunTrigger)
            : "manual";
    const summary: SyncRunSummary = sanitizeRunSummary(candidate.summary);
    const rawEvents: unknown[] = Array.isArray(candidate.events)
        ? candidate.events
        : [];
    let orderedEvents: SyncLogEvent[] = [];
    let buckets: SyncLogEvent[][] | null = null;
    let validEventCount: number = 0;

    for (const item of rawEvents) {
        if (typeof item !== "object" || item === null || Array.isArray(item)) {
            continue;
        }
        const rawKind: unknown = (item as Record<string, unknown>).kind;
        if (typeof rawKind !== "string" || !VALID_EVENT_KINDS.has(rawKind)) {
            continue;
        }
        validEventCount += 1;
        if (buckets === null) {
            if (validEventCount <= MAX_EVENTS_PER_RUN) {
                const sanitizedEvent: SyncLogEvent | null =
                    sanitizeLogEvent(item);
                if (sanitizedEvent !== null) {
                    orderedEvents.push(sanitizedEvent);
                }
                continue;
            }
            buckets = [[], [], [], [], []];
            for (const existing of orderedEvents) {
                const existingBucket: SyncLogEvent[] | undefined =
                    buckets[getEventPriority(existing.kind) - 1];
                if (
                    existingBucket !== undefined &&
                    existingBucket.length < MAX_EVENTS_PER_RUN
                ) {
                    existingBucket.push(existing);
                }
            }
            orderedEvents = [];
        }
        const priority: number = getEventPriority(rawKind);
        const targetBucket: SyncLogEvent[] | undefined = buckets[priority - 1];
        if (
            targetBucket !== undefined &&
            targetBucket.length < MAX_EVENTS_PER_RUN
        ) {
            const sanitizedEvent: SyncLogEvent | null = sanitizeLogEvent(item);
            if (sanitizedEvent !== null) {
                targetBucket.push(sanitizedEvent);
            }
        }
    }

    const keptEvents: SyncLogEvent[] =
        buckets === null
            ? orderedEvents
            : drainPriorityBuckets(buckets, MAX_EVENTS_PER_RUN);
    const newlyOmitted: number = Math.max(
        0,
        validEventCount - keptEvents.length
    );
    const existingOmitted: number = sanitizeNonNegativeInt(
        candidate.omittedEvents,
        0
    );
    const collapsedCount: number = Math.max(
        1,
        sanitizeNonNegativeInt(candidate.collapsedCount, 1)
    );
    const durationMs: number = sanitizeNonNegativeInt(
        candidate.durationMs,
        Math.max(0, finishedAt - safeStartedAt)
    );
    const run: SyncRunRecord = {
        collapsedCount,
        detailsPruned: Boolean(candidate.detailsPruned),
        durationMs,
        events: keptEvents,
        finishedAt,
        id: rawId.slice(0, 64),
        omittedEvents: clampSafeNonNegativeAdd(existingOmitted, newlyOmitted),
        startedAt: safeStartedAt,
        status,
        summary,
        trigger
    };
    const firstCollapsedAt: number = sanitizePositiveTimestamp(
        candidate.firstCollapsedAt
    );
    if (collapsedCount > 1 && firstCollapsedAt > 0) {
        run.firstCollapsedAt = firstCollapsedAt;
    }
    return run;
}

function sanitizeRunSummary(raw: unknown): SyncRunSummary {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return createEmptyRunSummary();
    }
    const candidate: Record<string, unknown> = raw as Record<string, unknown>;
    return {
        conflictsIdentical: sanitizeNonNegativeInt(candidate.conflictsIdentical),
        conflictsKeepBoth: sanitizeNonNegativeInt(candidate.conflictsKeepBoth),
        conflictsNewestWins: sanitizeNonNegativeInt(candidate.conflictsNewestWins),
        conflictsResolved: sanitizeNonNegativeInt(candidate.conflictsResolved),
        deletedLocal: sanitizeNonNegativeInt(candidate.deletedLocal),
        deletedLocalDirs: sanitizeNonNegativeInt(candidate.deletedLocalDirs),
        deletedRemote: sanitizeNonNegativeInt(candidate.deletedRemote),
        deletedRemoteDirs: sanitizeNonNegativeInt(candidate.deletedRemoteDirs),
        dirsCreatedLocal: sanitizeNonNegativeInt(candidate.dirsCreatedLocal),
        dirsCreatedRemote: sanitizeNonNegativeInt(candidate.dirsCreatedRemote),
        downloaded: sanitizeNonNegativeInt(candidate.downloaded),
        errors: sanitizeNonNegativeInt(candidate.errors),
        uploaded: sanitizeNonNegativeInt(candidate.uploaded),
        warnings: sanitizeNonNegativeInt(candidate.warnings)
    };
}

function sortEventsByPriority(
    events: ReadonlyArray<SyncLogEvent>
): SyncLogEvent[] {
    const buckets: SyncLogEvent[][] = [[], [], [], [], []];
    for (const event of events) {
        const priority: number = getEventPriority(event.kind);
        const bucket: SyncLogEvent[] | undefined = buckets[priority - 1];
        if (bucket !== undefined) {
            bucket.push(cloneLogEvent(event));
        }
    }
    return drainPriorityBuckets(buckets, events.length);
}

function stripNullPadding(raw: string): string {
    let start: number = 0;
    let end: number = raw.length;
    while (start < end && raw.charCodeAt(start) === 0) {
        start += 1;
    }
    while (end > start && raw.charCodeAt(end - 1) === 0) {
        end -= 1;
    }
    if (start === 0 && end === raw.length) {
        return raw;
    }
    return raw.slice(start, end);
}

export class SyncHistoryStore {
    private readonly adapter: DataAdapter;
    private ensureParentDirPromise: Promise<void> | null = null;
    private readonly historyFilePath: string;
    private isLoaded: boolean = false;
    private isParentDirEnsured: boolean = false;
    private operationPromise: Promise<void> = Promise.resolve();
    private runs: SyncRunRecord[] = [];

    public constructor(
        adapter: DataAdapter,
        historyFilePath: string,
        configDir: string = ""
    ) {
        this.adapter = adapter;
        this.historyFilePath = resolveHistoryFilePath(
            historyFilePath,
            configDir
        );
    }

    public clear(): Promise<void> {
        return this.enqueueOperation(async (): Promise<void> => {
            this.runs = [];
            this.isLoaded = true;
            await this.writeSnapshotInternal([]);
        });
    }

    private enqueueOperation<T>(task: () => Promise<T>): Promise<T> {
        const nextPromise: Promise<T> = this.operationPromise.then(task, task);
        this.operationPromise = nextPromise.then(
            () => undefined,
            () => undefined
        );
        return nextPromise;
    }

    public async ensureParentDirectory(): Promise<void> {
        if (this.isParentDirEnsured === true) {
            return;
        }
        if (this.ensureParentDirPromise !== null) {
            await this.ensureParentDirPromise;
            return;
        }
        const task = async (): Promise<void> => {
            const levels: string[] = util.getFolderLevels(
                this.historyFilePath,
                false
            );
            for (const folder of levels) {
                const exists: boolean = await this.adapter.exists(folder);
                if (!exists) {
                    await this.adapter.mkdir(folder);
                }
            }
            this.isParentDirEnsured = true;
        };
        const promise: Promise<void> = task();
        this.ensureParentDirPromise = promise;
        try {
            await promise;
        } finally {
            if (this.ensureParentDirPromise === promise) {
                this.ensureParentDirPromise = null;
            }
        }
    }

    public getRuns(): SyncRunRecord[] {
        return this.runs.map((run: SyncRunRecord) => cloneRunRecord(run));
    }

    public load(
        retentionDays: number = DEFAULT_HISTORY_RETENTION_DAYS,
        now: number = Date.now()
    ): Promise<SyncHistoryData> {
        return this.enqueueOperation((): Promise<SyncHistoryData> =>
            this.loadInternal(retentionDays, now)
        );
    }

    private async loadInternal(
        retentionDays: number,
        now: number
    ): Promise<SyncHistoryData> {
        const exists: boolean = await this.adapter.exists(this.historyFilePath);
        if (!exists) {
            this.runs = [];
            this.isLoaded = true;
            return {
                runs: [],
                version: CURRENT_HISTORY_VERSION
            };
        }

        if (typeof this.adapter.stat === "function") {
            const fileStat: Stat | null = await this.adapter.stat(
                this.historyFilePath
            );
            if (
                fileStat !== null &&
                Number.isFinite(fileStat.size) &&
                fileStat.size > MAX_HISTORY_FILE_BYTES
            ) {
                log.warn(
                    "Sync history file exceeds maximum allowed size; resetting history."
                );
                this.runs = [];
                this.isLoaded = true;
                return {
                    runs: [],
                    version: CURRENT_HISTORY_VERSION
                };
            }
        }

        const raw: string = await this.adapter
            .read(this.historyFilePath)
            .catch((err: unknown): never => {
                log.error("Failed to read sync history file:", err);
                throw err;
            });

        if (raw.length > MAX_HISTORY_FILE_BYTES) {
            log.warn(
                "Sync history file exceeds maximum allowed size; resetting history."
            );
            this.runs = [];
            this.isLoaded = true;
            return {
                runs: [],
                version: CURRENT_HISTORY_VERSION
            };
        }

        try {
            const sanitizedRaw: string = stripNullPadding(raw).trim();
            const parsed: unknown = JSON.parse(sanitizedRaw);
            if (
                typeof parsed === "object" &&
                parsed !== null &&
                !Array.isArray(parsed) &&
                Object.prototype.hasOwnProperty.call(parsed, "runs")
            ) {
                const parsedRuns: unknown = (
                    parsed as Record<string, unknown>
                ).runs;
                if (Array.isArray(parsedRuns)) {
                    const validated: SyncRunRecord[] = [];
                    for (const item of parsedRuns) {
                        const run: SyncRunRecord | null = sanitizeRunRecord(item);
                        if (run !== null) {
                            validated.push(run);
                        }
                    }
                    this.runs = pruneHistoryRuns(validated, now, retentionDays);
                    this.isLoaded = true;
                    return {
                        runs: this.getRuns(),
                        version: CURRENT_HISTORY_VERSION
                    };
                }
            }
        } catch (err: unknown) {
            log.warn(
                "Failed to parse sync history file; resetting history.",
                err
            );
        }

        this.runs = [];
        this.isLoaded = true;
        return {
            runs: [],
            version: CURRENT_HISTORY_VERSION
        };
    }

    public recordRun(
        run: SyncRunRecord,
        retentionDays: number = DEFAULT_HISTORY_RETENTION_DAYS,
        now: number = Date.now()
    ): Promise<SyncRunRecord[]> {
        return this.enqueueOperation(async (): Promise<SyncRunRecord[]> => {
            if (!this.isLoaded) {
                await this.loadInternal(retentionDays, now);
            }
            const sanitized: SyncRunRecord | null = sanitizeRunRecord(run);
            if (sanitized === null) {
                return this.getRuns();
            }
            const latest: SyncRunRecord | undefined = this.runs[0];
            if (
                latest !== undefined &&
                isNoopRun(sanitized) &&
                isNoopRun(latest)
            ) {
                const folded: SyncRunRecord = {
                    ...cloneRunRecord(latest),
                    collapsedCount: clampSafeNonNegativeAdd(
                        latest.collapsedCount,
                        sanitized.collapsedCount
                    ),
                    durationMs: sanitized.durationMs,
                    finishedAt: Math.max(latest.finishedAt, sanitized.finishedAt),
                    firstCollapsedAt:
                        latest.firstCollapsedAt ??
                        Math.min(latest.startedAt, sanitized.startedAt),
                    id: sanitized.id,
                    startedAt: sanitized.startedAt,
                    trigger: sanitized.trigger
                };
                this.runs = [folded, ...this.runs.slice(1)];
            } else {
                this.runs = [sanitized, ...this.runs];
            }

            this.runs = pruneHistoryRuns(this.runs, now, retentionDays);
            const snapshot: SyncRunRecord[] = this.getRuns();
            await this.writeSnapshotInternal(snapshot);
            return snapshot;
        });
    }

    public save(): Promise<void> {
        return this.enqueueOperation((): Promise<void> =>
            this.writeSnapshotInternal(this.getRuns())
        );
    }

    private async writeSnapshotInternal(
        runsSnapshot: SyncRunRecord[]
    ): Promise<void> {
        await this.ensureParentDirectory();
        const payload: SyncHistoryData = {
            runs: runsSnapshot,
            version: CURRENT_HISTORY_VERSION
        };
        const serialized: string = JSON.stringify(payload);
        await this.adapter.write(this.historyFilePath, serialized);
    }
}
