# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added
- Initialize project scaffolding, ESBuild zero-external-dependencies guard, Vitest environment, and core TypeScript interfaces.
- Implement Nextcloud WebDAV client (`PROPFIND` BFS `Depth: 1`, `GET`, `PUT` with `X-OC-Mtime` and ETag fallback, `MKCOL`, `DELETE`, and `423 Locked` retry backoff).
- Implement native `DOMParser` XML parser for WebDAV `207 Multi-Status` responses.
- Implement local sync state store (`sync-state.json`) and 4-phase bidirectional synchronization engine with `keep_both` and `newest_wins` conflict resolution.
- Add plugin settings tab, ribbon trigger, commands (`sync-now`, `test-connection`), and automatic synchronization interval.

### Changed
- Standardize plugin ID and package name to `vaultdav`.
