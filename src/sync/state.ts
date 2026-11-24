import type { DataAdapter } from "obsidian";
import { log } from "../log";
import type { SyncStateData, SyncStateRecord } from "../types";
import { MAX_FILE_SIZE_BYTES, util } from "../utilities";

const CURRENT_STATE_VERSION: number = 1;
const FORBIDDEN_STATE_SEGMENTS_LOWER: ReadonlySet<string> = new Set<string>([
    ".ds_store",
    ".git",
    ".svn",
    ".trash",
    "desktop.ini",
    "node_modules",
    "thumbs.db"
]);
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

function resolveStateFilePath(
    stateFilePath: string,
    rawConfigDir: string
): string {
    const normalized: string = util.normalizeVaultPath(stateFilePath);
    if (normalized === "") {
        throw new Error(`Invalid sync state file path: ${stateFilePath}`);
    }
    const lower: string = normalized.toLowerCase();
    const expectedSuffix: string = `/${util.SYNC_STATE_RELATIVE_PATH}`;

    if (rawConfigDir !== "") {
        const normalizedConfigDir: string = util.normalizeVaultPath(rawConfigDir);
        if (normalizedConfigDir === "") {
            throw new Error(`Invalid sync state file path: ${stateFilePath}`);
        }
        const configSegments: string[] = normalizedConfigDir
            .toLowerCase()
            .split("/");
        for (const segment of configSegments) {
            if (FORBIDDEN_STATE_SEGMENTS_LOWER.has(segment)) {
                throw new Error(
                    `Invalid sync state file path: ${stateFilePath}`
                );
            }
        }
        const expectedPathLower: string = util
            .getSyncStateFilePath(normalizedConfigDir)
            .toLowerCase();
        if (
            lower !== expectedPathLower ||
            !util.isExcludedPath(normalized, normalizedConfigDir)
        ) {
            throw new Error(`Invalid sync state file path: ${stateFilePath}`);
        }
        return normalized;
    }

    if (!lower.endsWith(expectedSuffix)) {
        throw new Error(`Invalid sync state file path: ${stateFilePath}`);
    }
    const prefixLower: string = lower.slice(
        0,
        lower.length - expectedSuffix.length
    );
    if (
        prefixLower === "" ||
        !prefixLower.startsWith(".") ||
        prefixLower.includes("/") ||
        FORBIDDEN_STATE_SEGMENTS_LOWER.has(prefixLower) ||
        !util.isExcludedPath(normalized, "")
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
    private readonly configDir: string;
    private ensureParentDirPromise: Promise<void> | null = null;
    private isParentDirEnsured: boolean = false;
    private lowerKeyMap: Map<string, string> = new Map<string, string>();
    private records: Record<string, SyncStateRecord>;
    private savePromise: Promise<void> = Promise.resolve();
    private readonly stateFilePath: string;

    public constructor(
        adapter: DataAdapter,
        stateFilePath: string,
        configDir: string = ""
    ) {
        this.adapter = adapter;
        this.stateFilePath = resolveStateFilePath(stateFilePath, configDir);
        this.configDir =
            configDir !== "" ? util.normalizeVaultPath(configDir) : "";
        this.records = createRecordMap();
    }

    public async clear(): Promise<void> {
        this.records = createRecordMap();
        this.lowerKeyMap.clear();
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
        if (normalized === "" || util.isExcludedPath(normalized, this.configDir)) {
            return undefined;
        }
        if (Object.prototype.hasOwnProperty.call(this.records, normalized)) {
            const direct: SyncStateRecord | undefined =
                this.records[normalized];
            return direct !== undefined ? cloneRecord(direct) : undefined;
        }
        const matchedKey: string | undefined = this.lowerKeyMap.get(
            normalized.toLowerCase()
        );
        if (matchedKey !== undefined) {
            const matched: SyncStateRecord | undefined =
                this.records[matchedKey];
            return matched !== undefined ? cloneRecord(matched) : undefined;
        }
        return undefined;
    }

    public async load(): Promise<SyncStateData> {
        await this.savePromise;
        const exists: boolean = await this.adapter.exists(this.stateFilePath);
        if (!exists) {
            this.records = createRecordMap();
            this.lowerKeyMap.clear();
            return {
                records: {},
                version: CURRENT_STATE_VERSION
            };
        }

        const raw: string = await this.adapter
            .read(this.stateFilePath)
            .catch((err: unknown): never => {
                log.error("Failed to read sync state file:", err);
                throw err;
            });

        if (raw.length > MAX_FILE_SIZE_BYTES) {
            log.warn(
                "Sync state file exceeds maximum allowed size; resetting state."
            );
            this.records = createRecordMap();
            this.lowerKeyMap.clear();
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
                typeof parsed.records === "object" &&
                parsed.records !== null &&
                !Array.isArray(parsed.records)
            ) {
                const rawRecords: Record<string, unknown> =
                    parsed.records as Record<string, unknown>;
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
                        const candidate: Partial<SyncStateRecord> = val;
                        if (
                            normalizedKey !== "" &&
                            !util.isExcludedPath(normalizedKey, this.configDir)
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
                this.lowerKeyMap = lowerKeyMap;
                return {
                    records: cloneRecordMap(this.records),
                    version: CURRENT_STATE_VERSION
                };
            }
        } catch (err: unknown) {
            log.warn("Failed to parse sync state file; resetting state.", err);
        }

        this.records = createRecordMap();
        this.lowerKeyMap.clear();
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
        const existingKey: string | undefined = this.lowerKeyMap.get(lower);
        if (existingKey !== undefined) {
            delete this.records[existingKey];
            this.lowerKeyMap.delete(lower);
        }
    }

    public save(): Promise<void> {
        const writeTask = async (): Promise<void> => {
            await this.ensureParentDirectory();
            const payload: SyncStateData = {
                records: this.records,
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
        if (normalized === "" || util.isExcludedPath(normalized, this.configDir)) {
            return;
        }
        const lower: string = normalized.toLowerCase();
        const existingKey: string | undefined = this.lowerKeyMap.get(lower);
        if (existingKey !== undefined && existingKey !== normalized) {
            delete this.records[existingKey];
        }
        this.lowerKeyMap.set(lower, normalized);
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
