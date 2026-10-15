# Proposal 009: Mobile Network and Power State Detection

- **Status:** Draft
- **Date:** 2026-10-15
- **Scope:** `src/types.ts`, `src/settings.ts`, `src/utilities.ts`, `src/main.ts`, `tests/obsidian_mock.ts`, `tests/utilities.test.ts`, `tests/settings.test.ts`, `tests/main.test.ts`

## 1. Objective
VaultDAV supports both Desktop and Mobile platforms (`isDesktopOnly: false`), where background synchronization over cellular connections or during low-battery states can exhaust mobile data plans and battery life. This proposal adds zero-dependency network and power state detection using standard Web/Capacitor APIs (`navigator.onLine`, `navigator.connection`, `navigator.getBattery`) to automatically suspend background auto-sync on cellular, metered, offline, or low-battery states while keeping manual sync available.

## 2. Technical Design

### 2.1. Settings and Types (`src/types.ts`, `src/settings.ts`)
- Extend `VaultDavSettings` with:
  ```typescript
  export interface VaultDavSettings {
      // Existing properties...
      pauseAutoSyncOnLowBattery: boolean;
      syncOnlyOnWifi: boolean;
  }
  ```
- Default values in `DEFAULT_SETTINGS`: `pauseAutoSyncOnLowBattery: false`, `syncOnlyOnWifi: false`.
- Add settings under a `"Mobile and network"` heading in `VaultDavSettingTab` using strict Sentence case:
  - `"Sync only on Wi-Fi or Ethernet"`: Toggle (`addToggle`) with description `"Skip automatic background sync when connected to a cellular or metered mobile network."`
  - `"Pause auto-sync on low battery"`: Toggle (`addToggle`) with description `"Skip automatic background sync when the device is discharging below 15% battery or data saver is active."`

### 2.2. Strict TypeScript Navigator Probes (`src/utilities.ts`)
Because `navigator.connection` (Network Information API) and `navigator.getBattery` (Battery Status API) are not part of standard baseline DOM typings across all WebViews, define strict interfaces in `src/types.ts` without using `any`:
```typescript
export interface BatteryManagerLike {
    readonly charging: boolean;
    readonly level: number;
}

export interface NetworkInformationLike {
    addEventListener?: (type: string, listener: () => void) => void;
    readonly effectiveType?: string;
    removeEventListener?: (type: string, listener: () => void) => void;
    readonly saveData?: boolean;
    readonly type?: string;
}

export interface NavigatorEnvironmentLike {
    readonly connection?: NetworkInformationLike;
    getBattery?: () => Promise<BatteryManagerLike>;
    readonly onLine?: boolean;
}

export interface AutoSyncEligibility {
    allowed: boolean;
    reason: string;
}
```
Implement `checkAutoSyncEligibility(settings: Pick<VaultDavSettings, "pauseAutoSyncOnLowBattery" | "syncOnlyOnWifi">, nav?: NavigatorEnvironmentLike): Promise<AutoSyncEligibility>` in `src/utilities.ts`:
1. **Offline Check (Always Enforced for Auto-Sync):**
   - If `nav?.onLine === false`, return `{ allowed: false, reason: "Device is offline" }`.
2. **Cellular and Metered Network Check (`settings.syncOnlyOnWifi === true`):**
   - Inspect `connectionType = nav?.connection?.type?.toLowerCase() ?? ""`.
   - If `connectionType === "cellular" || connectionType === "none" || connectionType === "wimax" || connectionType === "bluetooth"`, return `{ allowed: false, reason: `Network connection is ${connectionType}` }`.
   - If `nav?.connection?.saveData === true`, return `{ allowed: false, reason: "Data saver mode is active" }`.
   - **iOS / WebKit Fallback:** On iOS Capacitor WebViews where `navigator.connection` is `undefined`, fail open (`allowed: true` when `nav.onLine !== false`) so auto-sync is not permanently blocked on unsupported WebViews.
3. **Battery and Data Saver Check (`settings.pauseAutoSyncOnLowBattery === true`):**
   - If `nav?.connection?.saveData === true`, return `{ allowed: false, reason: "Data saver mode is active" }`.
   - If `typeof nav?.getBattery === "function"`, await `nav.getBattery()` inside a `try / catch` guard. If `battery.charging === false && Number.isFinite(battery.level) && battery.level <= LOW_BATTERY_THRESHOLD (0.15)`, return `{ allowed: false, reason: "Battery level is low" }`.

### 2.3. Auto-Sync vs. Manual Sync Routing (`src/main.ts`)
- Update `triggerSync(isAutoSync: boolean = false): Promise<SyncResult | null>` in `VaultDavPlugin`:
  - Manual invocations (Ribbon icon click, `"Synchronize now"` command) pass `isAutoSync = false` and bypass `checkAutoSyncEligibility` (except if offline, or allow `requestUrl` to report the network error explicitly).
  - Interval-triggered invocations in `configureAutoSync()` pass `isAutoSync = true`.
  - When `isAutoSync === true`, evaluate `await util.checkAutoSyncEligibility(this.settings)`. If `eligibility.allowed === false`:
    - Log `log.debug(\`Skipping auto-sync: \${eligibility.reason}\`)`.
    - Do not show a disruptive `Notice` popup on background skips; optionally set status bar text briefly (`this.reportProgress(\`Auto-sync paused (\${eligibility.reason})\`)`) and return `null`.

## 3. Verification Plan
- `tests/utilities.test.ts`:
  - `checkAutoSyncEligibility` returns `allowed: false` when `onLine === false`.
  - Returns `allowed: false` when `syncOnlyOnWifi === true` and `connection.type === "cellular"` or `connection.saveData === true`.
  - Returns `allowed: true` when `syncOnlyOnWifi === true` and `connection.type === "wifi"` or `"ethernet"`, or when `navigator.connection` is `undefined` (iOS WebKit fallback).
  - Returns `allowed: false` when `pauseAutoSyncOnLowBattery === true` and `getBattery()` resolves to `{ charging: false, level: 0.10 }`, and `allowed: true` when `charging: true` or `level: 0.50` or `getBattery()` rejects.
- `tests/main.test.ts`:
  - Scheduled `syncInterval` timer calls `triggerSync(true)` and skips WebDAV network requests without showing a `Notice` when on cellular (`syncOnlyOnWifi: true`).
  - Manual `"sync-now"` command and ribbon icon call `triggerSync(false)` and execute sync even when `connection.type === "cellular"`.
- `tests/settings.test.ts`:
  - Verifies toggle settings `"Sync only on Wi-Fi or Ethernet"` and `"Pause auto-sync on low battery"` persist and comply with Sentence case rules.

## 4. Implementation Steps
1. Add `BatteryManagerLike`, `NetworkInformationLike`, `NavigatorEnvironmentLike`, `AutoSyncEligibility`, and the two new boolean settings to `src/types.ts`.
2. Update `DEFAULT_SETTINGS` and `VaultDavSettingTab` in `src/settings.ts` and `loadSettings()` in `src/main.ts`.
3. Implement `checkAutoSyncEligibility` in `src/utilities.ts`.
4. Update `VaultDavPlugin.triggerSync(isAutoSync)` and `configureAutoSync()` in `src/main.ts`.
5. Add unit tests in `tests/utilities.test.ts`, `tests/main.test.ts`, and `tests/settings.test.ts`.
