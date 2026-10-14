import type { DataAdapter } from "obsidian";
import { log } from "../log";
import type { SyncStateData, SyncStateRecord } from "../types";
import { SYNC_STATE_FILE_PATH, util } from "../utilities";

const CURRENT_STATE_VERSION: number = 1;
const NULL_PADDING_REGEX: RegExp = /^\0+|\0+$/g;

function createRecordMap(): Record<string, SyncStateRecord> {
    return Object.create(null) as Record<string, SyncStateRecord>;
}

export class SyncStateStore {
    private readonly adapter: DataAdapter;
    private isParentDirEnsured: boolean = false;
    private records: Record<string, SyncStateRecord>;
    private savePromise: Promise<void> = Promise.resolve();
    private readonly stateFilePath: string;

    public constructor(
        adapter: DataAdapter,
        stateFilePath: string = SYNC_STATE_FILE_PATH
    ) {
        this.adapter = adapter;
        this.stateFilePath = util.normalizeVaultPath(stateFilePath);
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
        const levels: string[] = util.getFolderLevels(this.stateFilePath, false);
        for (const folder of levels) {
            const exists: boolean = await this.adapter.exists(folder);
            if (!exists) {
                await this.adapter.mkdir(folder);
            }
        }
        this.isParentDirEnsured = true;
    }

    public getAll(): Record<string, SyncStateRecord> {
        return { ...this.records };
    }

    public getRecord(path: string): SyncStateRecord | undefined {
        const normalized: string = util.normalizeVaultPath(path);
        if (normalized === "") {
            return undefined;
        }
        if (Object.prototype.hasOwnProperty.call(this.records, normalized)) {
            return this.records[normalized];
        }
        const lower: string = normalized.toLowerCase();
        for (const existingKey of Object.keys(this.records)) {
            if (existingKey.toLowerCase() === lower) {
                return this.records[existingKey];
            }
        }
        return undefined;
    }

    public async load(): Promise<SyncStateData> {
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

        try {
            const sanitizedRaw: string = raw.replace(NULL_PADDING_REGEX, "").trim();
            const parsed: unknown = JSON.parse(sanitizedRaw);
            if (
                typeof parsed === "object" &&
                parsed !== null &&
                "records" in parsed &&
                typeof (parsed as { records: unknown }).records === "object" &&
                (parsed as { records: unknown }).records !== null
            ) {
                const rawRecords: Record<string, unknown> = (
                    parsed as { records: Record<string, unknown> }
                ).records;
                const validated: Record<string, SyncStateRecord> = createRecordMap();
                const lowerKeyMap: Map<string, string> = new Map<string, string>();

                for (const [key, val] of Object.entries(rawRecords)) {
                    if (typeof val === "object" && val !== null) {
                        const normalizedKey: string = util.normalizeVaultPath(key);
                        const candidate: Partial<SyncStateRecord> =
                            val as Partial<SyncStateRecord>;
                        if (normalizedKey !== "" && !util.isExcludedPath(normalizedKey)) {
                            const lowerKey: string = normalizedKey.toLowerCase();
                            const existingKey: string | undefined = lowerKeyMap.get(lowerKey);
                            if (existingKey !== undefined && existingKey !== normalizedKey) {
                                delete validated[existingKey];
                            }
                            lowerKeyMap.set(lowerKey, normalizedKey);
                            validated[normalizedKey] = {
                                etag: util.normalizeEtag(
                                    typeof candidate.etag === "string" ? candidate.etag : ""
                                ),
                                isDirectory: Boolean(candidate.isDirectory),
                                lastSyncTime:
                                    typeof candidate.lastSyncTime === "number" &&
                                    Number.isFinite(candidate.lastSyncTime) &&
                                    candidate.lastSyncTime > 0
                                        ? candidate.lastSyncTime
                                        : 0,
                                localMtime:
                                    typeof candidate.localMtime === "number" &&
                                    Number.isFinite(candidate.localMtime) &&
                                    candidate.localMtime > 0
                                        ? candidate.localMtime
                                        : 0,
                                path: normalizedKey,
                                remoteMtime:
                                    typeof candidate.remoteMtime === "number" &&
                                    Number.isFinite(candidate.remoteMtime) &&
                                    candidate.remoteMtime > 0
                                        ? candidate.remoteMtime
                                        : 0,
                                size:
                                    typeof candidate.size === "number" &&
                                    Number.isFinite(candidate.size) &&
                                    candidate.size >= 0
                                        ? candidate.size
                                        : 0
                            };
                        }
                    }
                }
                this.records = validated;
                return {
                    records: { ...this.records },
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
                records: { ...this.records },
                version: CURRENT_STATE_VERSION
            };
            // Use unformatted JSON to save space and I/O time on mobile
            const serialized: string = JSON.stringify(payload);
            await this.adapter.write(this.stateFilePath, serialized);
        };
        this.savePromise = this.savePromise.then(writeTask, writeTask);
        return this.savePromise;
    }

    public upsertRecord(record: SyncStateRecord): void {
        const normalized: string = util.normalizeVaultPath(record.path);
        if (normalized === "" || util.isExcludedPath(normalized)) {
            return;
        }
        const lower: string = normalized.toLowerCase();
        for (const existingKey of Object.keys(this.records)) {
            if (existingKey !== normalized && existingKey.toLowerCase() === lower) {
                delete this.records[existingKey];
            }
        }
        this.records[normalized] = {
            etag: util.normalizeEtag(record.etag),
            isDirectory: Boolean(record.isDirectory),
            lastSyncTime:
                Number.isFinite(record.lastSyncTime) && record.lastSyncTime > 0
                    ? record.lastSyncTime
                    : 0,
            localMtime:
                Number.isFinite(record.localMtime) && record.localMtime > 0
                    ? record.localMtime
                    : 0,
            path: normalized,
            remoteMtime:
                Number.isFinite(record.remoteMtime) && record.remoteMtime > 0
                    ? record.remoteMtime
                    : 0,
            size:
                Number.isFinite(record.size) && record.size >= 0 ? record.size : 0
        };
    }
}
