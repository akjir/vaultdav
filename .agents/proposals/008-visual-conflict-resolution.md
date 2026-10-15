# Proposal 008: Visual Conflict Resolution and Diff UI

- **Status:** Draft
- **Date:** 2026-10-15
- **Scope:** `src/types.ts`, `src/settings.ts`, `src/sync/diff.ts`, `src/ui/conflict_modal.ts`, `src/sync/engine.ts`, `src/main.ts`, `tests/obsidian_mock.ts`, `tests/diff.test.ts`, `tests/conflict_modal.test.ts`, `tests/engine.test.ts`, `tests/settings.test.ts`

## 1. Objective
VaultDAV currently resolves concurrent file modifications automatically via `"keep_both"` (creating a conflict copy) or `"newest_wins"` (overwriting the older file). Users have no way to inspect differences or merge concurrent text edits during synchronization. This proposal adds an `"interactive"` conflict resolution strategy with a native Obsidian `Modal` that displays a visual diff and lets the user choose `"Keep local"`, `"Keep remote"`, `"Keep both"`, or `"Save merged"`.

## 2. Technical Design

### 2.1. Settings and Types (`src/types.ts`, `src/settings.ts`)
- Extend `ConflictStrategy`:
```typescript
export type ConflictStrategy = "interactive" | "keep_both" | "newest_wins";

export type ConflictResolutionChoice =
    | "keep_both"
    | "keep_local"
    | "keep_remote"
    | "merge";

export interface ConflictResolutionDecision {
    choice: ConflictResolutionChoice;
    mergedContent?: ArrayBuffer;
}
```
- Update `"Conflict strategy"` dropdown in `VaultDavSettingTab` (`src/settings.ts`) and `loadSettings()` (`src/main.ts`) to include `"interactive"` with Sentence case label `"Ask me (visual diff)"`.

### 2.2. Zero-Dependency Line Diff Engine (`src/sync/diff.ts`)
Implement a pure TypeScript line diff and UTF-8 text detector with zero external dependencies:
```typescript
export type DiffLineType = "add" | "context" | "remove";

export interface DiffLine {
    localLineNumber: number | null;
    remoteLineNumber: number | null;
    text: string;
    type: DiffLineType;
}
```
- **Binary vs. Text Detection (`decodeTextIfValid`):**
  - Check for null bytes (`0x00`) within the first `8192` bytes and decode with `new TextDecoder("utf-8", { fatal: true })`. If decoding throws or null bytes are present, classify the file as binary.
- **Bounded LCS / Myers Diff (`computeLineDiff`):**
  - Define `MAX_DIFF_LINES: number = 5000` and `MAX_DIFF_TEXT_BYTES: number = 1024 * 1024` (1 MB).
  - If either file is binary, exceeds `MAX_DIFF_TEXT_BYTES`, or has more than `MAX_DIFF_LINES` lines, skip line-level diffing to prevent UI thread freezes and render the metadata comparison view in the modal.
  - Otherwise, compute the line-by-line Longest Common Subsequence (LCS) / Myers diff and generate a pre-populated merge draft containing git-style conflict markers (`<<<<<<< Local`, `=======`, `>>>>>>> Remote`) for conflicting hunks while keeping shared context lines intact.

### 2.3. Visual Conflict Resolution Modal (`src/ui/conflict_modal.ts`)
Create `ConflictResolutionModal extends Modal`:
- Complies strictly with `eslint-plugin-obsidianmd`:
  - Uses `this.contentEl.empty()`, `createDiv()`, `createEl()`, and `Setting` (`no-inner-html`).
  - Uses strict Sentence case for headings, labels, and buttons (`"Resolve conflict"`, `"Local version"`, `"Remote version"`, `"Merged result"`, `"Keep local"`, `"Keep remote"`, `"Keep both"`, `"Save merged"`).
- **Layout:**
  1. **Header Metadata Bar:** Displays the normalized vault path, local `mtime` and `size`, and remote `mtime` and `size`.
  2. **Diff View (for text files within bounds):**
     - Side-by-side or unified scrollable diff container (`createEl("pre")`) where `"remove"` (local-only), `"add"` (remote-only), and `"context"` lines are styled via CSS classes and `createDiv()` elements.
     - Editable `<textarea>` (`createEl("textarea")`) pre-filled with the merged text so the user can edit and resolve conflict hunks directly.
  3. **Action Bar (`new Setting(contentEl)`):**
     - `"Keep local"` -> resolves `{ choice: "keep_local" }`
     - `"Keep remote"` -> resolves `{ choice: "keep_remote" }`
     - `"Keep both"` -> resolves `{ choice: "keep_both" }`
     - `"Save merged"` (shown for text files) -> encodes textarea content via `new TextEncoder().encode(text).buffer` and resolves `{ choice: "merge", mergedContent }`
  4. **Safe Dismissal Default:** If the user closes the modal via `Escape` or the close button without clicking an action, resolve `{ choice: "keep_both" }` so neither version is lost.

### 2.4. Execution Routing in `SyncEngine` (`src/sync/engine.ts`)
- Inject an optional `resolveConflictInteractive?: (context: ConflictModalContext) => Promise<ConflictResolutionDecision>` callback into `SyncEngine`.
- In `executeConflict()`:
  - Read `localBuffer` and download `remoteBuffer` first; if `util.areArrayBuffersEqual(localBuffer, remoteBuffer)` is `true`, update `SyncStateStore` and return without prompting the user.
  - When `settings.conflictStrategy === "interactive"` and `resolveConflictInteractive !== null`:
    - Serialize interactive modal prompts (one modal at a time via a promise lock) so concurrent transfer workers do not stack multiple modals simultaneously.
    - `"keep_local"`: Upload `localBuffer` to the canonical path and update `SyncStateStore`.
    - `"keep_remote"`: Write `remoteBuffer` to the local canonical path and update `SyncStateStore`.
    - `"merge"`: Write `decision.mergedContent` locally, upload `decision.mergedContent` to Nextcloud, and update `SyncStateStore`.
    - `"keep_both"`: Execute the existing conflict-copy flow.

## 3. Verification Plan
- `tests/diff.test.ts`:
  - `decodeTextIfValid` distinguishes valid UTF-8 Markdown from binary buffers (PNG/PDF headers or null bytes).
  - `computeLineDiff` accurately marks added, removed, and unchanged lines and builds conflict-marker merge text.
  - Enforces `MAX_DIFF_LINES` and `MAX_DIFF_TEXT_BYTES` limits gracefully.
- `tests/conflict_modal.test.ts`:
  - Renders diff lines and action buttons using DOM APIs (`no-inner-html`), returns `"keep_local"`, `"keep_remote"`, `"keep_both"`, or `"merge"` payload, and defaults to `"keep_both"` on modal dismissal.
- `tests/engine.test.ts`:
  - `executeConflict` with `"interactive"` strategy executes upload on `"keep_local"`, local write on `"keep_remote"`, both local write and remote upload on `"merge"`, and skips the modal when buffers are byte-identical.

## 4. Implementation Steps
1. Extend `ConflictStrategy` and add conflict resolution types in `src/types.ts`, and update `src/settings.ts` and `src/main.ts`.
2. Implement `src/sync/diff.ts` (`decodeTextIfValid`, `computeLineDiff`, `buildMergeDraft`) and unit tests in `tests/diff.test.ts`.
3. Implement `ConflictResolutionModal` in `src/ui/conflict_modal.ts` and unit tests in `tests/conflict_modal.test.ts`.
4. Update `SyncEngine.executeConflict()` in `src/sync/engine.ts` to support `"interactive"` resolution choices and serialized modal invocation.
5. Add integration tests in `tests/engine.test.ts` and `tests/settings.test.ts`.
