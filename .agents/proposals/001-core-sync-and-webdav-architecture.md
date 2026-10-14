# Proposal 001: Core Sync and WebDAV Architecture

- **Status:** Implemented
- **Date:** 2026-10-14
- **Scope:** `src/types.ts`, `src/utilities.ts`, `src/log.ts`, `src/settings.ts`, `src/webdav/xml_parser.ts`, `src/webdav/client.ts`, `src/sync/state.ts`, `src/sync/engine.ts`, `src/main.ts`, `tests/utilities.test.ts`, `tests/xml_parser.test.ts`, `tests/client.test.ts`, `tests/state.test.ts`, `tests/engine.test.ts`

## 1. Objective
Define the zero-dependency Nextcloud WebDAV client and bidirectional synchronization engine for VaultDAV. This architecture adapts proven WebDAV quirk workarounds and three-way synchronization mechanics inspired by [remotely-save](https://github.com/remotely-save/remotely-save) (`src/fsWebdav.ts`, `pro/src/sync.ts`, `pro/src/conflictLogic.ts`, and `src/obsFolderLister.ts`). All external libraries (`webdav`, `fast-xml-parser`, `localforage`, `p-queue`, `lodash`) are replaced with Obsidian `requestUrl`, browser `DOMParser`, JSON state persistence, and native TypeScript concurrency primitives.

## 2. Technical Design

### 2.1. Inspiration & Clean-Room Adaptation Reference
VaultDAV officially credits [remotely-save](https://github.com/remotely-save/remotely-save) as architectural inspiration for its WebDAV edge-case handling and three-way delta resolution (originally modeled after `syncrclone`). The table below maps `remotely-save` mechanics to VaultDAV's zero-dependency modules:

| Capability | `remotely-save` Reference | VaultDAV Zero-Dependency Adaptation |
| :--- | :--- | :--- |
| HTTP Transport | `webdav` npm package patched over `requestUrl` (`src/fsWebdav.ts`) | Direct `requestUrl` wrapper with `throw: false` (`src/webdav/client.ts`) |
| XML Parsing | `fast-xml-parser` inside `webdav` package | Native `DOMParser` (`application/xml`) (`src/webdav/xml_parser.ts`) |
| Tree Discovery | BFS queue with `Depth: 1` (`manual_1` in `FakeFsWebdav.walk`) | Rate-limited BFS `PROPFIND` (`Depth: 1`) (`src/webdav/client.ts`) |
| Sync State DB | IndexedDB via `localforage` (`src/localdb.ts`) | JSON index persisted via `DataAdapter` (`src/sync/state.ts`) |
| Delta & Ordering | `getSyncPlanInplace` & `splitFourStepsOnEntityMappings` (`pro/src/sync.ts`) | 4-phase planner & `keptFolders` propagation (`src/sync/engine.ts`) |
| Conflict Duplication | `tryDuplicateFile` (`pro/src/conflictLogic.ts`) | Byte-equal short-circuit & conflict copy naming (`src/sync/engine.ts`) |
| Concurrency | `p-queue` & `@fyears/tsqueue` | Native worker-pool queue (`runConcurrent` in `src/utilities.ts`) |

---

### 2.2. WebDAV Quirk Handling (`src/webdav/client.ts` & `src/webdav/xml_parser.ts`)

1. **Nextcloud Endpoint Resolution & Path Encoding:**
   - Target endpoint format: `https://<domain>[/<subpath>]/remote.php/dav/files/<user>/<remote-base-dir>/`.
   - If `settings.url` omits `/remote.php/dav/files/`, construct `${trimmedBaseUrl}/remote.php/dav/files/${encodeURIComponent(settings.username)}`.
   - Normalize vault-relative paths with Obsidian `normalizePath(path)`. Strip leading slashes.
   - **Segment-wise URI Encoding:** Split vault-relative paths by `/` and encode each segment with `encodeURIComponent(segment)` before joining with `/`. Unlike `encodeURI`, `encodeURIComponent` encodes `#`, `?`, `+`, and `&`, which are valid in Obsidian note filenames (for example, `C# Notes.md` or `Question?.md`) and would otherwise corrupt the HTTP request URL.
   - **Trailing Slash Enforcement:** Always append `/` to remote directory URLs (`PROPFIND`, `MKCOL`, `DELETE` on collections) and omit trailing `/` on file URLs (`GET`, `PUT`, `DELETE` on files). This prevents Nextcloud/SabreDAV `301`/`302` redirects and the iOS WebView quirk where `PROPFIND` on a slashless directory returns `401 Unauthorized`.

2. **Request Headers, Authentication & Status Handling:**
   - Send `Authorization: Basic <base64>` where `<base64>` is computed from UTF-8 bytes (`new TextEncoder().encode("${username}:${appPassword}")`) in `util.encodeBasicAuth(username, appPassword)` so non-ASCII passwords do not fail in `btoa`.
   - Include `Cache-Control: no-cache` on all requests to prevent mobile WebView response caching.
   - Do not set `Host` or `Content-Length` headers manually.
   - Pass `throw: false` to `requestUrl` to inspect status codes (`200`, `201`, `204`, `207`, `401`, `403`, `404`, `405`, `409`, `423`, `429`, `507`, `5xx`) deterministically. Specifically handle HTTP `507 Insufficient Storage` with a descriptive storage quota error without retrying.
   - Send file payloads (`PUT`) as `ArrayBuffer` with `contentType: "application/octet-stream"` and Nextcloud's `X-OC-Mtime: "${Math.floor(localMtime / 1000)}"` header so Nextcloud records the client modification timestamp.
   - **`PUT` State Anchoring:** After a successful `PUT` (`200`, `201`, `204`), extract and normalize the `ETag` response header (case-insensitive header lookup for `etag` or `oc-etag`). If the response omits an `ETag` header, fall back to calling `statRemote(path)` (`PROPFIND` with `Depth: 0`) to retrieve the authoritative remote `etag` and `mtime` before upserting `SyncStateRecord`.

3. **`Depth` Header Strategy (BFS with `Depth: 1`):**
   - Nextcloud disables `Depth: infinity` by default (`403 Forbidden` / `Sabre\DAV\Exception\Forbidden`).
   - Discover the remote tree using Breadth-First Search (BFS) starting at `remoteBaseDir/`:
     - Issue `PROPFIND` with header `Depth: 1` and body requesting `<d:getlastmodified/>`, `<d:getcontentlength/>`, `<d:getetag/>`, and `<d:resourcetype/>`.
     - Enqueue discovered child directories (`isDirectory: true`) and fetch levels concurrently (up to `MAX_CONCURRENCY = 4`).
   - Use `PROPFIND` with `Depth: 0` for single-item metadata lookup (`statRemote`).

4. **`MKCOL` Recursive Parent Directory Creation:**
   - WebDAV `MKCOL` returns `409 Conflict` if parent directories do not exist and `405 Method Not Allowed` if the target directory already exists.
   - Before syncing, `ensureRemoteBaseDir()` verifies `remoteBaseDir` segment-by-segment from shallowest to deepest (`PROPFIND` `Depth: 0` -> if `404`, `MKCOL`).
   - During sync execution, `create_remote_dir` actions are sorted and executed level-by-level (top-down, depth `1` to `N`) with `MKCOL`. Both `201 Created` and `405 Method Not Allowed` are treated as success.

5. **`207 Multi-Status` XML Parsing Edge Cases (`src/webdav/xml_parser.ts`):**
   - Parse XML via `new DOMParser().parseFromString(xml, "application/xml")`. Throw an error if `<parsererror>` is present.
   - **Namespace Agnosticism:** Match WebDAV tags by `localName` (`response`, `href`, `propstat`, `status`, `prop`, `getlastmodified`, `getcontentlength`, `getetag`, `resourcetype`, `collection`) across `d:`, `D:`, and default `DAV:` namespaces.
   - **Multi-`propstat` Filtering:** Inspect only `<d:propstat>` elements whose `<d:status>` text includes `" 200 "`. Ignore `404 Not Found` `propstat` blocks (commonly returned for `<d:getcontentlength>` on directories).
   - **`href` Decoding & Self-Entry Filtering:**
     - Extract the path component of `<d:href>`, split by `/`, and decode each segment with `decodeURIComponent`.
     - Strip the leading server prefix `/.../remote.php/dav/files/<user>/<remote-base-dir>/`.
     - Discard the root/self entry when the relative path equals `""` or matches the queried directory path itself.
   - **Property Normalization:**
     - `isDirectory`: `true` if `<d:resourcetype>` contains a `<d:collection>` element, else `false`.
     - `etag`: Strip surrounding `"` quotes and any leading `W/` weak indicator from `<d:getetag>`.
     - `mtime`: Parse `<d:getlastmodified>` with `Date.parse(raw)` (fallback to `0` if missing or `NaN`).
     - `size`: Parse `<d:getcontentlength>` with `Number.parseInt(raw, 10)` (fallback to `0` for directories or missing values).

---

### 2.3. Timestamp & ETag Normalization

1. **Millisecond vs. Second Precision:**
   - Local `DataAdapter.stat()` returns `mtime` in milliseconds (`1728928291456`).
   - WebDAV `getlastmodified` (RFC 1123 HTTP-date) and Nextcloud `X-OC-Mtime` operate at 1-second resolution (`1728928291000`).
   - Define `util.toSecondPrecision(ms: number): number` as `Math.floor(ms / 1000) * 1000`.

2. **Change Detection Rules (`src/sync/engine.ts`):**
   - **Dual-Anchor State Record:** `SyncStateRecord` persists `localMtime` (ms from local `stat`), `remoteMtime` (ms from remote `PROPFIND`), `etag` (normalized Nextcloud ETag), and `size` (bytes).
   - **`isLocalModified(local: LocalItem, state: SyncStateRecord): boolean`**
     - Returns `true` if `local.size !== state.size` OR `util.toSecondPrecision(local.mtime) !== util.toSecondPrecision(state.localMtime)`.
     - Comparing at second precision prevents false modification triggers on mobile platforms that truncate sub-second timestamps when `adapter.writeBinary(path, data, { mtime })` is called.
   - **`isRemoteModified(remote: RemoteItem, state: SyncStateRecord): boolean`**
     - If `remote.etag !== ""` and `state.etag !== ""`: returns `remote.etag !== state.etag || remote.size !== state.size`.
     - Fallback when `etag` is absent: returns `remote.size !== state.size || util.toSecondPrecision(remote.mtime) !== util.toSecondPrecision(state.remoteMtime)`.
   - **`isMetadataEqual(local: LocalItem, remote: RemoteItem): boolean`**
     - Used when `SyncStateRecord` is absent (for example, initial sync of an existing vault): returns `local.size === remote.size && util.toSecondPrecision(local.mtime) === util.toSecondPrecision(remote.mtime)`.

---

### 2.4. Bidirectional Sync Decision Matrix (`src/sync/engine.ts`)

#### 2.4.1. Exclusions (`util.isExcludedPath`)
Exclude the following vault-relative paths from both local enumeration and remote `PROPFIND` results before planning:
- Local sync state file: `.obsidian/plugins/vaultdav/sync-state.json`
- Plugin credentials/settings file: `.obsidian/plugins/vaultdav/data.json`
- Obsidian workspace files: `.obsidian/workspace.json`, `.obsidian/workspace-mobile.json`, and any path matching `.obsidian/workspace*.json`
- System and VCS artifacts: `.git/`, `.DS_Store`, `Thumbs.db`, `desktop.ini`

#### 2.4.2. File Decision Matrix
For each non-excluded file path across Local (`L`), Remote (`R`), and SyncState (`S`):

| Case | Local (`L`) | Remote (`R`) | State (`S`) | Condition | Action (`SyncActionType`) | State Transition |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **F1** | Absent | Absent | Present | Deleted on both sides | `prune_state` | Remove `S[path]` |
| **F2** | Present | Present | Present | `!localMod && !remoteMod` | `noop` | Keep `S[path]` |
| **F3** | Present | Present | Present | `localMod && !remoteMod` | `upload` | Upsert `S[path]` |
| **F4** | Present | Present | Present | `!localMod && remoteMod` | `download` | Upsert `S[path]` |
| **F5** | Present | Present | Present | `localMod && remoteMod` and `isMetadataEqual(L, R)` | `noop` | Upsert `S[path]` |
| **F6** | Present | Present | Present | `localMod && remoteMod` and `!isMetadataEqual(L, R)` | `conflict` | Resolve via `conflictStrategy`; update `S` |
| **F7** | Present | Present | Absent | `isMetadataEqual(L, R)` | `noop` | Upsert `S[path]` |
| **F8** | Present | Present | Absent | `!isMetadataEqual(L, R)` | `conflict` | Resolve via `conflictStrategy`; update `S` |
| **F9** | Present | Absent | Absent | Created locally | `upload` | Upsert `S[path]` |
| **F10** | Present | Absent | Present | `!localMod` (deleted remotely) | `delete_local` | Remove `S[path]` |
| **F11** | Present | Absent | Present | `localMod` (deleted remotely, modified locally) | `upload` | Upsert `S[path]` |
| **F12** | Absent | Present | Absent | Created remotely | `download` | Upsert `S[path]` |
| **F13** | Absent | Present | Present | `!remoteMod` (deleted locally) | `delete_remote` | Remove `S[path]` |
| **F14** | Absent | Present | Present | `remoteMod` (deleted locally, modified remotely) | `download` | Upsert `S[path]` |

#### 2.4.3. Conflict Resolution Strategies (`conflictStrategy`)
1. **`newest_wins`:**
   - Compare `util.toSecondPrecision(L.mtime)` against `util.toSecondPrecision(R.mtime)`.
   - If `util.toSecondPrecision(L.mtime) >= util.toSecondPrecision(R.mtime)`: Resolve as `upload` (local overwrites remote).
   - Otherwise: Resolve as `download` (remote overwrites local).
2. **`keep_both`:**
   - **Byte-Equality Short-Circuit:** If `L.size === R.size`, download `R` into an `ArrayBuffer` and compare byte-for-byte (`Uint8Array`) with `L`. If identical, skip file duplication and upsert `S[path]`.
   - **Conflict Copy Generation:** Generate `conflictCopyPath` via `util.getConflictPath(path, timestamp)` (for example, `notes/todo.md` -> `notes/todo.conflict-20261014-195131.md`, appending `-2`, `-3` if the path already exists in `L` or `R`).
   - Rename/write the local file to `conflictCopyPath` locally, write the downloaded remote payload to `path` locally (with `{ mtime: R.mtime }`), and upload the local conflict copy to `conflictCopyPath` on remote.
   - Upsert `SyncStateRecord` for both `path` and `conflictCopyPath`.

#### 2.4.4. Directory Decision Matrix & `keptFolders` Propagation
Evaluate all paths sorted by depth descending (deepest children first):
- Maintain `keptFolders: Set<string>`. Whenever a file or directory at `path` results in `noop`, `upload`, `download`, `conflict`, `create_local_dir`, or `create_remote_dir`, add its parent directory (`util.getParentPath(path)`) to `keptFolders`.
- When evaluating a directory `D`:
  - If `keptFolders.has(D)`: add `util.getParentPath(D)` to `keptFolders`.
    - `L` present, `R` present -> `noop` (upsert `S[D]`).
    - `L` present, `R` absent -> `create_remote_dir`.
    - `L` absent, `R` present -> `create_local_dir`.
  - If `!keptFolders.has(D)`:
    - `L` present, `R` present -> `noop`, add parent to `keptFolders`.
    - `L` present, `R` absent, `S` absent -> `create_remote_dir`, add parent to `keptFolders`.
    - `L` present, `R` absent, `S` present -> `delete_local` (remove `S[D]`).
    - `L` absent, `R` present, `S` absent -> `create_local_dir`, add parent to `keptFolders`.
    - `L` absent, `R` present, `S` present -> `delete_remote` (remove `S[D]`).
    - `L` absent, `R` absent, `S` present -> `prune_state` (remove `S[D]`).

#### 2.4.5. Four-Phase Execution Order, State Anchoring & Lock Retry
Execute `SyncPlan` in four strictly ordered phases using `util.runConcurrent(tasks, 4)`:
1. **Phase 1 — State Maintenance:** Apply `noop` (initial state adoption) and `prune_state` records in memory and flush `SyncStateData`.
2. **Phase 2 — Top-Down Directory Creation:** Group `create_local_dir` and `create_remote_dir` by `depth` ascending (`1..maxDepth`). Await each depth level before creating deeper subdirectories.
3. **Phase 3 — Bottom-Up Deletions:** Execute file deletions (`delete_local` via `app.vault.trash` / `adapter.trashLocal`, `delete_remote` via `DELETE`) first, then directory deletions grouped by `depth` descending (`maxDepth..1`).
4. **Phase 4 — Parallel File Transfers & Conflicts:** Execute `upload`, `download`, and `conflict` actions with concurrency `4`. Retry transient HTTP `423 Locked` (`Sabre\DAV\Exception\Locked`) or `429 Too Many Requests` up to 3 times with exponential backoff (`500ms`, `1000ms`, `2000ms`). On `PUT` upload completion, anchor `SyncStateRecord` using the normalized `ETag` response header (or fall back to `statRemote` via `PROPFIND` `Depth: 0` when `ETag` is omitted by the server) and persist state after each transfer.

---

### 2.5. Refined Type Definitions (`src/types.ts`)

All types and properties are sorted alphabetically with 4-space indentation and strict typing:

```typescript
export type ConflictStrategy = "keep_both" | "newest_wins";

export interface LocalItem {
    ctime: number;
    isDirectory: boolean;
    mtime: number;
    path: string;
    size: number;
}

export interface RemoteItem {
    etag: string;
    href: string;
    isDirectory: boolean;
    mtime: number;
    path: string;
    size: number;
}

export interface SyncAction {
    conflictCopyPath?: string;
    depth: number;
    isDirectory: boolean;
    path: string;
    type: SyncActionType;
}

export type SyncActionType =
    | "conflict"
    | "create_local_dir"
    | "create_remote_dir"
    | "delete_local"
    | "delete_remote"
    | "download"
    | "noop"
    | "prune_state"
    | "upload";

export interface SyncPlan {
    actions: SyncAction[];
    timestamp: number;
}

export interface SyncResult {
    conflictsResolved: number;
    deletedLocal: number;
    deletedRemote: number;
    downloaded: number;
    errors: string[];
    timestamp: number;
    uploaded: number;
}

export interface SyncStateData {
    records: Record<string, SyncStateRecord>;
    version: number;
}

export interface SyncStateRecord {
    etag: string;
    isDirectory: boolean;
    lastSyncTime: number;
    localMtime: number;
    path: string;
    remoteMtime: number;
    size: number;
}

export interface VaultDavSettings {
    appPassword: string;
    conflictStrategy: ConflictStrategy;
    remoteBaseDir: string;
    syncInterval: number;
    url: string;
    username: string;
}

export type WebDavMethod =
    | "DELETE"
    | "GET"
    | "MKCOL"
    | "MOVE"
    | "OPTIONS"
    | "PROPFIND"
    | "PUT";

export interface WebDavRequestOptions {
    body?: ArrayBuffer | string;
    contentType?: string;
    depth?: "0" | "1";
    headers?: Record<string, string>;
    method: WebDavMethod;
    path: string;
}
```

## 3. Verification Plan
- `tests/utilities.test.ts`:
  - Verify `encodeBasicAuth` with ASCII and UTF-8 (umlauts, CJK) credentials.
  - Verify path normalization, segment-wise `encodeWebDavPath` / `decodeWebDavHref` with spaces, `#`, `?`, `%`, and Unicode characters.
  - Verify `getFolderLevels`, `getParentPath`, `getPathDepth`, `toSecondPrecision`, `getConflictPath`, `isExcludedPath`, and `runConcurrent` rate limiting.
- `tests/xml_parser.test.ts`:
  - Verify `parseMultiStatus` with Nextcloud `207 Multi-Status` XML (`d:`, `D:`, default `DAV:` namespaces).
  - Verify filtering of `404 Not Found` `<d:propstat>` blocks alongside `200 OK` blocks.
  - Verify self-href filtering, directory detection (`<d:collection/>`), ETag quote/`W/` stripping, and malformed XML `<parsererror>` handling.
- `tests/client.test.ts`:
  - Mock Obsidian `requestUrl` to test `PROPFIND` BFS (`Depth: 1`), `GET` (`ArrayBuffer`), `PUT` (`ArrayBuffer` + `X-OC-Mtime`, extracting `ETag` from response header and falling back to `statRemote` `PROPFIND` `Depth: 0` when `ETag` header is absent), `MKCOL` recursive base directory initialization (`201` and `405`), `DELETE`, error status handling (`401`, `403`, `404`, `409`, `507 Insufficient Storage`), and `423 Locked` retry backoff.
- `tests/state.test.ts`:
  - Verify loading, saving, schema migration/fallback on corrupted JSON, upserting, and pruning `SyncStateRecord` entries via mocked `DataAdapter`.
- `tests/engine.test.ts`:
  - Verify all 14 file decision matrix branches (`F1`–`F14`) and all directory branches including `keptFolders` parent preservation when a remote folder is deleted but contains a newly created local file.
  - Verify `newest_wins` and `keep_both` (including identical-byte short-circuit and conflict copy upload/download).
  - Verify 4-phase execution ordering (top-down folder creation, bottom-up deletion, and concurrent transfers).

## 4. Implementation Steps
1. Update `src/types.ts` with the refined interfaces (`LocalItem`, `RemoteItem`, `SyncAction`, `SyncActionType`, `SyncPlan`, `SyncResult`, `SyncStateData`, `SyncStateRecord`, `VaultDavSettings`, `WebDavMethod`, `WebDavRequestOptions`).
2. Implement `src/log.ts` and `src/utilities.ts` with unit tests in `tests/utilities.test.ts`.
3. Implement `src/webdav/xml_parser.ts` using `DOMParser` with unit tests in `tests/xml_parser.test.ts`.
4. Implement `src/webdav/client.ts` using `requestUrl` with unit tests in `tests/client.test.ts`.
5. Implement `src/sync/state.ts` and `src/sync/engine.ts` with unit tests in `tests/state.test.ts` and `tests/engine.test.ts`.
6. Implement `src/settings.ts` and wire plugin commands, ribbon icon, and auto-sync interval in `src/main.ts`.
7. Run `npm run typecheck`, `npm test`, and `npm run build` per `vaultdav-dev-workflow`.
