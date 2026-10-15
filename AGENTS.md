# VaultDAV AI Assistant Rules

> [!IMPORTANT]
> Update this file when the architecture or file names change.

- **Goal:** Synchronize Obsidian vaults bidirectionally with Nextcloud via WebDAV.
- **Zero External Dependencies:** Prohibit all runtime, peer, and optional dependencies (`package.json` must never contain `dependencies`, `peerDependencies`, or `optionalDependencies`). Restrict `devDependencies` strictly to `esbuild`, `happy-dom`, `obsidian`, `typescript`, and `vitest`. In `src/`, allow imports exclusively from `"obsidian"` and relative local modules (`./`, `../`). Prohibit all native Node.js modules (`fs`, `path`, `http`, `crypto`, `node:*`) and third-party npm packages.
- **Core Rules:** Support Desktop and Mobile (`isDesktopOnly: false`). Support Nextcloud WebDAV only (no S3, Dropbox, OneDrive, or Google Drive). Edit modular files in `src/`. NEVER edit the bundled `main.js` directly.
- **Version Control:** NEVER commit changes unless the user explicitly instructs you to do so.
- **Language & Tone:** Write all responses, code, comments, documentation, tests, skills, and commits in English. Follow ASD-STE100 (80%). Be concise and precise. Do not use emojis.
- **Style:** Indent with 4 spaces. Remove trailing spaces. Sort functions and methods alphabetically. Avoid globals. Initialize all variables explicitly (do not leave them implicitly `undefined`). Prohibit the `any` type. Define static `Set`, `Map`, and `RegExp` instances at module top-level (`UPPER_SNAKE_CASE`), never inside functions called per-file or per-request.
- **Reqs:** TypeScript 5.x (`strict: true`, `noImplicitAny: true`, `strictNullChecks: true`), ESBuild, Obsidian API (`>=1.5.0`).
- **Testing (TDD):** Write comprehensive tests in `tests/` for every new feature, logic branch, XML parser routine, sync state transition, or bug fix.
- **Docs & Metadata:** Keep `README.md`, `manifest.json`, and `versions.json` in sync with code changes per **`update-documentation`**.
- **Changelog:** Follow **`vaultdav-dev-workflow`** rules for `CHANGELOG.md`.
- **Efficiency:** Optimize for token efficiency. Avoid redundant information across code, docs, rules, and skills.

## Architecture & Naming
- `src/main.ts`: Plugin lifecycle (`onload`, `onunload`), commands, ribbon icon, status bar progress (`ProgressReporter`), auto-sync interval registration.
- `src/settings.ts`: `VaultDavSettingTab` and settings persistence (`URL`, `username`, `appPassword`, `remoteBaseDir`, `syncInterval`, `conflictStrategy`, `chunkingThresholdMB`, `chunkSizeMB`).
- `src/types.ts`: Strict TypeScript interfaces and type definitions (`VaultDavSettings`, `ProgressReporter`, `RemoteItem`, `SyncStateRecord`, `SyncAction`, `SyncPlan`).
- `src/log.ts`: `log.*` logging utilities (includes `log.debugEnabled`), `formatTransferProgress`, and user notifications via Obsidian `Notice`.
- `src/utilities.ts`: `util.*` helper functions (path normalization via Obsidian `normalizePath`, Base64 encoding, concurrency queue).
- `src/webdav/client.ts`: WebDAV protocol client (`PROPFIND`, `GET`, `PUT`, `MKCOL`, `MOVE`, `DELETE`, Nextcloud OC-Chunked uploads, parallel `Range` downloads).
- `src/webdav/xml_parser.ts`: Native `DOMParser` routines for WebDAV `207 Multi-Status` XML responses (`d:href`, `d:getlastmodified`, `d:getcontentlength`, `d:getetag`, `d:resourcetype`).
- `src/sync/state.ts`: Local metadata index persistence (`localMtime`, `remoteMtime`, `etag`, `size`, `lastSyncTime`) to track deletions (tombstones) and modifications.
- `src/sync/engine.ts`: Bidirectional delta calculation, conflict resolution (`keep_both` or `newest_wins`), threshold-based chunked transfer routing, and rate-limited execution queue.

## Technical Constraints
- **Network & CORS:** Execute all HTTP/WebDAV requests exclusively via Obsidian `requestUrl`. Do not use `fetch`, `XMLHttpRequest`, or external HTTP libraries.
- **Binary Safety:** Transfer all file payloads (`GET` and `PUT`) as `ArrayBuffer` with `Content-Type: application/octet-stream` to prevent encoding corruption.
- **File System:** Execute all local file operations via `app.vault.adapter` (`DataAdapter`) and `app.vault`.
- **Authentication:** Use HTTP Basic Auth (`Authorization: Basic <base64>`) with Nextcloud username and App Password against `https://<domain>/remote.php/dav/files/<user>/<remote-base-dir>/`.
- **Concurrency & Locks:** Limit parallel WebDAV transfers (max 3-5 concurrent requests) to prevent Nextcloud rate limits and `423 Locked` (`Sabre\DAV\Exception\Locked`) errors.
- **Exclusions:** Exclude the local sync state file, plugin data file, `.obsidian/workspace*.json`, and `.trash/` from synchronization to prevent infinite sync loops.
- **Zero Hot-Path Allocations:** Define static `Set`, `Map`, and `RegExp` instances at module top-level (`UPPER_SNAKE_CASE`), never inside functions called per-file or per-request.
- **Strict Path Boundary & Traversal Safety:** Always verify `/` or end-of-string boundaries when stripping URL/path prefixes. Reject any path containing `.` or `..` segments.
- **Defensive Numeric Guards:** Validate numeric inputs (`timestamp`, `mtime`, `size`, `concurrency`) with `Number.isFinite()` before arithmetic or `Date` construction.

## Obsidian Plugin Linter Rules (eslint-plugin-obsidianmd)
- **`no-inner-html`:** Never use `innerHTML`, `outerHTML`, or `insertAdjacentHTML`. Always use Obsidian's `containerEl.empty()`, `createEl()`, `createDiv()`, or `Setting`.
- **`ui/sentence-case`:** Use strict Sentence case for all UI strings (`Setting.setName`, `Setting.setDesc`, `setButtonText`, command `name`, ribbon tooltip, `Notice`). Capitalize only the first word and proper nouns/acronyms (`Nextcloud`, `WebDAV`, `HTTP`, `URL`). Never use Title Case (write `"App password"`, `"Remote base directory"`, `"Sync interval"`, `"Conflict strategy"`, `"Test connection"`).
- **`settings-tab/no-manual-html-headings` & `no-problematic-settings-headings`:** Never create `<h1..h6>` elements manually in `PluginSettingTab`. If headings are needed, use `new Setting(containerEl).setName("...").setHeading()` and never include `"VaultDAV"` or `"settings"` in the heading text.
- **`commands/no-plugin-id-in-command-id` & `no-plugin-name-in-command-name` & `no-default-hotkeys`:** Never prefix command `id` with `vaultdav`, never include `VaultDAV` in command `name`, and never define default `hotkeys`.
- **`detach-leaves` & Lifecycle Hygiene:** Never call `detachLeavesOfType` in `onunload()`. Always wrap intervals in `this.registerInterval(window.setInterval(...))` and events in `this.registerEvent(...)`.

## Workflows
- Proposals: Use **`proposal-workflow`** to manage `.agents/proposals/`.
- Development & Build: Use **`vaultdav-dev-workflow`** to build, test, and develop.
- Security Audit: Use **`red`** (`/red`, `/red <filename>`, or `/red all`) to audit and harden `src/`.
- Documentation: Use **`update-documentation`** to update `README.md`, `manifest.json`, and `versions.json`.
- Release: Use **`release`** (`/release <X.Y.Z>` or `/release v<X.Y.Z>`) to create official releases.
