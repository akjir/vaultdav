import type { DataAdapter } from "obsidian";
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
import { MAX_FILE_SIZE_BYTES, util } from "../utilities";

export const CURRENT_HISTORY_VERSION: number = 1;
export const DEFAULT_HISTORY_RETENTION_DAYS: number = 30;
export const MAX_EVENT_MESSAGE_LENGTH: number = 500;
export const MAX_EVENTS_PER_RUN: number = 500;
export const MAX_HISTORY_BYTES: number = 1024 * 1024;
export const MAX_HISTORY_RETENTION_DAYS: number = 365;
export const MAX_HISTORY_RUNS: number = 100;
export const MIN_HISTORY_RETENTION_DAYS: number = 1;

const EVENT_PRIORITY: Readonly<Record<SyncEventKind, number>> = Object.freeze({
    conflict: 1,
    create_local_dir: 5,
    create_remote_dir: 5,
    delete_local: 3,
    delete_remote: 3,
    download: 4,
    error: 1,
    upload: 4,
    warning: 2
});
const MAX_SAFE_TIMESTAMP_MS: number = 8_640_000_000_000_000;
const MS_PER_DAY: number = 86_400_000;
const TEXT_ENCODER: TextEncoder = new TextEncoder();
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

export function capRunEvents(
    events: ReadonlyArray<SyncLogEvent>,
    maxEvents: number = MAX_EVENTS_PER_RUN
): { events: SyncLogEvent[]; omittedEvents: number } {
    const safeMax: number =
        Number.isFinite(maxEvents) && maxEvents >= 0
            ? Math.floor(maxEvents)
            : MAX_EVENTS_PER_RUN;
    const sanitized: SyncLogEvent[] = events.map((event: SyncLogEvent) =>
        cloneLogEvent(event)
    );
    if (sanitized.length <= safeMax) {
        return {
            events: sanitized,
            omittedEvents: 0
        };
    }
    const indexed: Array<{ event: SyncLogEvent; index: number; priority: number }> =
        sanitized.map((event: SyncLogEvent, index: number) => ({
            event,
            index,
            priority: EVENT_PRIORITY[event.kind] ?? 5
        }));
    indexed.sort((a, b): number => {
        if (a.priority !== b.priority) {
            return a.priority - b.priority;
        }
        return a.index - b.index;
    });
    const kept: SyncLogEvent[] = indexed
        .slice(0, safeMax)
        .map((item) => item.event);
    return {
        events: kept,
        omittedEvents: sanitized.length - kept.length
    };
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
        summary: { ...run.summary },
        trigger: run.trigger
    };
    if (run.firstCollapsedAt !== undefined) {
        copy.firstCollapsedAt = run.firstCollapsedAt;
    }
    return copy;
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

function findOldestEvictableIndex(runs: ReadonlyArray<SyncRunRecord>): number {
    for (let i: number = runs.length - 1; i >= 0; i -= 1) {
        const candidate: SyncRunRecord | undefined = runs[i];
        if (candidate !== undefined && !isCriticalRun(candidate)) {
            return i;
        }
    }
    return runs.length - 1;
}

function findOldestEvictableIndexKeepingLatest(
    runs: ReadonlyArray<SyncRunRecord>
): number {
    for (let i: number = runs.length - 1; i >= 1; i -= 1) {
        const candidate: SyncRunRecord | undefined = runs[i];
        if (candidate !== undefined && !isCriticalRun(candidate)) {
            return i;
        }
    }
    return runs.length - 1;
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

function measureHistoryBytes(runs: SyncRunRecord[]): number {
    const payload: SyncHistoryData = {
        runs,
        version: CURRENT_HISTORY_VERSION
    };
    return TEXT_ENCODER.encode(JSON.stringify(payload)).byteLength;
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
            ? Math.floor(maxRuns)
            : MAX_HISTORY_RUNS;
    const safeMaxBytes: number =
        Number.isFinite(maxBytes) && maxBytes >= 1024
            ? Math.floor(maxBytes)
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
        if (b.finishedAt !== a.finishedAt) {
            return b.finishedAt - a.finishedAt;
        }
        return b.startedAt - a.startedAt;
    });

    while (working.length > safeMaxRuns) {
        const removeIndex: number = findOldestEvictableIndex(working);
        if (removeIndex < 0 || removeIndex >= working.length) {
            break;
        }
        working.splice(removeIndex, 1);
    }

    if (working.length === 0 || measureHistoryBytes(working) <= safeMaxBytes) {
        return working;
    }

    // Phase A1: compact oldest non-critical runs (keep summary totals, drop events)
    for (let i: number = working.length - 1; i >= 1; i -= 1) {
        const run: SyncRunRecord | undefined = working[i];
        if (run !== undefined && !isCriticalRun(run) && run.events.length > 0) {
            run.omittedEvents += run.events.length;
            run.events = [];
            run.detailsPruned = true;
            if (measureHistoryBytes(working) <= safeMaxBytes) {
                return working;
            }
        }
    }

    // Phase A2: compact oldest critical runs except latest run
    for (let i: number = working.length - 1; i >= 1; i -= 1) {
        const run: SyncRunRecord | undefined = working[i];
        if (run !== undefined && run.events.length > 0) {
            run.omittedEvents += run.events.length;
            run.events = [];
            run.detailsPruned = true;
            if (measureHistoryBytes(working) <= safeMaxBytes) {
                return working;
            }
        }
    }

    // Phase B: evict oldest runs while preserving the most recent run
    while (working.length > 1 && measureHistoryBytes(working) > safeMaxBytes) {
        const removeIndex: number = findOldestEvictableIndexKeepingLatest(working);
        if (removeIndex <= 0 || removeIndex >= working.length) {
            break;
        }
        working.splice(removeIndex, 1);
    }

    // Phase C: if the latest run alone still exceeds maxBytes, trim its lower-priority events
    const latest: SyncRunRecord | undefined = working[0];
    if (latest !== undefined && measureHistoryBytes(working) > safeMaxBytes) {
        const prioritized: { events: SyncLogEvent[]; omittedEvents: number } =
            capRunEvents(latest.events, latest.events.length);
        latest.events = prioritized.events;
        while (latest.events.length > 0 && measureHistoryBytes(working) > safeMaxBytes) {
            const dropCount: number = Math.max(1, Math.floor(latest.events.length / 2));
            latest.events.splice(latest.events.length - dropCount, dropCount);
            latest.omittedEvents += dropCount;
            if (latest.events.length === 0) {
                latest.detailsPruned = true;
            }
        }
    }

    return working;
}

function resolveHistoryFilePath(
    historyFilePath: string,
    configDir: string
): string {
    const normalized: string = util.normalizeVaultPath(historyFilePath);
    const lower: string = normalized.toLowerCase();
    if (
        normalized === "" ||
        lower.endsWith("/data.json") ||
        lower.endsWith("/sync-state.json") ||
        !util.isExcludedPath(normalized, configDir)
    ) {
        throw new Error(`Invalid sync history file path: ${historyFilePath}`);
    }
    return normalized;
}

function sanitizeEventMessage(raw: unknown): string | undefined {
    if (typeof raw !== "string") {
        return undefined;
    }
    const redacted: string = redactSensitiveText(raw).trim();
    if (redacted === "") {
        return undefined;
    }
    if (redacted.length > MAX_EVENT_MESSAGE_LENGTH) {
        return `${redacted.slice(0, MAX_EVENT_MESSAGE_LENGTH - 3)}...`;
    }
    return redacted;
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
        record.size >= 0
    ) {
        event.size = Math.floor(record.size);
    }
    return event;
}

function sanitizeNonNegativeInt(value: unknown, fallback: number = 0): number {
    if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < 0
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
    const validatedEvents: SyncLogEvent[] = [];
    for (const item of rawEvents) {
        const sanitizedEvent: SyncLogEvent | null = sanitizeLogEvent(item);
        if (sanitizedEvent !== null) {
            validatedEvents.push(sanitizedEvent);
        }
    }
    const capped: { events: SyncLogEvent[]; omittedEvents: number } =
        capRunEvents(validatedEvents, MAX_EVENTS_PER_RUN);
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
        events: capped.events,
        finishedAt,
        id: rawId.slice(0, 64),
        omittedEvents: existingOmitted + capped.omittedEvents,
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
    private readonly configDir: string;
    private ensureParentDirPromise: Promise<void> | null = null;
    private readonly historyFilePath: string;
    private isLoaded: boolean = false;
    private isParentDirEnsured: boolean = false;
    private runs: SyncRunRecord[] = [];
    private savePromise: Promise<void> = Promise.resolve();

    public constructor(
        adapter: DataAdapter,
        historyFilePath: string,
        configDir: string = ""
    ) {
        this.adapter = adapter;
        this.configDir =
            configDir !== "" ? util.normalizeVaultPath(configDir) : "";
        this.historyFilePath = resolveHistoryFilePath(
            historyFilePath,
            this.configDir
        );
    }

    public async clear(): Promise<void> {
        this.runs = [];
        this.isLoaded = true;
        await this.save();
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

    public async load(
        retentionDays: number = DEFAULT_HISTORY_RETENTION_DAYS,
        now: number = Date.now()
    ): Promise<SyncHistoryData> {
        await this.savePromise;
        const exists: boolean = await this.adapter.exists(this.historyFilePath);
        if (!exists) {
            this.runs = [];
            this.isLoaded = true;
            return {
                runs: [],
                version: CURRENT_HISTORY_VERSION
            };
        }

        const raw: string = await this.adapter
            .read(this.historyFilePath)
            .catch((err: unknown): never => {
                log.error("Failed to read sync history file:", err);
                throw err;
            });

        if (raw.length > MAX_FILE_SIZE_BYTES) {
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
                "runs" in parsed &&
                Array.isArray(parsed.runs)
            ) {
                const validated: SyncRunRecord[] = [];
                for (const item of parsed.runs) {
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

    public async recordRun(
        run: SyncRunRecord,
        retentionDays: number = DEFAULT_HISTORY_RETENTION_DAYS,
        now: number = Date.now()
    ): Promise<SyncRunRecord[]> {
        if (!this.isLoaded) {
            await this.load(retentionDays, now);
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
                collapsedCount: latest.collapsedCount + sanitized.collapsedCount,
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
        await this.save();
        return this.getRuns();
    }

    public save(): Promise<void> {
        const writeTask = async (): Promise<void> => {
            await this.ensureParentDirectory();
            const payload: SyncHistoryData = {
                runs: this.runs,
                version: CURRENT_HISTORY_VERSION
            };
            const serialized: string = JSON.stringify(payload);
            await this.adapter.write(this.historyFilePath, serialized);
        };
        const nextPromise: Promise<void> = this.savePromise.then(
            writeTask,
            writeTask
        );
        this.savePromise = nextPromise.catch(() => undefined);
        return nextPromise;
    }
}
