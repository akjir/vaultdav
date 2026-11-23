# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Changed
- Group related settings (`Server URL` / `Username` / `App password` / `Remote base directory`, `Sync interval` / `Conflict strategy`, `Test connection`, and `Advanced sync` options) into `SettingGroup` blocks gated by `requireApiVersion("1.11.0")` with fallback support for older Obsidian versions.
- Derive sync state paths and config directory exclusions dynamically from `Vault#configDir` instead of hardcoding `.obsidian`.
- Add required `author` and `authorUrl` fields to `manifest.json`, align `description` with Obsidian Community Directory guidelines, and document iOS TLS and privacy requirements in `README.md`.
- Enforce strict Sentence case on remaining settings descriptions and placeholders (`HTTP basic authentication`, `Enter username`) and route `log.info` through `console.debug` for `no-console` compliance.
- Optimize mobile memory and large-vault sync performance by allocating chunked download buffers lazily (zero-copy HTTP `200`/single-chunk fast path), eliminating `O(C * N)` conflict path scans and redundant path normalization in `buildSyncPlan()`/`executePlan()`, running `adapter.stat()` concurrently in `walkLocal()`, and avoiding full record-map cloning during `SyncStateStore.save()`.

### Fixed
- Replace control-character regex literals (`no-control-regex`) and `while (true)` loops (`no-constant-condition`) with `charCodeAt` checks and bounded loops.
- Update the `/release` skill to tag releases as `X.Y.Z` without a `v` prefix for Obsidian Community Plugin compatibility.
- Refresh sync state records on equal-metadata `noop` branches (`F5`) so subsequent deletions and edits do not resurrect files or trigger false conflicts.
- Verify remote directories are empty via `PROPFIND Depth: 1` before issuing recursive WebDAV `DELETE`.
- Resolve remote path and parent directory casing on uploads, conflict copies, remote directory creations, and remote deletions to prevent `409 Conflict` errors and duplicate files on case-sensitive Nextcloud servers.
- Clamp and sanitize persisted settings in `loadSettings()`, `configureAutoSync()`, and `WebDavClient` (cap `chunkingThresholdMB` at `512` MB, guard `chunkSizeMB` multiplication against `Infinity`, reject `:` in usernames), serialize `saveSettings()` writes, and guard mobile `addStatusBarItem()` against `undefined`.
- Validate response `ETag` and `Content-Range` headers during chunked downloads, short-circuit HTTP `200` fallback after the first request, increase chunk assembly `MOVE` timeout without retrying client-timed-out assemblies, and reject control-character whitespace in WebDAV root-path checks.
- Support `/remote.php/dav` and `/remote.php/webdav` server URL inputs, redact case-insensitive `Basic` tokens and `@`-containing userinfo without corrupting query strings, omit invalid `mtime: 0`/`ctime` write options, index `SyncStateStore` lookups in `O(1)`, and handle Linux Unicode NFD paths during local vault traversal.
- Canonicalize remote child paths under existing local folder casing and resolve local NFD write paths in `executeDownload()`, `executeConflict()`, and `createLocalDirectory()` to prevent duplicate folders and subsequent remote deletions on case-sensitive or NFD Linux filesystems.
- Abort queued workers immediately on failure in `util.runConcurrent()`, suppress late chunked-download progress callbacks after failure or `200 OK` fallback, treat HTTP `504 Gateway Timeout` on chunk assembly `MOVE` identically to client-side timeouts, and prevent leaked auto-sync timers when `onunload()` runs during in-flight `saveSettings()` or `onload()`.

## [0.1.0] - 2026-10-15

### Added
- Initialize project scaffolding, ESBuild zero-external-dependencies guard, Vitest environment, and core TypeScript interfaces.
- Implement Nextcloud WebDAV client (`PROPFIND` BFS `Depth: 1`, `GET`, `PUT` with `X-OC-Mtime` and ETag fallback, `MKCOL`, `DELETE`, and `423 Locked` retry backoff).
- Implement native `DOMParser` XML parser for WebDAV `207 Multi-Status` responses.
- Implement local sync state store (`sync-state.json`) and 4-phase bidirectional synchronization engine with `keep_both` and `newest_wins` conflict resolution.
- Add plugin settings tab, ribbon trigger, commands (`sync-now`, `test-connection`), and automatic synchronization interval.
- Add `VaultDavPlugin` lifecycle, `VaultDavSettingTab`, and static `eslint-plugin-obsidianmd` compliance unit tests (`tests/main.test.ts`, `tests/settings.test.ts`, `tests/obsidian_linter.test.ts`).
- Add Nextcloud OC-Chunked upload protocol (`MKCOL` / `PUT` / `MOVE`) for large files, parallel HTTP `Range` downloads (`Uint8Array.set()`), configurable chunk threshold/size settings (`chunkingThresholdMB`, `chunkSizeMB`), and real-time Obsidian status bar transfer progress (`ProgressReporter`).

### Changed
- Standardize plugin ID and package name to `vaultdav`.
- Move static `Set` and `RegExp` instances to module scope to eliminate hot-path allocations.
- Refactor `VaultDavSettingTab` to clear the DOM via `containerEl.empty()`, enforce strict Obsidian Sentence case labels, disable mobile auto-capitalization and spellcheck on technical inputs, normalize `remoteBaseDir`, and guard `Test connection` against concurrent clicks.
- Refine `VaultDavPlugin` to sanitize loaded settings defensively, normalize `remoteBaseDir` fallback paths, prevent redundant auto-sync timer resets, and enforce strict Sentence case tooltips and notices.
- Refactor `SyncStateStore` to serialize concurrent writes, cache parent directory checks, normalize ETags on load, and write compact JSON.

### Fixed
- Prevent `/remote.php/dav/files/` duplication when the configured Nextcloud URL omits the trailing username segment.
- Enforce strict username segment boundaries and reject `.` and `..` path traversal segments in WebDAV `href` decoding and sync state records.
- Exclude `.trash/` from synchronization while allowing `.github/` and `.gitlab/` vault directories.
- Guard timestamps, file sizes, modification times, notice durations, and concurrency limits with `Number.isFinite()`.
- Harden WebDAV XML parsing to reject `<!DOCTYPE`/`<!ENTITY` declarations, oversized XML payloads (`MAX_XML_BODY_LENGTH`), empty `multistatus` responses, non-directory self-entries, traversal path arguments, and unsafe integer sizes (`Number.isSafeInteger`), while resolving non-empty properties across multiple `200` `propstat` blocks.
- Harden `WebDavClient` with root-path and excluded-path guards across all operations, immutable settings snapshots, `ensureRemoteBaseDir` retry and directory verification, chunked download range/size validation (`MAX_CHUNKED_FILE_SIZE_BYTES`), aborted chunked upload `DELETE` cleanup, precomputed Basic auth headers, non-empty ETag header extraction, and BFS cycle/duplicate protection in `walkRemote`.
- Harden `SyncEngine` to batch state saves after concurrent transfer phases, abort local directory traversal on OS read errors to prevent mass remote deletion, enforce cycle and depth limits (`MAX_WALK_DEPTH`), guard against file/directory type confusion, verify directories are empty before trashing locally, normalize and deduplicate `conflictCopyPath` case-insensitively, enforce pre-flight 1 GB file size limits (`MAX_CHUNKED_FILE_SIZE_BYTES`) and `chunkingThresholdMB` bounds, compute directory execution depths via `getPathDepth`, and abort ancestor directory deletions when child items or deletions remain.
- Harden path, URL, logging, XML, and state security: require HTTPS without embedded URL credentials or query strings, validate first-match `/remote.php/dav/files/<user>` segment boundaries in `decodeWebDavHref`, reject traversal `remoteBaseDir`/`username` inputs and Windows trailing dot/space segment smuggling, bound `getConflictPath` timestamps to valid ECMAScript `Date` ranges, redact `Basic` auth tokens and URL userinfo in logs and notices, enforce case-insensitive plugin exclusion rules, restrict XML lookup to direct children and in-scope responses, and isolate `SyncStateStore` records in a null-prototype map with I/O error propagation.
- Guard against mobile OOM crashes (`MAX_FILE_SIZE_BYTES`), sub-second `mtime`/ETag upload loops, transient HTTP `425`/`429`/`503`/`504` server overloads, and cross-platform case-sensitivity/Unicode `NFC` collisions.
- Harden `VaultDavSettingTab` and `DEFAULT_SETTINGS`: freeze default settings, cap `syncInterval`, `chunkingThresholdMB`, and `chunkSizeMB` to prevent 32-bit timer overflow and mobile OOM, reject excluded `remoteBaseDir` paths, strip embedded URL credentials, and reject control/colon characters in credential fields.
- Harden `SyncStateStore`: validate `stateFilePath` against root, traversal, `data.json`, and non-excluded vault paths; replace null-padding regex with $O(N)$ linear trimming and enforce `MAX_FILE_SIZE_BYTES`; return defensive clones from `getRecord`, `getAll`, and `load`; reject JSON array type confusion; clamp timestamps and sizes to safe integer bounds; and deduplicate concurrent directory creation and save/load promises.
