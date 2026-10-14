# Proposal 002: Security Audit and Hardening

- **Status:** Implemented
- **Date:** 2026-10-14
- **Scope:** `src/utilities.ts`, `src/log.ts`, `src/settings.ts`, `src/main.ts`, `src/webdav/xml_parser.ts`, `src/webdav/client.ts`, `src/sync/state.ts`, `src/sync/engine.ts`, `tests/utilities.test.ts`, `tests/log.test.ts`, `tests/settings.test.ts`, `tests/main.test.ts`, `tests/xml_parser.test.ts`, `tests/client.test.ts`, `tests/state.test.ts`, `tests/engine.test.ts`

## 1. Objective
Conduct a comprehensive Red Team security audit of the VaultDAV codebase across four failure domains: mass data destruction, credential exfiltration, path traversal/jailbreaks, and sync state corruption/infinite loops. Define concrete defensive code refactorings and verification tests to eliminate all identified vulnerabilities before release.

## 2. Technical Design

### 2.1. Existing Resistant Mechanisms
The following mechanisms in `src/` already resist specific attack vectors:

| Attack Vector | Protected Module & Lines | Existing Defense Mechanism |
| :--- | :--- | :--- |
| Root `DELETE`/`PUT`/`GET`/`MKCOL` with `""` or `"/"` | `src/webdav/client.ts:62–65, 80–83, 102–105, 318–321` | Normalizes `path` via `util.normalizeVaultPath(path)` and throws `Error("WebDAV <METHOD> refused on empty root path")` before issuing HTTP requests when the result is `""`. |
| Single-encoded `..` (`%2e%2e`) and prefix collisions in `<d:href>` | `src/utilities.ts:104–151` | `decodeWebDavHref` splits on `/`, runs `decodeURIComponent`, normalizes `\` to `/`, rejects `.` and `..` segments (`return null`), and requires `/` boundaries after `<username>` and `<remoteBaseDir>`. |
| Credential exposure in HTTP 401/403 status errors | `src/webdav/client.ts:190–213, 260` | Passes `throw: false` to `requestUrl` and maps status codes via `formatStatusError` to static strings (`WebDAV <METHOD> <path> failed (401 Unauthorized)`) without echoing request headers. |
| Canonical `<d:href>` cycle deduplication in `walkRemote` | `src/webdav/client.ts:380–381, 401–413` | Tracks `seenPaths` and `visitedDirs` sets by normalized path, preventing infinite loops when a directory `PROPFIND` returns an already-visited canonical `<d:href>`. |
| Concurrent `save()` interleaving in `SyncStateStore` | `src/sync/state.ts:12, 139–152` | Chains `this.savePromise = this.savePromise.then(writeTask, writeTask)` so concurrent `save()` calls on one store instance execute sequentially. |

---

### 2.2. Vulnerability Findings

#### Category A: Mass Data Destruction (`Severity: Critical — Data Loss`)

1. **VULN-01 (Data Loss): Path Traversal Bypass in `normalizeVaultPath` Enables Remote Root / Parent `DELETE`**
   - **File & Lines:** `src/utilities.ts:307–319` (`normalizeVaultPath`), `src/utilities.ts:181–190` (`encodeWebDavPath`), `src/webdav/client.ts:45–53, 79–99` (`buildResourceUrl`, `deleteItem`).
   - **Root Cause:** `util.normalizeVaultPath(path)` only checks `trimmed === "" || trimmed === "/" || trimmed === "."` before calling Obsidian `normalizePath(trimmed)`. Obsidian `normalizePath` converts `\` to `/` and collapses slashes, but does **not** reject `..` or `.` segments. Furthermore, `encodeURIComponent("..")` returns `".."` because `.` is an unreserved URI character.
   - **Exploit Scenario:**
     1. A caller or corrupted sync action invokes `client.deleteItem("..", true)` or `client.deleteItem("../OtherFolder", true)` with `baseUrl = "https://cloud.example.com/remote.php/dav/files/alice/Vault"`.
     2. `util.normalizeVaultPath("..")` returns `".."`, bypassing `if (normalizedPath === "")` at `src/webdav/client.ts:81`.
     3. `buildResourceUrl("..", true)` returns `"https://cloud.example.com/remote.php/dav/files/alice/Vault/../"`.
     4. The runtime URL parser resolves `/Vault/../` to `/remote.php/dav/files/alice/` and issues `DELETE` against the user's Nextcloud root directory.

2. **VULN-02 (Data Loss): Empty or Traversal `remoteBaseDir` Scopes WebDAV Operations to the Nextcloud User Root**
   - **File & Lines:** `src/main.ts:43–55` (`getResolvedSettings`), `src/utilities.ts:41–85` (`buildNextcloudWebDavBaseUrl`), `src/utilities.ts:140–144` (`decodeWebDavHref`), `src/webdav/client.ts:38–42, 119–170` (`constructor`, `ensureRemoteBaseDir`).
   - **Root Cause:** `buildNextcloudWebDavBaseUrl` (`src/utilities.ts:81–83`) returns `userRootUrl` when `encodedBaseDir === ""`, and `decodeWebDavHref` (`src/utilities.ts:142–144`) returns `afterUser` (the entire Nextcloud user root) when `normalizedBase === ""`. In `getResolvedSettings()` (`src/main.ts:43–55`), if `settings.remoteBaseDir` is `""` and `this.app.vault.getName()` normalizes to `""` (for example, `"."`, `"/"`, `".."`, or whitespace), or if `WebDavClient` is instantiated with `remoteBaseDir: ""` or `".."`, `this.baseUrl` points to `/remote.php/dav/files/<user>`. `ensureRemoteBaseDir()` (`src/webdav/client.ts:120`) becomes a no-op because `getFolderLevels("", true)` is `[]`.
   - **Exploit Scenario:**
     1. `settings.remoteBaseDir` resolves to `""` or `".."`.
     2. `walkRemote()` enumerates the user's entire Nextcloud account (`Documents/`, `Photos/`, `Backups/`).
     3. Any previously tracked path absent locally triggers `DELETE` against top-level Nextcloud folders outside the vault.

3. **VULN-03 (Data Loss): Swallowed `adapter.list()` Errors in `walkLocal()` Trigger Mass Remote Deletion**
   - **File & Lines:** `src/sync/engine.ts:747–759, 791–794` (`walkLocal`), `src/sync/engine.ts:174–181, 267–277` (`buildSyncPlan`).
   - **Root Cause:** In `walkLocal()` (`src/sync/engine.ts:750–755`), `this.vault.adapter.list(dirPath)` is wrapped in a `try / catch` block that logs `log.warn` and returns `{ files: [], folders: [] }`.
   - **Exploit Scenario:**
     1. A vault has 1,000 synced files recorded in `sync-state.json`.
     2. During `runSync()`, `adapter.list("")` (or `adapter.list("Notes")`) fails with a transient OS error (`EACCES`, `EIO`, `EBUSY`, or unmounted mobile storage).
     3. `walkLocal()` catches the error and returns `[]` (or omits all children under `"Notes"`).
     4. `buildSyncPlan` evaluates `local === undefined && remote !== undefined && state !== undefined && !isRemoteModified(remote, state)` for every omitted file and emits `delete_remote` actions, deleting the entire remote vault (or `"Notes"` subtree) from Nextcloud.

4. **VULN-04 (Data Loss): Missing Self-Collection Verification in `parseMultiStatus` Causes Mass Local Deletion on Scope or Username Mismatch**
   - **File & Lines:** `src/webdav/xml_parser.ts:74–107` (`parseMultiStatus`), `src/utilities.ts:53–72` (`buildNextcloudWebDavBaseUrl`), `src/utilities.ts:128–137` (`decodeWebDavHref`), `src/sync/engine.ts:254–260` (`buildSyncPlan`).
   - **Root Cause:**
     - `buildNextcloudWebDavBaseUrl` (`src/utilities.ts:53–72`) extracts `rawUserSegment` from `settings.url` if `/remote.php/dav/files/<user>` is present in `url`, ignoring `settings.username`, whereas `listDirectory` passes `settings.username` to `parseMultiStatus`.
     - In `decodeWebDavHref` (`src/utilities.ts:128`), `davPrefix` matching is case-sensitive on `username.trim()`.
     - In `parseMultiStatus` (`src/webdav/xml_parser.ts:86–106`), if a `207 Multi-Status` XML contains `<d:response>` elements but all return `decodeWebDavHref === null` (due to username casing difference, `url` vs `username` mismatch, or proxy rewrite), `parseMultiStatus` does not verify that the queried directory's own `<d:response>` (`parsed.path === normalizedQueriedDir`) was present. It silently returns `[]`.
   - **Exploit Scenario:**
     1. A vault has 1,000 synced files in `sync-state.json`.
     2. Nextcloud returns `<d:href>/remote.php/dav/files/Alice/Vault/...</d:href>` while `settings.username` is `"alice"` (or `settings.url` contains a different user segment).
     3. `listDirectory("")` returns `[]`, so `walkRemote()` returns `[]`.
     4. `buildSyncPlan` (`src/sync/engine.ts:258–259`) sees `local !== undefined && remote === undefined && state !== undefined && !isLocalModified(local, state)` and schedules `delete_local` for every unchanged file in the local vault.

5. **VULN-05 (Data Loss): Unconditional `trashLocal` on Directories in `deleteLocalItem` Deletes Excluded Children**
   - **File & Lines:** `src/sync/engine.ts:345–359` (`deleteLocalItem`).
   - **Root Cause:** In `deleteLocalItem(path, isDirectory)`, lines 350–353 call `this.vault.adapter.trashLocal(path)` before checking `isDirectory`. When `isDirectory` is `true`, `trashLocal(path)` recursively moves the entire directory and any untracked/excluded contents (such as `.git/`, `.DS_Store`, or files created during the sync run) to the trash without verifying that the directory is empty.
   - **Exploit Scenario:**
     1. Local directory `Subproject/` contains an excluded `.git/` folder and `Subproject/readme.md`.
     2. `Subproject/readme.md` and `Subproject/` are deleted on the remote server.
     3. Phase 3 deletes `Subproject/readme.md` and then calls `deleteLocalItem("Subproject", true)`, which invokes `trashLocal("Subproject")` and destroys `Subproject/.git/`.

---

#### Category B: Credential Exfiltration & Code Execution (`Severity: Critical — Credential Leak`)

6. **VULN-06 (Credential Leak): Case-Sensitive and Narrow `isExcludedPath` Allows `data.json` Exfiltration and Plugin Code Overwrite**
   - **File & Lines:** `src/utilities.ts:3–4, 8–18, 22, 269–291` (`isExcludedPath`).
   - **Root Cause:**
     1. `isExcludedPath` checks `normalized === SYNC_STATE_FILE_PATH || normalized === PLUGIN_DATA_FILE_PATH`, `WORKSPACE_FILE_REGEX`, and `IGNORED_SEGMENTS` using case-sensitive comparisons. On case-insensitive filesystems (Windows, macOS, iOS, Android), `.obsidian/plugins/VaultDAV/data.json` or `.obsidian/plugins/vaultdav/Data.json` bypasses `isExcludedPath` (`false`).
     2. Only the exact paths `.obsidian/plugins/vaultdav/data.json` and `.obsidian/plugins/vaultdav/sync-state.json` are excluded. Any backup, temporary, or conflict copy inside `.obsidian/plugins/vaultdav/` (such as `data.json.bak` or `data.conflict-*.json`), any other plugin's `data.json` (`.obsidian/plugins/*/data.json`), and executable plugin code (`.obsidian/plugins/*/main.js`) are not excluded.
   - **Exploit Scenario:**
     1. On macOS or Windows, `.obsidian/plugins/VaultDAV/data.json` (or `.obsidian/plugins/vaultdav/data.json.bak`) is discovered by `walkLocal()`.
     2. `isExcludedPath` returns `false`.
     3. `executeUpload` reads the file and uploads the plaintext Nextcloud `appPassword` to the remote server. Conversely, a compromised remote server serving `.obsidian/plugins/vaultdav/Data.json` or `.obsidian/plugins/vaultdav/main.js` overwrites local plugin configuration or executable code.

7. **VULN-07 (Credential Leak): Cleartext HTTP Basic Auth Transmission and Unredacted Error / Log Output**
   - **File & Lines:** `src/utilities.ts:41–85` (`buildNextcloudWebDavBaseUrl`), `src/log.ts:16–39` (`log`), `src/main.ts:166–171, 209–213` (`testConnection`, `triggerSync`), `src/webdav/xml_parser.ts:219–224` (`parseXmlDocument`).
   - **Root Cause:**
     1. `buildNextcloudWebDavBaseUrl` does not validate the URL protocol or strip URL userinfo (`https://user:password@host`). If `settings.url` uses `http://`, `WebDavClient` transmits `Authorization: Basic <base64>` in cleartext over the network. If `settings.url` includes `user:password@`, the credentials remain embedded in `this.baseUrl`, `RemoteItem.href`, and error messages.
     2. `log.ts` (`debug`, `info`, `warn`, `error`, `notify`) and `main.ts` output raw error messages and objects to `console.*` and Obsidian `Notice` popups without redacting `Basic <base64>` tokens or URL userinfo (`://user:pass@`).
     3. `parseXmlDocument` (`src/webdav/xml_parser.ts:221–223`) embeds unbounded `parserError.textContent` into thrown `Error` messages, leaking raw response bodies into UI notices.
   - **Exploit Scenario:**
     1. A user enters `http://cloud.example.com` or `https://alice:secret-app-pw@cloud.example.com`.
     2. `requestUrl` either transmits the `Authorization` header over unencrypted HTTP or throws a network exception containing the full URL with `alice:secret-app-pw@`.
     3. `testConnection()` / `triggerSync()` passes the unsanitized error to `log.error` and `log.notify`, exposing credentials in console logs and UI notifications.

---

#### Category C: Path Traversal & Jailbreaks (`Severity: High — Path Traversal`)

8. **VULN-08 (Path Traversal): Control Characters (`\0`), Malformed URI Fallback, and Missing Execution-Layer Path Guards**
   - **File & Lines:** `src/utilities.ts:87–152` (`decodeWebDavHref`), `src/utilities.ts:307–319` (`normalizeVaultPath`), `src/sync/engine.ts:335–359, 457–484, 693–716`.
   - **Root Cause:**
     1. `normalizeVaultPath` does not reject `.` or `..` segments, ASCII control characters (`\x00`–`\x1f`, `\x7f`), or Windows drive prefixes (`C:`).
     2. `decodeWebDavHref` (`src/utilities.ts:113–117`) catches `decodeURIComponent(part)` `URIError` exceptions and falls back to `decodedPart = part` instead of returning `null`.
     3. `decodeWebDavHref` (`src/utilities.ts:104–125`) allows percent-encoded null bytes (`%00`) and control characters (`%0a`, `%0d`) into `decodedSegments`.
     4. `decodeWebDavHref` (`src/utilities.ts:93–102`) uses case-sensitive `startsWith("http://") || startsWith("https://")` and slices `rawPathname` by `parsedUrl.origin.length`, which misaligns when the URL contains `user:pass@`.
     5. `SyncEngine` execution methods (`createLocalDirectory`, `deleteLocalItem`, `executeDownload`, `executeUpload`, `executeConflict`) do not validate `!util.isExcludedPath(path)` before calling `this.vault.adapter` or `this.client`.
   - **Exploit Scenario:**
     1. A malicious XML response contains `<d:href>/remote.php/dav/files/alice/Vault/note%00.md</d:href>` or `<d:href>/remote.php/dav/files/alice/Vault/.obsidian/plugins/vaultdav/data.json%00.md</d:href>`.
     2. `decodeWebDavHref` decodes `%00` to `\0`, bypassing exact-match checks in `isExcludedPath` and passing null-byte paths to the filesystem adapter.

9. **VULN-09 (Path Traversal / XML Spoofing): Unscoped Descendant Element Matching and Missing Direct-Child Validation in `xml_parser.ts`**
   - **File & Lines:** `src/webdav/xml_parser.ts:22–66` (`findChildByLocalName`, `findChildrenByLocalName`), `src/webdav/xml_parser.ts:74–107` (`parseMultiStatus`).
   - **Root Cause:**
     1. `findChildByLocalName` and `findChildrenByLocalName` call `parent.getElementsByTagName("*")`, matching descendant elements at any depth instead of direct children (`parent.children`). A nested `<href>`, `<status>`, or `<collection>` inside a custom property can spoof WebDAV response metadata.
     2. `parseMultiStatus` (`src/webdav/xml_parser.ts:95–104`) does not verify `util.getParentPath(parsed.path) === normalizedQueriedDir`. A `Depth: 1` `PROPFIND` for `"Notes/Sub"` accepts `<d:href>` items from unrelated directories (for example, `"Other/File.md"` or ancestor `"Notes"`).
   - **Exploit Scenario:**
     1. During `listDirectory("Notes/Sub")`, a crafted `207 Multi-Status` response includes a `<d:response>` with `<d:href>/remote.php/dav/files/alice/Vault/RootSecret.md</d:href>`.
     2. `parseMultiStatus` returns `"RootSecret.md"` even though it is not a direct child of `"Notes/Sub"`.

---

#### Category D: State Corruption, Race Conditions & Infinite Loops (`Severity: High — State Corruption`)

10. **VULN-10 (State Corruption): Prototype Key Collisions, I/O Error State Wiping, and Mutable State Snapshot in `SyncStateStore`**
    - **File & Lines:** `src/sync/state.ts:11, 21, 47–50, 52–132, 139–152` (`getRecord`, `load`, `save`), `src/sync/engine.ts:64–74` (`buildSyncPlan`).
    - **Root Cause:**
      1. `this.records` is a standard `{}` object inheriting from `Object.prototype`. `store.getRecord("constructor")`, `store.getRecord("toString")`, or `store.getRecord("__proto__")` returns the inherited prototype property instead of `undefined`, causing `executePlan` (`src/sync/engine.ts:526`) to skip state persistence for files or folders matching `Object.prototype` property names, and allowing `"__proto__"` keys in `load()` / `upsertRecord()` to interact with prototype chains.
      2. In `SyncStateStore.load()` (`src/sync/state.ts:62–125`), `this.adapter.read(this.stateFilePath)` is inside the same `try / catch` as `JSON.parse(raw)`. If `sync-state.json` exists but `adapter.read()` fails with a transient filesystem error (`EBUSY`, `EACCES`, `EIO`), `load()` catches the I/O error and resets `this.records = {}`, wiping the entire sync history and causing mass file duplication (`keep_both`) or overwrites (`newest_wins`) on the current sync run. Additionally, leading/trailing null bytes (`\0`) in `raw` are not stripped before `JSON.parse`.
      3. In `SyncStateStore.save()` (`src/sync/state.ts:140–151`), `payload` references `this.records` inside the asynchronous `writeTask` after `await this.ensureParentDirectory()` rather than snapshotting a null-prototype copy `{ ...this.records }`.

11. **VULN-11 (State Corruption): Pre-Reserved `conflictCopyPath` Self-Collision and File/Directory Type Confusion in `SyncEngine`**
    - **File & Lines:** `src/sync/engine.ts:106–191` (`buildSyncPlan`), `src/sync/engine.ts:408–413` (`executeConflict`), `src/sync/engine.ts:498–504` (`executePlan`).
    - **Root Cause:**
      1. `executePlan` (`src/sync/engine.ts:501–503`) adds every planned `action.conflictCopyPath` (for example, `Note.conflict-20261014-190000.md`) into `existingPaths` before Phase 4 starts. Then `executeConflict` (`src/sync/engine.ts:409–410`) checks `!existingPaths.has(action.conflictCopyPath)`. Because `action.conflictCopyPath` is already in `existingPaths`, this check is always `false`, forcing `executeConflict` to discard the planned path and generate `-2` (`Note.conflict-20261014-190000-2.md`) even when only a single conflict exists.
      2. In `buildSyncPlan` (`src/sync/engine.ts:106–110`), `isDirectory` is computed as `directoryPaths.has(path) || Boolean(local?.isDirectory) || Boolean(remote?.isDirectory) || Boolean(state?.isDirectory)`. If a directory in `state` (`state.isDirectory === true`) was deleted and replaced with a file (`local.isDirectory === false`, `remote === undefined`), `isDirectory` evaluates to `true` and lines 158–163 emit `delete_local` (`isDirectory: true`), deleting the new local file.

12. **VULN-12 (Infinite Loop / DoS): Unbounded Directory Depth in `walkLocal` / `walkRemote` and Missing `visitedDirs` in `walkLocal`**
    - **File & Lines:** `src/sync/engine.ts:739–812` (`walkLocal`), `src/webdav/client.ts:378–419` (`walkRemote`).
    - **Root Cause:**
      1. `walkLocal()` does not maintain `visitedDirs` or `seenPaths` sets and enforces no maximum directory depth (`MAX_WALK_DEPTH`). A local symlink cycle (such as `Notes/loop -> ..`) enqueues `Notes/loop/Notes/loop/...` infinitely.
      2. `walkRemote()` deduplicates identical relative paths in `visitedDirs`, but does not enforce `MAX_WALK_DEPTH`. A server-side symlink or bind mount cycle (`Cycle/Cycle/Cycle/...`) generates distinct relative path strings at each depth and loops indefinitely.

---

### 2.3. Hardening Specification

1. **Strict Path & URL Validation (`src/utilities.ts`):**
   - Define module-level constants:
     - `CONTROL_CHAR_REGEX: RegExp = /[\x00-\x1f\x7f]/;`
     - `DRIVE_PREFIX_REGEX: RegExp = /^[a-zA-Z]:/;`
     - `FORBIDDEN_OBJECT_KEYS: ReadonlySet<string> = new Set<string>(["__proto__", "constructor", "prototype"]);`
     - `MAX_WALK_DEPTH: number = 64;`
     - `OBSIDIAN_PLUGINS_PREFIX: string = ".obsidian/plugins/";`
   - **`normalizeVaultPath(path: string): string`:**
     - Return `""` if `CONTROL_CHAR_REGEX.test(path)` is `true`.
     - Replace `\` with `/` before splitting or calling `normalizePath`.
     - Reject (return `""`) if any raw or normalized segment is `"."`, `".."`, matches `DRIVE_PREFIX_REGEX`, or matches `FORBIDDEN_OBJECT_KEYS`.
   - **`isExcludedPath(path: string): boolean`:**
     - Return `true` if `CONTROL_CHAR_REGEX.test(path)` is `true` or if raw `path` contains `.` or `..` segments.
     - Normalize `path` via `normalizeVaultPath(path)`; return `true` if `""`.
     - Perform case-insensitive comparison (`const lower: string = normalized.toLowerCase()`):
       - Return `true` if `lower === SYNC_STATE_FILE_PATH` or `lower === PLUGIN_DATA_FILE_PATH`.
       - Return `true` if `lower.startsWith(OBSIDIAN_PLUGINS_PREFIX)` and (`lower.startsWith(".obsidian/plugins/vaultdav/")` || `lower === ".obsidian/plugins/vaultdav"` || `lower.endsWith("/data.json")` || `lower.endsWith("/sync-state.json")`).
       - Return `true` if `WORKSPACE_FILE_REGEX` (with `/i` flag) matches `lower`.
       - Return `true` if any segment (case-insensitively) matches `IGNORED_SEGMENTS_LOWER` (`.ds_store`, `.git`, `.svn`, `.trash`, `desktop.ini`, `thumbs.db`, `node_modules`).
   - **`buildNextcloudWebDavBaseUrl(url: string, username: string, remoteBaseDir: string): string`:**
     - Parse `url.trim()` with `new URL(...)`. Throw an `Error` if parsing fails, if `parsedUrl.protocol !== "https:"` (require HTTPS), or if `parsedUrl.username !== ""` or `parsedUrl.password !== ""` (reject embedded credentials in URL).
     - Always use `encodeURIComponent(username.trim())` for the Nextcloud user segment; throw if `username.trim() === ""`.
   - **`decodeWebDavHref(href: string, username: string, remoteBaseDir: string): string | null`:**
     - Reject if `CONTROL_CHAR_REGEX.test(href)` is `true`.
     - Handle `^https?:\/\//i` case-insensitively via `new URL(rawPathname)` and extract `parsedUrl.pathname` (while also inspecting the raw path before normalization so unencoded `/../` in full URLs is caught).
     - If `decodeURIComponent(part)` throws `URIError`, return `null` immediately (do not fall back to raw `part`).
     - Reject if `CONTROL_CHAR_REGEX.test(decodedPart)` is `true`.
     - Match `/remote.php/dav/files/<username>` with case-insensitive fallback on `<username>` while still requiring strict `/` or end-of-string boundary.

2. **Log & Notification Redaction (`src/log.ts`, `src/main.ts`):**
   - Add `redactSensitiveText(text: string): string` in `src/log.ts` (using top-level regexes for `Basic\s+[A-Za-z0-9+/=]+` and `([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/\s@]+@`) and apply it to `log.notify` messages and string arguments in `log.debug`, `log.info`, `log.warn`, and `log.error`.
   - In `VaultDavPlugin.getResolvedSettings()` (`src/main.ts:43–55`), if both `settings.remoteBaseDir` and `this.app.vault.getName()` normalize to `""`, fall back to `"VaultDAV"` so `remoteBaseDir` is never empty.

3. **XML Direct-Child & Self-Collection Verification (`src/webdav/xml_parser.ts`, `src/webdav/client.ts`):**
   - Update `findChildByLocalName` and `findChildrenByLocalName` to inspect direct `parent.children` when `parent` is an `Element` (and `doc.documentElement` / direct hierarchy for `Document`), preventing deep descendant tag spoofing.
   - Truncate `parserError.textContent` in `parseXmlDocument` to a maximum of 200 characters.
   - In `parseMultiStatus`:
     - Verify that each non-self item is a direct child of `normalizedQueriedDir` (`util.getParentPath(parsed.path) === normalizedQueriedDir`).
     - If `responses.length > 0` and zero `<d:response>` elements decoded to a valid in-scope path (not even the self-entry `parsed.path === normalizedQueriedDir`), throw `new Error("Invalid WebDAV XML response: no in-scope responses for queried directory")` so `walkRemote()` aborts instead of returning `[]` and triggering mass local deletion.
   - In `WebDavClient`:
     - Throw in `ensureRemoteBaseDir()` if `util.normalizeVaultPath(this.settings.remoteBaseDir) === ""`.
     - In `createDirectory`, `deleteItem`, `downloadFile`, and `uploadFile`, also reject if `util.isExcludedPath(normalizedPath)` is `true`.
     - In `walkRemote()`, enforce `util.getPathDepth(item.path) <= util.MAX_WALK_DEPTH`.

4. **State Hardening & Sync Engine Guards (`src/sync/state.ts`, `src/sync/engine.ts`):**
   - **`SyncStateStore` (`src/sync/state.ts`):**
     - Store records in a null-prototype object (`Object.create(null) as Record<string, SyncStateRecord>`) and check `Object.prototype.hasOwnProperty.call(this.records, normalized)` in `getRecord`.
     - In `load()`, separate `this.adapter.read(this.stateFilePath)` from `JSON.parse(raw)`: if `adapter.read()` throws an I/O error after `exists()` returned `true`, log and rethrow the I/O error so `runSync()` aborts instead of resetting state to `{}`. Strip leading/trailing `\0` null bytes before `JSON.parse`.
   - **`SyncEngine` (`src/sync/engine.ts`):**
     - In `walkLocal()`, rethrow `this.vault.adapter.list(dirPath)` errors instead of returning `{ files: [], folders: [] }`, track `visitedDirs: Set<string>` and `seenPaths: Set<string>`, and enforce `util.getPathDepth(folderPath) <= util.MAX_WALK_DEPTH`.
     - In `buildSyncPlan()`, only treat `path` as a directory (`isDirectory`) when `directoryPaths.has(path) || Boolean(local?.isDirectory) || Boolean(remote?.isDirectory)`, or when `local === undefined && remote === undefined && Boolean(state?.isDirectory)`. If `local !== undefined && remote !== undefined && local.isDirectory !== remote.isDirectory`, skip destructive actions (`noop` with warning) to prevent file/directory type confusion.
     - In `executePlan()` and `executeConflict()`, track `reservedByPlan: Set<string>` separately from `existingPaths` (or remove `action.conflictCopyPath` before checking) so the first conflict uses `action.conflictCopyPath` (`Note.conflict-YYYYMMDD-HHMMSS.md`) while still preventing another concurrent conflict from colliding with it.
     - In `deleteLocalItem(path, isDirectory)`: reject if ` normalizedPath === ""` or `util.isExcludedPath(normalizedPath)`. When `isDirectory` is `true`, if `typeof this.vault.adapter.list === "function"`, verify the directory has no remaining files or folders before calling `trashLocal(normalizedPath)` (or use `rmdir(normalizedPath, false)`).

## 3. Verification Plan
- `tests/utilities.test.ts`:
  - Verify `normalizeVaultPath` rejects `".."`, `"."`, `"../secret.md"`, `"a/../../b"`, `"note\0.md"`, `"C:/Windows"`, and `"__proto__"`.
  - Verify `isExcludedPath` blocks case variations (`".obsidian/plugins/VaultDAV/data.json"`, `".obsidian/plugins/vaultdav/DATA.JSON"`, `".OBSIDIAN/workspace.json"`), plugin folder artifacts (`".obsidian/plugins/vaultdav/main.js"`, `".obsidian/plugins/vaultdav/data.json.bak"`, `".obsidian/plugins/other/data.json"`), and null-byte paths.
  - Verify `buildNextcloudWebDavBaseUrl` throws on `http://` (non-HTTPS), throws on embedded URL credentials (`https://alice:secret@cloud.example.com`), and rejects empty usernames.
  - Verify `decodeWebDavHref` returns `null` on `%00` null bytes, malformed percent-encoding (`%E0%A4%A`), and handles uppercase `HTTPS://` URLs and case-insensitive username matching.
- `tests/log.test.ts`:
  - Verify `log.notify` and `log.error` redact `Basic <base64>` headers and `https://user:password@host` URLs.
- `tests/xml_parser.test.ts`:
  - Verify `parseMultiStatus` rejects `<d:response>` entries that are not direct children of `queriedDirPath`.
  - Verify `parseMultiStatus` throws when a non-empty `207 Multi-Status` XML has zero valid in-scope responses (preventing silent `[]` return).
  - Verify `findChildByLocalName` ignores spoofed `<d:href>` or `<d:status>` tags nested inside `<d:prop>`.
- `tests/client.test.ts`:
  - Verify `deleteItem("..", true)`, `deleteItem("a/../..", false)`, and `uploadFile(".obsidian/plugins/vaultdav/data.json", ...)` are rejected without network calls.
  - Verify `ensureRemoteBaseDir()` throws when `remoteBaseDir` is `""` or `".."`.
  - Verify `walkRemote()` stops traversing directories deeper than `MAX_WALK_DEPTH`.
- `tests/state.test.ts`:
  - Verify `getRecord("constructor")`, `getRecord("toString")`, and `getRecord("__proto__")` return `undefined`.
  - Verify `load()` strips `\0` padding around valid JSON, resets to `{}` on corrupt JSON syntax, and rethrows when `adapter.read()` fails with an I/O error (`EIO` / `EACCES`).
- `tests/engine.test.ts`:
  - Verify `walkLocal()` rethrows `adapter.list()` OS errors so `runSync()` aborts before `buildSyncPlan` can issue `delete_remote` commands (updating the previous error-swallowing test at `tests/engine.test.ts:648–710`).
  - Verify `walkLocal()` deduplicates cyclic folders and enforces `MAX_WALK_DEPTH`.
  - Verify `executeConflict()` uses the primary `Note.conflict-YYYYMMDD-HHMMSS.md` path for the planned conflict and `-2` for a concurrent duplicate conflict (updating `tests/engine.test.ts:849–850`).
  - Verify `deleteLocalItem(dirPath, true)` refuses to trash a directory that still contains excluded files (such as `.git`).

## 4. Implementation Steps
1. Harden `src/utilities.ts` (`normalizeVaultPath`, `isExcludedPath`, `buildNextcloudWebDavBaseUrl`, `decodeWebDavHref`, `MAX_WALK_DEPTH`) and add unit tests in `tests/utilities.test.ts`.
2. Add credential and URL userinfo redaction in `src/log.ts` and fallback `remoteBaseDir` guard in `src/main.ts`, and update `tests/log.test.ts` and `tests/main.test.ts`.
3. Harden `src/webdav/xml_parser.ts` (direct-child element lookup, direct-child path validation, non-empty response scope verification, bounded error message) and `src/webdav/client.ts` (non-empty `remoteBaseDir` check, excluded-path rejection, `MAX_WALK_DEPTH`), and update `tests/xml_parser.test.ts` and `tests/client.test.ts`.
4. Harden `src/sync/state.ts` (null-prototype record map, `hasOwnProperty` lookup, `\0` sanitization, rethrowing `adapter.read` I/O errors) and update `tests/state.test.ts`.
5. Harden `src/sync/engine.ts` (abort `walkLocal` on `adapter.list` errors, cycle/depth guards in `walkLocal`, file-vs-directory type conflict guard in `buildSyncPlan`, `conflictCopyPath` reservation fix, non-empty directory check in `deleteLocalItem`) and update `tests/engine.test.ts`.
6. Run `npm run typecheck`, `npm test`, and `npm run build` per `vaultdav-dev-workflow`.
