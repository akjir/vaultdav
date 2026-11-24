# Proposal 010: Sync History Log, Activity Overview, and Retention Strategy

- **Status:** Implemented
- **Date:** 2026-11-24
- **Scope:** `src/types.ts`, `src/utilities.ts`, `src/sync/history.ts`, `src/sync/engine.ts`, `src/ui/sync_log_view.ts`, `src/settings.ts`, `src/main.ts`, `styles.css`, `.gitignore`, `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `tests/history.test.ts`, `tests/sync_log_view.test.ts`, `tests/utilities.test.ts`, `tests/engine.test.ts`, `tests/settings.test.ts`, `tests/main.test.ts`, `tests/obsidian_mock.ts`, `tests/obsidian_linter.test.ts`

## 1. Objective
VaultDAV currently communicates sync outcomes only through a transient `Notice` with aggregate counts and Developer Console warnings. Users cannot inspect which specific files were transferred, deleted, conflicted, skipped, or failed, nor can they see unresolved `.conflict-*` files directly inside Obsidian. This proposal adds a device-local persistent sync history store with a Hybrid Tiered Retention strategy, detailed per-item event capture in `SyncEngine`, and a dockable Obsidian `ItemView` (`SyncLogView`) for both Desktop and Mobile.

## 2. Technical Design
- **Persistence & Exclusions (`src/sync/history.ts`, `src/utilities.ts`):**
  - Store history in `<config-dir>/plugins/vaultdav/sync-history.json` derived dynamically via `Vault#configDir` (`util.getSyncHistoryFilePath(configDir)`), excluded from WebDAV sync in `util.isExcludedPath()`.
  - Implement Hybrid Tiered Retention:
    1. Fold consecutive no-op runs (`collapsedCount`, `firstCollapsedAt`).
    2. Cap events per run at `MAX_EVENTS_PER_RUN = 500` in priority order (`conflict`/`error` > `warning` > deletions > uploads/downloads > folder creations), tracking `omittedEvents` while preserving exact uncapped `summary` totals.
    3. Prune runs older than configurable `syncLogRetentionDays` (`1` to `365`, default `30`).
    4. Cap retained runs at `MAX_HISTORY_RUNS = 100`, evicting oldest non-critical runs before runs containing conflicts, errors, or warnings.
    5. Enforce `MAX_HISTORY_BYTES = 1 MB` UTF-8 ceiling by compacting older runs to summary-only (`detailsPruned: true`) before evicting oldest runs.
  - Redact all error/warning text with `redactSensitiveText()`, truncate messages to `500` characters, strip null-byte padding, validate all fields on load, and serialize writes.
- **Engine Instrumentation (`src/sync/engine.ts`, `src/types.ts`):**
  - Capture `SyncLogEvent` entries for uploads, downloads, conflicts (recording `conflictCopyPath` and resolution mode `keep_both`, `newest_wins_local`, `newest_wins_remote`, or `identical`), deletions, directory creations, plan/walk warnings (file/directory type conflicts, case collisions), and per-item errors.
  - Extend `SyncResult` with `events` and `summary` while preserving existing counters.
- **UI & Lifecycle (`src/ui/sync_log_view.ts`, `src/main.ts`, `src/settings.ts`, `styles.css`):**
  - Implement `SyncLogView extends ItemView` (`vaultdav-sync-log`) using DOM builders (`no-inner-html`, no `h1`-`h6`, no inline styles, strict `ui/sentence-case`, responsive `styles.css` with Obsidian theme variables).
  - Display latest run summary cards, a live in-memory vault scan of active `.conflict-*` files (with clickable links to open the conflict copy and original file), chronological run history, category filters, path filter, copyable Markdown summary, and two-step clear history confirmation.
  - Expose `"Open sync log"` command (`id: "open-sync-log"`), a second ribbon icon (`history`, `"Open sync log"`) for Desktop/Mobile one-tap access, and clickable Desktop status bar text shown only when errors occur (cleared to `""` on clean syncs).
  - Add `"Sync log retention"` (`syncLogRetentionDays`) to both `getSettingDefinitions()` and `display()` in `VaultDavSettingTab`.
  - Never call `detachLeavesOfType` in `onunload()`.

## 3. Verification Plan
- `tests/history.test.ts`: No-op folding, priority event capping, TTL pruning, 100-run critical-run preservation, 1 MB byte compaction and eviction, redaction, corruption recovery, and serialized writes.
- `tests/utilities.test.ts`: `getSyncHistoryFilePath`, `sync-history.json` exclusion, `parseConflictCopyPath`, and `formatByteSize`.
- `tests/engine.test.ts`: Event and summary capture for transfers, all four conflict outcomes, deletions, directories, warnings, and errors.
- `tests/sync_log_view.test.ts`: Rendering, live active conflict detection, filters, file link opening, copy summary, two-step clear, and zero `innerHTML`/inline style mutations.
- `tests/settings.test.ts`, `tests/main.test.ts`, `tests/obsidian_linter.test.ts`: Dual settings support, ribbon icon, command registration, error-only idle status bar, history recording on success/partial/failed runs, and static `eslint-plugin-obsidianmd` compliance.

## 4. Implementation Steps
1. Extend `src/types.ts` and `src/utilities.ts` with sync history types, exclusion path helpers, conflict path parsing, and byte formatting.
2. Implement `src/sync/history.ts` (`SyncHistoryStore` and retention engine) with unit tests in `tests/history.test.ts`.
3. Instrument `src/sync/engine.ts` to emit structured `events` and `summary` on `SyncResult` and `warnings` on `SyncPlan`.
4. Implement `src/ui/sync_log_view.ts` and `styles.css` with unit tests in `tests/sync_log_view.test.ts`.
5. Integrate `SyncHistoryStore`, `SyncLogView`, `"Open sync log"` command, second ribbon icon, error-only idle status bar, and `"Sync log retention"` setting in `src/settings.ts` and `src/main.ts`.
6. Update CI/release workflows, `README.md`, `AGENTS.md`, `CHANGELOG.md`, and run `npm run typecheck`, `npm test`, `npm run build`, and zero-warning `eslint-plugin-obsidianmd`.
