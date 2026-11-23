# VaultDAV

Synchronize Obsidian vaults bidirectionally with Nextcloud via WebDAV.

## Nextcloud Setup

1. Open Nextcloud and go to **Settings > Security > Devices & sessions**.
2. Enter a device name (for example, `Obsidian VaultDAV`) and click **Create new app password**.
3. Copy the generated App Password.
4. Enter your Nextcloud base URL (`https://<domain>`) in **Server URL**, your account name in **Username**, and the target folder in **Remote base directory**. VaultDAV resolves requests against:
   `https://<domain>/remote.php/dav/files/<user>/<remote-base-dir>/`

## Settings

| Setting | Property (`VaultDavSettings`) | Description |
| :--- | :--- | :--- |
| Server URL | `url` | Nextcloud base URL or WebDAV endpoint (`https://<domain>`). |
| Username | `username` | Nextcloud account username. |
| App password | `appPassword` | Nextcloud app password for HTTP basic authentication. |
| Remote base directory | `remoteBaseDir` | Target remote folder path inside the Nextcloud user files root. |
| Sync interval | `syncInterval` | Automatic synchronization interval in minutes (`0` to `10080`, `0` to disable). |
| Conflict strategy | `conflictStrategy` | Resolution mode for concurrent edits (`keep_both` or `newest_wins`). |
| Chunking threshold | `chunkingThresholdMB` | File size threshold in MB (`1` to `512`, default `90`) above which uploads use Nextcloud OC-Chunked transfers. |
| Chunk size | `chunkSizeMB` | Individual chunk size in MB (`1` to `512`, default `10`) for chunked uploads and parallel HTTP `Range` downloads. |

## Commands

| Command ID | Name | Description |
| :--- | :--- | :--- |
| `vaultdav:sync-now` | Synchronize now | Execute a bidirectional synchronization cycle immediately. |
| `vaultdav:test-connection` | Test Nextcloud WebDAV connection | Verify Nextcloud credentials and remote base directory access. |

## Sync Behavior

- Transfers files as binary payloads (`ArrayBuffer`) over Obsidian `requestUrl`, using Nextcloud OC-Chunked uploads (`MKCOL` / `PUT` / `MOVE`) for files exceeding `chunkingThresholdMB` and parallel HTTP `Range` downloads (`Uint8Array.set()`) for remote files larger than 5 MB.
- Displays real-time transfer and chunk progress in the Obsidian status bar during synchronization.
- Tracks local and remote modification times and ETags to detect creations, modifications, and deletions (tombstones).
- Excludes the local sync state file (`<config-dir>/plugins/vaultdav/sync-state.json`), plugin credentials (`<config-dir>/plugins/vaultdav/data.json`), `<config-dir>/workspace*.json`, and `.trash/` (respecting custom `Vault#configDir` names) to prevent sync loops.

## Compatibility & Privacy

- **Desktop & Mobile:** Supports Desktop, Android, and iOS (`isDesktopOnly: false`) with zero runtime dependencies.
- **iOS TLS requirement:** Apple iOS blocks self-signed TLS certificates in Obsidian. Use a valid CA-signed HTTPS certificate (for example, Let's Encrypt) on your Nextcloud server when syncing from iOS.
- **Network & privacy:** VaultDAV communicates only with the Nextcloud HTTPS server that you configure. It sends no telemetry or requests to third-party servers, and stores your app password locally in `<config-dir>/plugins/vaultdav/data.json` (excluded from synchronization).

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
