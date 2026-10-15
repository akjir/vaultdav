# Proposal 005: Selective Sync and .vaultdavignore

- **Status:** Draft
- **Date:** 2026-10-15
- **Scope:** `src/types.ts`, `src/settings.ts`, `src/utilities.ts`, `src/sync/state.ts`, `src/sync/engine.ts`, `src/main.ts`, `tests/obsidian_mock.ts`, `tests/utilities.test.ts`, `tests/settings.test.ts`, `tests/engine.test.ts`

## 1. Objective
`util.isExcludedPath()` currently blocks only static system paths (`.git`, `.trash`, `node_modules`, `.obsidian/workspace*.json`, and plugin state files). Users with large local media folders, PDFs, or Excalidraw backups cannot exclude specific directories or file types from cloud synchronization. This proposal adds user-defined ignore patterns via plugin settings and an optional root `.vaultdavignore` file, compiled once into memory and enforced across local and remote traversal.

## 2. Technical Design

### 2.1. Settings and Ignore File Specification (`src/types.ts`, `src/settings.ts`, `src/utilities.ts`)
- Extend `VaultDavSettings` with `ignorePatterns: string` (default: `""`).
- Define top-level constants in `src/utilities.ts`:
  - `VAULTDAV_IGNORE_FILE_PATH: string = ".vaultdavignore"`
  - `MAX_IGNORE_FILE_BYTES: number = 64 * 1024`
  - `MAX_IGNORE_PATTERNS: number = 500`
  - `MAX_IGNORE_PATTERN_LENGTH: number = 256`
- Exclude `.vaultdavignore` in `util.isExcludedPath()` so each device can maintain device-specific selective sync rules without overwriting rules on other devices.
- Add a setting in `VaultDavSettingTab` (`addTextArea`) using Sentence case:
  - Name: `"Ignore patterns"`
  - Description: `"Newline-separated glob patterns or folder paths to exclude from synchronization (for example, Assets/** or *.pdf)."`

### 2.2. Zero-Dependency Glob-to-RegExp Compiler (`src/utilities.ts`)
To comply with the Zero External Dependencies and Zero Hot-Path Allocations rules in `AGENTS.md`, compile ignore rules into a `ReadonlyArray<RegExp>` once before sync execution rather than parsing strings inside per-file loops:
```typescript
export function compileIgnorePatterns(
    rawInputs: ReadonlyArray<string>
): ReadonlyArray<RegExp>;
```
- **Rule Parsing:**
  1. Split inputs on `\r?\n`, trim whitespace, and discard empty lines or comment lines starting with `#`.
  2. Reject patterns containing control characters, `.` or `..` traversal segments, or exceeding `MAX_IGNORE_PATTERN_LENGTH` (256 characters). Cap total rules at `MAX_IGNORE_PATTERNS` (500).
  3. Normalize slashes (`\` -> `/`) and strip leading `/`.
- **Glob Translation Semantics:**
  - Trailing slash (`Assets/`): Matches the directory `"Assets"` and all descendants (`^assets(?:/.*)?$` with case-insensitive flag `i`).
  - Pattern without slash (`*.pdf`): Matches any path segment or filename at any depth (`^(?:.+/)?[^/]*\.pdf$` with `i`).
  - Pattern with slash (`Archive/2024/*.zip`): Anchored to the vault root (`^archive/2024/[^/]*\.zip$` with `i`).
  - Double asterisk (`**/temp/**`): Matches zero or more directory levels (`^(?:.+/)?temp(?:/.*)?$` with `i`).
  - Escape all regex metacharacters (`.`, `+`, `^`, `$`, `(`, `)`, `[`, `]`, `{`, `}`, `|`, `\`) before translating `**`, `*`, and `?` (`[^/]`), preventing catastrophic backtracking (ReDoS).

### 2.3. Exclusion Evaluation and Safe State Pruning (`src/utilities.ts`, `src/sync/engine.ts`)
- Extend `util.isExcludedPath(path: string, customMatchers?: ReadonlyArray<RegExp>): boolean`:
  - First evaluate all existing mandatory system exclusions (cannot be overridden by user patterns).
  - If `customMatchers` is provided and non-empty, return `true` if any `matcher.test(normalized)` matches.
- **Loading `.vaultdavignore` in `SyncEngine.runSync()`:**
  - Introduce `loadCustomIgnoreMatchers(): Promise<ReadonlyArray<RegExp>>` in `SyncEngine`.
  - If `await this.vault.adapter.exists(VAULTDAV_IGNORE_FILE_PATH)` is `true`, read its text content (rejecting files larger than `MAX_IGNORE_FILE_BYTES`) and combine its lines with `this.settings.ignorePatterns`.
- **Non-Destructive Exclusion Transition:**
  - Pass `customMatchers` into `walkLocal()`, `buildSyncPlan()`, and `executePlan()`.
  - When a previously synced path matches `isExcludedPath(path, customMatchers)`, `buildSyncPlan()` skips it during local and remote map population and emits neither `delete_local` nor `delete_remote`. Instead, stale `SyncStateStore` records matching `customMatchers` are removed locally (`stateStore.removeRecord(path)`) so newly ignored files remain untouched on both local disk and Nextcloud.

## 3. Verification Plan
- `tests/utilities.test.ts`:
  - `compileIgnorePatterns` handles comments (`#`), blank lines, extension wildcards (`*.pdf`), root folder rules (`Assets/`), nested globs (`**/cache/**`), and special regex characters (`file (1)[draft]+.md`).
  - Enforces `MAX_IGNORE_PATTERNS`, `MAX_IGNORE_PATTERN_LENGTH`, and rejects `..` traversal rules.
  - Mandatory exclusions (`.obsidian/plugins/vaultdav/data.json`, `.git`, `.trash`, `.vaultdavignore`) remain excluded even when `customMatchers` is empty.
- `tests/engine.test.ts`:
  - `walkLocal()` skips directories and files matched by `settings.ignorePatterns` or `.vaultdavignore` without descending into ignored subdirectories.
  - Adding an ignore pattern for an already-synced file removes its `SyncStateRecord` without deleting the local or remote file.
- `tests/settings.test.ts`:
  - Verifies `"Ignore patterns"` textarea rendering and persistence in `VaultDavSettingTab`.

## 4. Implementation Steps
1. Add `ignorePatterns` to `VaultDavSettings` in `src/types.ts` and `DEFAULT_SETTINGS` / `VaultDavSettingTab` in `src/settings.ts` (and add `addTextArea` mock support in `tests/obsidian_mock.ts`).
2. Implement `compileIgnorePatterns` and extend `isExcludedPath` in `src/utilities.ts`.
3. Update `SyncEngine` (`src/sync/engine.ts`) to load `.vaultdavignore`, compile matchers once per sync run, and pass `customMatchers` to `walkLocal`, `buildSyncPlan`, and `executePlan`.
4. Add unit tests in `tests/utilities.test.ts`, `tests/engine.test.ts`, and `tests/settings.test.ts`.
