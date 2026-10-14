import type { DataAdapter } from "obsidian";
import { log } from "../log";
import type { SyncStateData, SyncStateRecord } from "../types";
import { SYNC_STATE_FILE_PATH, util } from "../utilities";

const CURRENT_STATE_VERSION: number = 1;

export class SyncStateStore {
    private readonly adapter: DataAdapter;
    private records: Record<string, SyncStateRecord>;
    private readonly stateFilePath: string;

    public constructor(
        adapter: DataAdapter,
        stateFilePath: string = SYNC_STATE_FILE_PATH
    ) {
        this.adapter = adapter;
        this.stateFilePath = util.normalizeVaultPath(stateFilePath);
        this.records = {};
    }

    public async clear(): Promise<void> {
        this.records = {};
        await this.save();
    }

    public async ensureParentDirectory(): Promise<void> {
        const levels: string[] = util.getFolderLevels(this.stateFilePath, false);
        for (const folder of levels) {
            const exists: boolean = await this.adapter.exists(folder);
            if (!exists) {
                await this.adapter.mkdir(folder);
            }
        }
    }

    public getAll(): Record<string, SyncStateRecord> {
        return { ...this.records };
    }

    public getRecord(path: string): SyncStateRecord | undefined {
        const normalized: string = util.normalizeVaultPath(path);
        return this.records[normalized];
    }

    public async load(): Promise<SyncStateData> {
        const exists: boolean = await this.adapter.exists(this.stateFilePath);
        if (!exists) {
            this.records = {};
            return {
                records: {},
                version: CURRENT_STATE_VERSION
            };
        }

        try {
            const raw: string = await this.adapter.read(this.stateFilePath);
            const parsed: unknown = JSON.parse(raw);
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
                const validated: Record<string, SyncStateRecord> = {};

                for (const [key, val] of Object.entries(rawRecords)) {
                    if (typeof val === "object" && val !== null) {
                        const normalizedKey: string = util.normalizeVaultPath(key);
                        const candidate: Partial<SyncStateRecord> =
                            val as Partial<SyncStateRecord>;
                        if (normalizedKey !== "" && !util.isExcludedPath(normalizedKey)) {
                            validated[normalizedKey] = {
                                etag: typeof candidate.etag === "string" ? candidate.etag : "",
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

        this.records = {};
        return {
            records: {},
            version: CURRENT_STATE_VERSION
        };
    }

    public removeRecord(path: string): void {
        const normalized: string = util.normalizeVaultPath(path);
        delete this.records[normalized];
    }

    public async save(): Promise<void> {
        await this.ensureParentDirectory();
        const payload: SyncStateData = {
            records: this.records,
            version: CURRENT_STATE_VERSION
        };
        const serialized: string = JSON.stringify(payload, null, 4);
        await this.adapter.write(this.stateFilePath, serialized);
    }

    public upsertRecord(record: SyncStateRecord): void {
        const normalized: string = util.normalizeVaultPath(record.path);
        if (normalized === "" || util.isExcludedPath(normalized)) {
            return;
        }
        this.records[normalized] = {
            etag: record.etag,
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
