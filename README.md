# VaultDAV

Synchronize Obsidian vaults bidirectionally with Nextcloud via WebDAV.

## Installation

### Manual Installation

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest [GitHub Release](https://github.com/akjir/vaultdav/releases/latest).
2. Create the folder `<vault>/<config-dir>/plugins/vaultdav/` (where `<config-dir>` is your Obsidian configuration folder).
3. Copy `main.js`, `manifest.json`, and `styles.css` into that folder.
4. Reload Obsidian and enable **VaultDAV** under **Settings > Community plugins**.

### Beta Installation (BRAT)

1. Install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) community plugin.
2. Add `akjir/vaultdav` in BRAT settings.
3. Enable **VaultDAV** under **Settings > Community plugins**.

## Nextcloud Setup

1. Open Nextcloud and go to **Settings > Security > Devices & sessions**.
2. Enter a device name (for example, `Obsidian VaultDAV`) and click **Create new app password**.
3. Copy the generated App Password.
4. Enter your Nextcloud base URL (`https://<domain>`) in **Server URL**, your account name in **Username**, select or create a secret containing the generated password in **App password** (stored in Obsidian SecretStorage), and enter the target folder in **Remote base directory**. VaultDAV resolves requests against:
   `https://<domain>/remote.php/dav/files/<user>/<remote-base-dir>/`

## Settings

| Setting | Property (`VaultDavSettings`) | Description |
| :--- | :--- | :--- |
| Server URL | `url` | Nextcloud base URL or WebDAV endpoint (`https://<domain>`). |
| Username | `username` | Nextcloud account username. |
| App password | `appPasswordSecret` | Secret reference ID in Obsidian SecretStorage for your Nextcloud app password (never persisted in plaintext in `data.json`). |
| Remote base directory | `remoteBaseDir` | Target remote folder path inside the Nextcloud user files root. |
| Sync interval | `syncInterval` | Automatic synchronization interval in minutes (`0` to `10080`, `0` to disable). |
| Conflict strategy | `conflictStrategy` | Resolution mode for concurrent edits (`keep_both` or `newest_wins`). |
| Chunking threshold | `chunkingThresholdMB` | File size threshold in MB (`1` to `512`, default `90`) above which uploads use Nextcloud OC-Chunked transfers. |
| Chunk size | `chunkSizeMB` | Individual chunk size in MB (`1` to `512`, default `10`) for chunked uploads and parallel HTTP `Range` downloads. |
| Sync log retention | `syncLogRetentionDays` | Days to retain local sync history (`1` to `365`, default `30`). |

## Commands

| Command ID | Name | Description |
| :--- | :--- | :--- |
| `vaultdav:sync-now` | Synchronize now | Execute a bidirectional synchronization cycle immediately. |
| `vaultdav:test-connection` | Test Nextcloud WebDAV connection | Verify Nextcloud credentials and remote base directory access. |
| `vaultdav:open-sync-log` | Open sync log | Open the Sync log pane with run summaries, detailed transfer events, and active conflict copies. |

## Sync Behavior

- Transfers files as binary payloads (`ArrayBuffer`) over Obsidian `requestUrl`, using Nextcloud OC-Chunked uploads (`MKCOL` / `PUT` / `MOVE`) for files exceeding `chunkingThresholdMB` and parallel HTTP `Range` downloads (`Uint8Array.set()`) for remote files larger than 5 MB.
- Displays real-time transfer and chunk progress in the Obsidian status bar during synchronization, and shows a clickable error indicator when a sync finishes with errors or fails.
- Records per-file sync activity (uploads, downloads, conflicts with copy paths and resolution modes, deletions, folder creations, warnings, and redacted errors) in a device-local history file (`<config-dir>/plugins/vaultdav/sync-history.json`) with hybrid tiered retention (consecutive no-op folding, 500-event priority cap per run, configurable day TTL, 100-run critical-preserving cap, and a 1 MB size ceiling).
- Tracks local and remote modification times and ETags to detect creations, modifications, and deletions (tombstones).
- Excludes the local sync state file (`<config-dir>/plugins/vaultdav/sync-state.json`), local sync history file (`<config-dir>/plugins/vaultdav/sync-history.json`), plugin configuration (`<config-dir>/plugins/vaultdav/data.json`), `<config-dir>/workspace*.json`, `.trash/`, `.git/`, `.svn/`, `node_modules/`, and OS metadata files (`.DS_Store`, `Thumbs.db`, `desktop.ini`), respecting custom `Vault#configDir` names to prevent sync loops.

## Compatibility & Privacy

- **Desktop & Mobile:** Supports Desktop, Android, and iOS (`isDesktopOnly: false`) on Obsidian 1.11.4 or newer with zero runtime dependencies.
- **iOS TLS requirement:** Apple iOS blocks self-signed TLS certificates in Obsidian. Use a valid CA-signed HTTPS certificate (for example, Let's Encrypt) on your Nextcloud server when syncing from iOS.
- **Network & privacy:** VaultDAV communicates only with the Nextcloud HTTPS server that you configure. It sends no telemetry or requests to third-party servers. Your Nextcloud app password is stored in Obsidian SecretStorage (local to each device), while `<config-dir>/plugins/vaultdav/data.json` stores only the secret reference ID (`appPasswordSecret`) and remains excluded from synchronization. Legacy plaintext `appPassword` entries in `data.json` are migrated automatically into SecretStorage and removed from `data.json` on load.

## Development & Build

```bash
npm install
npm run typecheck
npm test
npm run build
npm run dev
```

## Acknowledgments

VaultDAV's synchronization algorithm and WebDAV quirk handling are inspired by [remotely-save](https://github.com/remotely-save/remotely-save).

## License

VaultDAV is licensed under the GNU General Public License v3.0. See [LICENSE](LICENSE) for full terms.
