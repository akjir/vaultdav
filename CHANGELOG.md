# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added
- Add a dockable Sync log view (`vaultdav:open-sync-log` command and `history` ribbon icon) showing latest sync overview metrics, live active `.conflict-*` files with clickable links, chronological run history, category and path filters, copyable Markdown summaries, and two-step history clearing.
- Add device-local sync history persistence (`<config-dir>/plugins/vaultdav/sync-history.json`) with Hybrid Tiered Retention (consecutive no-op run folding, 500-event priority cap per run, configurable `Sync log retention` days from `1` to `365`, 100-run critical-preserving ceiling, and 1 MB storage compaction).
- Capture per-file uploads, downloads, conflict resolution details (`keep_both`, `newest_wins_local`, `newest_wins_remote`, `identical`), deletions, folder creations, plan/walk warnings, and redacted errors on every sync run.
- Show a clickable Desktop status bar error indicator when a sync completes with errors or fails.

### Fixed
- Harden `SyncHistoryStore` with a strict allowlist for history file paths, unified async serialization across `load()`, `recordRun()`, `clear()`, and `save()`, O(N) run/event retention with incremental UTF-8 byte tracking, `stat()` pre-read size checks, safe integer clamping, and `Map`-based event priority lookup.
- Replace the backtracking URL userinfo redaction regex in `redactSensitiveText()` with a linear-time scanner and guard truncated authority prefixes in `sanitizeEventMessage()`.

## [1.2.0] - 2026-11-24

### Added
- Implement dual declarative settings support (`getSettingDefinitions()`, `getControlValue()`, and `setControlValue()`) in `VaultDavSettingTab` for Obsidian 1.13+ settings search while preserving the `display()` fallback for Obsidian 1.11.4 to 1.12.x.

### Changed
- Enforce zero `eslint-plugin-obsidianmd` warnings (`fatal === 0`, `errors === 0`, `warnings === 0`) in `.github/workflows/release.yml` and the `/release` workflow.

### Fixed
- Harden `decodeWebDavHref`, `normalizeVaultPath`, and `isExcludedPath` against backslash/triple-slash URL bypasses, Windows NTFS Alternate Data Stream exclusion bypasses, cross-endpoint href spoofing, and encoded path separator injection.
- Drain in-flight workers before rejecting in `runConcurrent` to prevent orphaned background requests and memory retention on abort.

## [1.1.0] - 2026-11-24

### Added
- Add GitHub Actions workflows for pull request/push verification (`.github/workflows/ci.yml`) and SemVer tag-triggered release publishing (`.github/workflows/release.yml`).
- Generate GitHub build provenance attestations for `main.js` and `manifest.json` in `.github/workflows/release.yml`.

### Changed
- Store Nextcloud app passwords in Obsidian `SecretStorage` via `SecretComponent` instead of plaintext in `data.json`, and raise `minAppVersion` to `1.11.4`.
- Automatically migrate legacy plaintext `appPassword` values from `data.json` into Obsidian `SecretStorage` and scrub legacy password fields and embedded URL credentials on load.
- Fetch app passwords on demand during WebDAV requests without retaining plaintext passwords in `VaultDavSettings` or long-lived `WebDavClient` state, and redact sensitive tokens from logged error stack traces.

### Fixed
- Avoid chained `.setHeading()` on helper calls in settings UI to prevent fatal ESLint crashes in `eslint-plugin-obsidianmd`.
- Include `vitest.config.ts` in `tsconfig.json` for TypeScript Project Service compatibility.
- Use `window`-scoped timers and remove unnecessary type assertions and redundant variable assignments for `eslint-plugin-obsidianmd` compliance.

## [1.0.0] - 2026-11-23

### Added
- Initial release of VaultDAV.
