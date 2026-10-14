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
- Harden WebDAV XML parsing to validate the `multistatus` root element, support `HTTP/2 200` status lines and multi-`propstat` `200` blocks, deduplicate response paths, and eliminate hot-path child lookup allocations.
- Harden `WebDavClient` with root-path mutation guards, retry and directory verification in `ensureRemoteBaseDir`, precomputed Basic auth headers, non-empty ETag header extraction, and BFS cycle/duplicate protection in `walkRemote`.
