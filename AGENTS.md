# VaultDAV AI Assistant Rules

> [!IMPORTANT]
> Update this file when the architecture or file names change.

- **Goal:** Synchronize Obsidian vaults bidirectionally with Nextcloud via WebDAV.
- **Zero External Dependencies:** Prohibit all runtime, peer, and optional dependencies (`package.json` must never contain `dependencies`, `peerDependencies`, or `optionalDependencies`). Restrict `devDependencies` strictly to `esbuild`, `happy-dom`, `obsidian`, `typescript`, and `vitest`. In `src/`, allow imports exclusively from `"obsidian"` and relative local modules (`./`, `../`). Prohibit all native Node.js modules (`fs`, `path`, `http`, `crypto`, `node:*`) and third-party npm packages.
- **Core Rules:** Support Desktop and Mobile (`isDesktopOnly: false`). Support Nextcloud WebDAV only (no S3, Dropbox, OneDrive, or Google Drive). Edit modular files in `src/`. NEVER edit the bundled `main.js` directly.
- **Version Control:** NEVER commit changes unless the user explicitly instructs you to do so.
- **Language & Tone:** Write all responses, code, comments, documentation, tests, skills, and commits in English. Follow ASD-STE100 (80%). Be concise and precise. Do not use emojis.
- **Style:** Indent with 4 spaces. Remove trailing spaces. Sort functions and methods alphabetically. Avoid globals. Initialize all variables explicitly (do not leave them implicitly `undefined`). Prohibit the `any` type. Define static `Set`, `Map`, and `RegExp` instances at module top-level (`UPPER_SNAKE_CASE`), never inside functions called per-file or per-request.
- **Reqs:** TypeScript 5.x (`strict: true`, `noImplicitAny: true`, `strictNullChecks: true`), ESBuild, Obsidian API (`>=1.11.4`).
- **Testing (TDD):** Write comprehensive tests in `tests/` for every new feature, logic branch, XML parser routine, sync state transition, or bug fix.
- **Docs & Metadata:** Keep `README.md`, `manifest.json`, and `versions.json` in sync with code changes per **`update-documentation`**.
- **Changelog:** Follow **`vaultdav-dev-workflow`** rules for `CHANGELOG.md`.
- **Efficiency:** Optimize for token efficiency. Avoid redundant information across code, docs, rules, and skills.

## Architecture & Naming
- `src/main.ts`: Plugin lifecycle (`onload`, `onunload`), commands, ribbon icons (sync and sync log), status bar progress and error-only idle indicator (`ProgressReporter`), `SyncLogView` registration, auto-sync interval registration.
- `src/settings.ts`: `VaultDavSettingTab` (dual declarative `getSettingDefinitions()` for Obsidian `>=1.13.0` and `display()` fallback for `1.11.4`–`1.12.x`) and settings persistence (`url`, `username`, `appPasswordSecret` via `SecretComponent` / declarative `secret` control, `remoteBaseDir`, `syncInterval`, `conflictStrategy`, `chunkingThresholdMB`, `chunkSizeMB`, `syncLogRetentionDays`).
- `src/types.ts`: Strict TypeScript interfaces and type definitions (`VaultDavSettings`, `WebDavClientConfig`, `ProgressReporter`, `RemoteItem`, `SyncStateRecord`, `SyncAction`, `SyncPlan`, `SyncResult`, `SyncLogEvent`, `SyncRunSummary`, `SyncRunRecord`, `SyncHistoryData`).
- `src/log.ts`: `log.*` logging utilities (includes `log.debugEnabled`), `formatTransferProgress`, and user notifications via Obsidian `Notice`.
- `src/utilities.ts`: `util.*` helper functions (path normalization via Obsidian `normalizePath`, conflict copy path generation/parsing, byte-size formatting, Base64 encoding, concurrency queue).
- `src/webdav/client.ts`: WebDAV protocol client (`PROPFIND`, `GET`, `PUT`, `MKCOL`, `MOVE`, `DELETE`, Nextcloud OC-Chunked uploads, parallel `Range` downloads).
- `src/webdav/xml_parser.ts`: Native `DOMParser` routines for WebDAV `207 Multi-Status` XML responses (`d:href`, `d:getlastmodified`, `d:getcontentlength`, `d:getetag`, `d:resourcetype`).
- `src/sync/state.ts`: Local metadata index persistence (`localMtime`, `remoteMtime`, `etag`, `size`, `lastSyncTime`) to track deletions (tombstones) and modifications.
- `src/sync/history.ts`: Device-local sync history store (`<config-dir>/plugins/vaultdav/sync-history.json`) with Hybrid Tiered Retention (consecutive no-op folding, 500-event priority cap per run, configurable TTL, 100-run critical-preserving cap, 1 MB compaction ceiling).
- `src/sync/engine.ts`: Bidirectional delta calculation, conflict resolution (`keep_both` or `newest_wins`), threshold-based chunked transfer routing, structured sync event capture, and rate-limited execution queue.
- `src/ui/sync_log_view.ts` & `styles.css`: Dockable Obsidian `ItemView` displaying latest sync overview, live active `.conflict-*` files, chronological run history, category/path filters, copyable Markdown summary, and two-step clear history.

## Technical Constraints
- **Network & CORS:** Execute all HTTP/WebDAV requests exclusively via Obsidian `requestUrl`. Do not use `fetch`, `XMLHttpRequest`, or external HTTP libraries.
- **Binary Safety:** Transfer all file payloads (`GET` and `PUT`) as `ArrayBuffer` with `Content-Type: application/octet-stream` to prevent encoding corruption.
- **File System:** Execute all local file operations via `app.vault.adapter` (`DataAdapter`) and `app.vault`.
- **Authentication:** Use HTTP Basic Auth (`Authorization: Basic <base64>`) with Nextcloud username and an App Password retrieved on demand from Obsidian `SecretStorage` (`app.secretStorage`, never persisted in plaintext in `data.json`) against `https://<domain>/remote.php/dav/files/<user>/<remote-base-dir>/`.
- **Concurrency & Locks:** Limit parallel WebDAV transfers (max 3-5 concurrent requests) to prevent Nextcloud rate limits and `423 Locked` (`Sabre\DAV\Exception\Locked`) errors.
- **Exclusions:** Synchronize vault content only. Exclude the entire `<config-dir>` directory (using `Vault#configDir`, never hardcoding `.obsidian`), all hidden dot-files and dot-folders (for example `.trash/`, `.git/`, `.svn/`, `.DS_Store`), `node_modules/`, `Thumbs.db`, and `desktop.ini`.
- **Zero Hot-Path Allocations:** Define static `Set`, `Map`, and `RegExp` instances at module top-level (`UPPER_SNAKE_CASE`), never inside functions called per-file or per-request.
- **Strict Path Boundary & Traversal Safety:** Always verify `/` or end-of-string boundaries when stripping URL/path prefixes. Reject any path containing `.` or `..` segments.
- **Defensive Numeric Guards:** Validate numeric inputs (`timestamp`, `mtime`, `size`, `concurrency`) with `Number.isFinite()` before arithmetic or `Date` construction.

## Obsidian Plugin Linter Rules (eslint-plugin-obsidianmd)
- **`validate-manifest`:** Keep required `id`, `name`, `version`, `minAppVersion`, `description`, and `author` fields valid (`description` <= 250 chars, starts with an action verb, ends with `.`, no `"Obsidian"`/`"plugin"`/emojis; omit `fundingUrl` when unused).
- **`hardcoded-config-path`:** Never hardcode `.obsidian` in `src/`. Always derive config paths dynamically from `Vault#configDir`.
- **`no-unsupported-api`:** Guard APIs newer than `minAppVersion` (such as `SettingGroup` `@since 1.11.0`) behind `requireApiVersion("X.Y.Z")`.
- **`no-inner-html`:** Never use `innerHTML`, `outerHTML`, or `insertAdjacentHTML`. Always use Obsidian's `containerEl.empty()`, `createEl()`, `createDiv()`, or `Setting`.
- **`no-console`, `no-control-regex`, `no-constant-condition`, `regex-lookbehind`, `platform`:** Prohibit `console.log`/`console.info` (allow only `warn`, `error`, `debug`), control-character regex literals, `while (true)`, regex lookbehinds, and `navigator.platform`/`navigator.userAgent` in `src/`.
- **`ui/sentence-case`:** Use strict Sentence case for all UI strings (`Setting.setName`, `Setting.setDesc`, `setButtonText`, `setPlaceholder`, `addOption`, command `name`, ribbon tooltip, `Notice`). Capitalize only the first word and proper nouns/acronyms (`Nextcloud`, `WebDAV`, `HTTP`, `URL`, `MB`). Never use Title Case (write `"App password"`, `"Remote base directory"`, `"Sync interval"`, `"Conflict strategy"`, `"Test connection"`).
- **`settings-tab/*`:** Implement dual support (`getSettingDefinitions()` for Obsidian `>=1.13.0` and `display()` fallback while `minAppVersion < 1.13.0`) to satisfy `prefer-setting-definitions` and `require-display`. Never create `<h1..h6>` elements manually in `PluginSettingTab`. If headings are needed, use `new Setting(containerEl).setName("...").setHeading()` and never include `"VaultDAV"`, `"general"`, `"options"`, or `"settings"` in the heading text.
- **`commands/no-plugin-id-in-command-id` & `no-plugin-name-in-command-name` & `no-default-hotkeys`:** Never prefix command `id` with `vaultdav`, never include `VaultDAV` in command `name`, and never define default `hotkeys`.
- **`detach-leaves` & Lifecycle Hygiene:** Never call `detachLeavesOfType` in `onunload()`. Always wrap intervals in `this.registerInterval(window.setInterval(...))` and events in `this.registerEvent(...)`.

## Workflows
- Proposals: Use **`proposal-workflow`** to manage `.agents/proposals/`.
- Development & Build: Use **`vaultdav-dev-workflow`** to build, test, and develop.
- Security Audit: Use **`red`** (`/red`, `/red <filename>`, or `/red all`) to audit and harden `src/`.
- Documentation: Use **`update-documentation`** to update `README.md`, `manifest.json`, and `versions.json`.
- Commit: Use **`commit`** (`/commit [force] [push] [<message>]`) to verify, stage, commit, and optionally push changes.
- Release: Use **`release`** (`/release <X.Y.Z>`) to lint, tag (`X.Y.Z`, no leading `v`), push, and verify attested GitHub releases via `gh`.
