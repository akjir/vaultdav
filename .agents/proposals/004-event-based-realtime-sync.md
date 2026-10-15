# Proposal 004: Event-Based Real-Time Synchronization

- **Status:** Draft
- **Date:** 2026-10-15
- **Scope:** `src/types.ts`, `src/settings.ts`, `src/main.ts`, `src/sync/engine.ts`, `src/sync/watcher.ts`, `tests/obsidian_mock.ts`, `tests/settings.test.ts`, `tests/main.test.ts`, `tests/watcher.test.ts`, `tests/engine.test.ts`

## 1. Objective
Periodic full-vault `PROPFIND` traversal (`syncInterval`) introduces latency after local edits and generates high HTTP request volume on the Nextcloud server. This proposal adds an optional event-based file watcher that subscribes to Obsidian `Vault` events (`create`, `modify`, `delete`, `rename`), coalesces rapid edits with a zero-dependency debouncer, and executes targeted single-path WebDAV operations (`PROPFIND` Depth `0`, `PUT`, `MKCOL`, `MOVE`, `DELETE`) while updating `SyncStateStore`.

## 2. Technical Design

### 2.1. Settings and Types (`src/types.ts`, `src/settings.ts`)
Extend `VaultDavSettings` with two properties:
```typescript
export interface VaultDavSettings {
    // Existing properties...
    enableRealtimeSync: boolean;
    realtimeDebounceSeconds: number;
}
```
- Default values in `DEFAULT_SETTINGS`: `enableRealtimeSync: false`, `realtimeDebounceSeconds: 5`.
- Bounds constants in `src/settings.ts`: `MIN_REALTIME_DEBOUNCE_SECONDS: number = 1`, `MAX_REALTIME_DEBOUNCE_SECONDS: number = 300`.
- Add two settings in `VaultDavSettingTab` using strict Sentence case:
  - `"Real-time sync"`: Toggle (`addToggle`) with description `"Automatically upload local file changes shortly after editing."`.
  - `"Real-time debounce delay"`: Number input (`addText`) with description `"Seconds to wait after the last local edit before syncing the changed file (1 to 300)."`

### 2.2. Event Coalescing and Debouncer (`src/sync/watcher.ts`)
Define a dedicated `VaultWatcher` class with zero external dependencies:
```typescript
export type WatcherEventType = "create" | "delete" | "modify" | "rename";

export interface QueuedVaultEvent {
    isDirectory: boolean;
    oldPath?: string;
    path: string;
    timestamp: number;
    type: WatcherEventType;
}
```
- **Suppression Guard:** Ignore events when `plugin.isSyncing === true` or when the normalized path is in `ignoredLocalMutationPaths: Set<string>` (populated when `SyncEngine` writes or deletes local files during sync) to prevent infinite feedback loops.
- **Exclusion Check:** Immediately discard any event where `util.isExcludedPath(path)` is `true`.
- **Event Coalescing Rules:** Maintain `pendingEvents: Map<string, QueuedVaultEvent>` keyed by normalized vault path:
  - `create` followed by `modify` -> keep as `create` (or `modify`; both resolve to single-path upload).
  - `create` followed by `delete` within the same debounce window -> remove from `pendingEvents` (net no-op).
  - `modify` followed by `delete` -> replace with `delete`.
  - `rename(file, oldPath)` -> if `oldPath` was queued as `create`, re-key as `create` at `file.path`; otherwise record a `rename` entry from `oldPath` to `file.path`.
- **Timer Lifecycle:** Each incoming event resets a single `window.setTimeout` handle for `realtimeDebounceSeconds * 1000` milliseconds. Calling `dispose()` clears the active timer and empties `pendingEvents`.

### 2.3. Targeted Single-Path Execution (`src/sync/engine.ts`, `src/webdav/client.ts`)
Add `runTargetedSync(events: ReadonlyArray<QueuedVaultEvent>): Promise<SyncResult>` to `SyncEngine` and `moveItem(sourcePath: string, destinationPath: string, isDirectory: boolean): Promise<void>` to `WebDavClient`:
1. **Remote Safety Check (`PROPFIND` Depth `0`):** Before mutating a remote path, call `client.statRemote(path, event.isDirectory)` and retrieve `stateStore.getRecord(path)`.
2. **Create / Modify (`upload`):**
   - Verify the item still exists locally via `vault.adapter.stat(path)`.
   - If `event.isDirectory` is `true`, ensure remote directory creation via `client.createDirectory(path)` and upsert the directory `SyncStateRecord`.
   - For files, if `remoteItem !== null` and `state !== undefined && isRemoteModified(remoteItem, state)`, route the path to `executeConflict()` instead of overwriting the concurrent remote edit.
   - Ensure missing ancestor directories exist remotely (checking `stateStore.getRecord(ancestor)` first to avoid redundant `MKCOL` calls), upload the file via `executeUpload()`, and persist `SyncStateStore`.
3. **Delete (`delete_remote`):**
   - If `state === undefined`, take no remote action.
   - If `remoteItem !== null && isRemoteModified(remoteItem, state)` is `true`, download the modified remote file via `executeDownload()` instead of deleting it.
   - Otherwise, call `client.deleteItem(path, event.isDirectory)` and `stateStore.removeRecord(path)`.
4. **Rename (`MOVE`):**
   - If `stateStore.getRecord(oldPath)` exists and `statRemote(newPath)` returns `null`, issue WebDAV `MOVE` (`Overwrite: "F"`) from `oldPath` to `newPath`, remove `oldPath` from `SyncStateStore`, and upsert `newPath` with fresh `statRemote(newPath)` metadata. If `MOVE` is not possible, fall back to targeted upload of `newPath` and targeted delete of `oldPath`.

### 2.4. Plugin Lifecycle Integration (`src/main.ts`)
- Register `Vault` listeners inside `this.app.workspace.onLayoutReady()` via `this.registerEvent(this.app.vault.on(...))` so Obsidian's startup file discovery does not queue full-vault `create` events.
- If a debounced batch fires while `this.isSyncing === true`, re-arm the debounce timer so the batch runs after the active sync completes.

## 3. Verification Plan
- `tests/watcher.test.ts`:
  - Coalesces rapid `create` + `modify` events into a single upload operation after the debounce delay.
  - Cancels `create` + `delete` pairs occurring within the same debounce window without network calls.
  - Translates `rename` events and coalesces chained renames (`A -> B -> C` becomes `A -> C`).
  - Ignores excluded paths (`.obsidian/workspace.json`, `.git/`, `sync-state.json`) and events emitted while `isSyncing === true`.
  - Clears pending timers cleanly on `onunload()`.
- `tests/engine.test.ts`:
  - `runTargetedSync` uploads a modified file after verifying `statRemote` (`Depth: "0"`) matches `SyncStateRecord.etag`.
  - `runTargetedSync` triggers `executeConflict` instead of overwriting when `statRemote` reveals a changed remote ETag.
  - `runTargetedSync` skips `deleteItem` and downloads the remote file if the remote file was modified since `lastSyncTime`.
- `tests/settings.test.ts`:
  - Validates `enableRealtimeSync` toggle and `realtimeDebounceSeconds` clamping (`1..300`).

## 4. Implementation Steps
1. Extend `VaultDavSettings` in `src/types.ts` and `DEFAULT_SETTINGS` / `VaultDavSettingTab` in `src/settings.ts`.
2. Add `moveItem` to `src/webdav/client.ts` and unit tests in `tests/client.test.ts`.
3. Implement `VaultWatcher` in `src/sync/watcher.ts` with event coalescing and debounce timer management.
4. Implement `runTargetedSync` in `src/sync/engine.ts` with single-path `statRemote` conflict detection.
5. Wire `VaultWatcher` and `onLayoutReady` event registration into `src/main.ts`.
6. Add comprehensive unit tests in `tests/watcher.test.ts`, `tests/engine.test.ts`, `tests/main.test.ts`, and `tests/settings.test.ts`.
