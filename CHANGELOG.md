# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

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
