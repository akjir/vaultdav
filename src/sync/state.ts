import type { DataAdapter } from "obsidian";
import { log } from "../log";
import type { SyncStateData, SyncStateRecord } from "../types";
import {
    MAX_FILE_SIZE_BYTES,
    PLUGIN_DATA_FILE_PATH,
    SYNC_STATE_FILE_PATH,
    util
} from "../utilities";

const CURRENT_STATE_VERSION: number = 1;
const MAX_SAFE_TIMESTAMP_MS: number = 8_640_000_000_000_000;

function cloneRecord(record: SyncStateRecord): SyncStateRecord {
    return {
        etag: record.etag,
        isDirectory: record.isDirectory,
        lastSyncTime: record.lastSyncTime,
        localMtime: record.localMtime,
        path: record.path,
        remoteMtime: record.remoteMtime,
        size: record.size
    };
}

function cloneRecordMap(
    source: Record<string, SyncStateRecord>
): Record<string, SyncStateRecord> {
    const copy: Record<string, SyncStateRecord> = {};
    for (const [key, record] of Object.entries(source)) {
        copy[key] = cloneRecord(record);
    }
    return copy;
}

function createRecordMap(): Record<string, SyncStateRecord> {
    return Object.create(null) as Record<string, SyncStateRecord>;
}

function resolveStateFilePath(stateFilePath: string): string {
    const normalized: string = util.normalizeVaultPath(stateFilePath);
    const lower: string = normalized.toLowerCase();
    if (
        normalized === "" ||
        lower === PLUGIN_DATA_FILE_PATH ||
        lower.endsWith("/data.json") ||
        !util.isExcludedPath(normalized)
    ) {
        throw new Error(`Invalid sync state file path: ${stateFilePath}`);
    }
    return normalized;
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

function sanitizeRecordSize(value: unknown): number {
    if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        !Number.isSafeInteger(value) ||
        value < 0
    ) {
        return 0;
    }
    return value;
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

export class SyncStateStore {
    private readonly adapter: DataAdapter;
    private ensureParentDirPromise: Promise<void> | null = null;
    private isParentDirEnsured: boolean = false;
    private records: Record<string, SyncStateRecord>;
    private savePromise: Promise<void> = Promise.resolve();
    private readonly stateFilePath: string;

    public constructor(
        adapter: DataAdapter,
        stateFilePath: string = SYNC_STATE_FILE_PATH
    ) {
        this.adapter = adapter;
        this.stateFilePath = resolveStateFilePath(stateFilePath);
        this.records = createRecordMap();
    }

    public async clear(): Promise<void> {
        this.records = createRecordMap();
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
                this.stateFilePath,
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

    public getAll(): Record<string, SyncStateRecord> {
        return cloneRecordMap(this.records);
    }

    public getRecord(path: string): SyncStateRecord | undefined {
        const normalized: string = util.normalizeVaultPath(path);
        if (normalized === "" || util.isExcludedPath(normalized)) {
            return undefined;
        }
        if (Object.prototype.hasOwnProperty.call(this.records, normalized)) {
            const direct: SyncStateRecord | undefined =
                this.records[normalized];
            return direct !== undefined ? cloneRecord(direct) : undefined;
        }
        const lower: string = normalized.toLowerCase();
        for (const existingKey of Object.keys(this.records)) {
            if (existingKey.toLowerCase() === lower) {
                const matched: SyncStateRecord | undefined =
                    this.records[existingKey];
                return matched !== undefined ? cloneRecord(matched) : undefined;
            }
        }
        return undefined;
    }

    public async load(): Promise<SyncStateData> {
        await this.savePromise;
        const exists: boolean = await this.adapter.exists(this.stateFilePath);
        if (!exists) {
            this.records = createRecordMap();
            return {
                records: {},
                version: CURRENT_STATE_VERSION
            };
        }

        let raw: string = "";
        try {
            raw = await this.adapter.read(this.stateFilePath);
        } catch (err: unknown) {
            log.error("Failed to read sync state file:", err);
            throw err;
        }

        if (raw.length > MAX_FILE_SIZE_BYTES) {
            log.warn(
                "Sync state file exceeds maximum allowed size; resetting state."
            );
            this.records = createRecordMap();
            return {
                records: {},
                version: CURRENT_STATE_VERSION
            };
        }

        try {
            const sanitizedRaw: string = stripNullPadding(raw).trim();
            const parsed: unknown = JSON.parse(sanitizedRaw);
            if (
                typeof parsed === "object" &&
                parsed !== null &&
                !Array.isArray(parsed) &&
                "records" in parsed &&
                typeof (parsed as { records: unknown }).records === "object" &&
                (parsed as { records: unknown }).records !== null &&
                !Array.isArray((parsed as { records: unknown }).records)
            ) {
                const rawRecords: Record<string, unknown> = (
                    parsed as { records: Record<string, unknown> }
                ).records;
                const validated: Record<string, SyncStateRecord> =
                    createRecordMap();
                const lowerKeyMap: Map<string, string> = new Map<
                    string,
                    string
                >();

                for (const [key, val] of Object.entries(rawRecords)) {
                    if (
                        typeof val === "object" &&
                        val !== null &&
                        !Array.isArray(val)
                    ) {
                        const normalizedKey: string =
                            util.normalizeVaultPath(key);
                        const candidate: Partial<SyncStateRecord> =
                            val as Partial<SyncStateRecord>;
                        if (
                            normalizedKey !== "" &&
                            !util.isExcludedPath(normalizedKey)
                        ) {
                            const lowerKey: string =
                                normalizedKey.toLowerCase();
                            const existingKey: string | undefined =
                                lowerKeyMap.get(lowerKey);
                            if (
                                existingKey !== undefined &&
                                existingKey !== normalizedKey
                            ) {
                                delete validated[existingKey];
                            }
                            lowerKeyMap.set(lowerKey, normalizedKey);
                            validated[normalizedKey] = {
                                etag: util.normalizeEtag(
                                    typeof candidate.etag === "string"
                                        ? candidate.etag
                                        : ""
                                ),
                                isDirectory: Boolean(candidate.isDirectory),
                                lastSyncTime: sanitizePositiveTimestamp(
                                    candidate.lastSyncTime
                                ),
                                localMtime: sanitizePositiveTimestamp(
                                    candidate.localMtime
                                ),
                                path: normalizedKey,
                                remoteMtime: sanitizePositiveTimestamp(
                                    candidate.remoteMtime
                                ),
                                size: sanitizeRecordSize(candidate.size)
                            };
                        }
                    }
                }
                this.records = validated;
                return {
                    records: cloneRecordMap(this.records),
                    version: CURRENT_STATE_VERSION
                };
            }
        } catch (err: unknown) {
            log.warn("Failed to parse sync state file; resetting state.", err);
        }

        this.records = createRecordMap();
        return {
            records: {},
            version: CURRENT_STATE_VERSION
        };
    }

    public removeRecord(path: string): void {
        const normalized: string = util.normalizeVaultPath(path);
        if (normalized === "") {
            return;
        }
        if (Object.prototype.hasOwnProperty.call(this.records, normalized)) {
            delete this.records[normalized];
        }
        const lower: string = normalized.toLowerCase();
        for (const existingKey of Object.keys(this.records)) {
            if (existingKey.toLowerCase() === lower) {
                delete this.records[existingKey];
            }
        }
    }

    public save(): Promise<void> {
        const writeTask = async (): Promise<void> => {
            await this.ensureParentDirectory();
            const payload: SyncStateData = {
                records: cloneRecordMap(this.records),
                version: CURRENT_STATE_VERSION
            };
            // Use unformatted JSON to save space and I/O time on mobile
            const serialized: string = JSON.stringify(payload);
            await this.adapter.write(this.stateFilePath, serialized);
        };
        const nextPromise: Promise<void> = this.savePromise.then(
            writeTask,
            writeTask
        );
        this.savePromise = nextPromise.catch(() => undefined);
        return nextPromise;
    }

    public upsertRecord(record: SyncStateRecord): void {
        if (
            typeof record !== "object" ||
            record === null ||
            typeof record.path !== "string"
        ) {
            return;
        }
        const normalized: string = util.normalizeVaultPath(record.path);
        if (normalized === "" || util.isExcludedPath(normalized)) {
            return;
        }
        const lower: string = normalized.toLowerCase();
        for (const existingKey of Object.keys(this.records)) {
            if (
                existingKey !== normalized &&
                existingKey.toLowerCase() === lower
            ) {
                delete this.records[existingKey];
            }
        }
        this.records[normalized] = {
            etag: util.normalizeEtag(
                typeof record.etag === "string" ? record.etag : ""
            ),
            isDirectory: Boolean(record.isDirectory),
            lastSyncTime: sanitizePositiveTimestamp(record.lastSyncTime),
            localMtime: sanitizePositiveTimestamp(record.localMtime),
            path: normalized,
            remoteMtime: sanitizePositiveTimestamp(record.remoteMtime),
            size: sanitizeRecordSize(record.size)
        };
    }
}
