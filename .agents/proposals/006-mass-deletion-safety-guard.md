# Proposal 006: Mass Deletion Safety Guard

- **Status:** Draft
- **Date:** 2026-10-15
- **Scope:** `src/types.ts`, `src/settings.ts`, `src/ui/safety_modal.ts`, `src/sync/engine.ts`, `src/main.ts`, `tests/obsidian_mock.ts`, `tests/settings.test.ts`, `tests/safety_modal.test.ts`, `tests/engine.test.ts`, `tests/main.test.ts`

## 1. Objective
If `sync-state.json` is stale or a user accidentally moves or deletes a large folder on a secondary device, `buildSyncPlan()` may schedule hundreds of `delete_local` or `delete_remote` actions in a single synchronization cycle. This proposal adds configurable file-count and percentage deletion thresholds in settings and pauses `SyncEngine` before executing any changes to request explicit user confirmation via a native Obsidian `Modal`.

## 2. Technical Design

### 2.1. Settings and Types (`src/types.ts`, `src/settings.ts`)
Extend `VaultDavSettings`, `SyncResult`, and define `MassDeletionSummary`:
```typescript
export interface MassDeletionSummary {
    affectedPaths: ReadonlyArray<string>;
    deleteLocalCount: number;
    deleteRemoteCount: number;
    deletionPercentage: number;
    totalDeletions: number;
    totalTrackedFiles: number;
}
```
- Add to `VaultDavSettings`:
  - `massDeleteFileThreshold: number` (default: `50`, `0` to disable, max: `10000`)
  - `massDeletePercentThreshold: number` (default: `10`, `0` to disable, max: `100`)
- Add `aborted?: boolean` to `SyncResult` (default: `false`).
- Add settings under `"Advanced sync"` in `VaultDavSettingTab` using strict Sentence case:
  - `"Mass deletion file threshold"`: `"Warn before deleting at least this many files in a single sync (0 to disable)."`
  - `"Mass deletion percentage threshold"`: `"Warn before deleting at least this percentage of tracked files in a single sync (0 to disable)."`

### 2.2. Threshold Evaluation (`src/sync/engine.ts`)
Implement a pure helper function in `src/sync/engine.ts`:
```typescript
export function evaluateMassDeletionRisk(
    plan: SyncPlan,
    totalTrackedFiles: number,
    settings: Pick<
        VaultDavSettings,
        "massDeleteFileThreshold" | "massDeletePercentThreshold"
    >
): MassDeletionSummary | null;
```
- Count non-directory actions in `plan.actions` where `action.type === "delete_local"` or `action.type === "delete_remote"`.
- Calculate `deletionPercentage = totalTrackedFiles > 0 ? (totalDeletions / totalTrackedFiles) * 100 : 0`.
- Trigger a warning when `totalDeletions > 0` and either:
  1. `settings.massDeleteFileThreshold > 0 && totalDeletions >= settings.massDeleteFileThreshold`, or
  2. `settings.massDeletePercentThreshold > 0 && totalTrackedFiles >= MIN_TRACKED_FILES_FOR_PERCENT_GUARD (10) && deletionPercentage >= settings.massDeletePercentThreshold`.
- Note: Set `MIN_TRACKED_FILES_FOR_PERCENT_GUARD = 10` so deleting 1 file in a 5-file test vault (20%) does not trigger false alarms.

### 2.3. Obsidian Confirmation Modal (`src/ui/safety_modal.ts`)
Create `MassDeletionModal extends Modal`:
- Complies with `eslint-plugin-obsidianmd`:
  - Uses `this.setTitle("Confirm mass deletion")` (or heading via `Setting`) and `this.contentEl.empty()`, `createEl()`, `createDiv()`, and `Setting` (`no-inner-html`).
  - Uses strict Sentence case for all text and buttons (`"Cancel"`, `"Delete files"`).
- Displays:
  - Summary paragraph: `"Synchronization plans to delete <totalDeletions> files (<deleteLocalCount> local, <deleteRemoteCount> on Nextcloud, <deletionPercentage>% of tracked files). Do you want to proceed?"`
  - Preview list (`<ul>` created via `createEl("ul")`) showing up to `MAX_PREVIEW_PATHS = 20` affected file paths, followed by `"And <N> more..."` when truncated.
  - Action buttons via `new Setting(contentEl)`: `"Cancel"` (default focus, resolves `false`) and `"Delete files"` (`setWarning()`, resolves `true`). Closing the modal via `Escape` or backdrop click resolves `false`.

### 2.4. Execution Gate in `SyncEngine` (`src/sync/engine.ts`, `src/main.ts`)
- Add an optional `confirmMassDeletion?: (summary: MassDeletionSummary) => Promise<boolean>` callback to `SyncEngine` constructor.
- In `executePlan()` (before Phase 1 `prune_state`, Phase 2 `mkdir`, Phase 3 `delete`, and Phase 4 `transfer`), call `evaluateMassDeletionRisk()`.
- If a risk summary is returned:
  - If `this.confirmMassDeletion === null` (headless/unconfigured), abort by default and append `"Mass deletion aborted by safety guard"` to `result.errors`.
  - If `await this.confirmMassDeletion(summary)` returns `false`, return immediately with `aborted: true`, `deletedLocal: 0`, `deletedRemote: 0`, `uploaded: 0`, `downloaded: 0`, without mutating `SyncStateStore`, local files, or Nextcloud.

## 3. Verification Plan
- `tests/engine.test.ts`:
  - `evaluateMassDeletionRisk` returns `null` when deletions are below both file count and percentage thresholds, or when both thresholds are set to `0`.
  - Triggers when `totalDeletions >= massDeleteFileThreshold` (e.g., 50 files).
  - Triggers when `deletionPercentage >= massDeletePercentThreshold` and `totalTrackedFiles >= 10` (e.g., 3 of 20 files = 15% >= 10%).
  - Does not trigger percentage guard when `totalTrackedFiles < 10` unless file count threshold is also met.
  - `executePlan` halts before `prune_state`, `mkdir`, `delete`, and `transfer` when `confirmMassDeletion` resolves to `false`.
- `tests/safety_modal.test.ts`:
  - Renders summary counts, truncates preview paths at 20 items, resolves `true` on `"Delete files"` click, and resolves `false` on `"Cancel"` or modal close without using `innerHTML`.
- `tests/settings.test.ts`:
  - Validates numeric clamping (`0..10000` for file threshold, `0..100` for percentage threshold).

## 4. Implementation Steps
1. Add `Modal` mock to `tests/obsidian_mock.ts` and extend `VaultDavSettings`, `SyncResult`, and `MassDeletionSummary` in `src/types.ts`.
2. Add `"Mass deletion file threshold"` and `"Mass deletion percentage threshold"` controls in `src/settings.ts`.
3. Implement `MassDeletionModal` in `src/ui/safety_modal.ts`.
4. Implement `evaluateMassDeletionRisk` and the pre-execution gate in `src/sync/engine.ts`, and wire `MassDeletionModal` in `src/main.ts`.
5. Add unit tests in `tests/safety_modal.test.ts`, `tests/engine.test.ts`, `tests/main.test.ts`, and `tests/settings.test.ts`.
