# VaultDAV

Synchronize Obsidian vaults bidirectionally with Nextcloud via WebDAV.

## Nextcloud Setup

1. Open Nextcloud and go to **Settings > Security > Devices & sessions**.
2. Enter a device name (for example, `Obsidian VaultDAV`) and click **Create new app password**.
3. Copy the generated App Password.
4. Configure the WebDAV endpoint using the Nextcloud URL format:
   `https://<domain>/remote.php/dav/files/<user>/<remote-base-dir>/`

## Settings

| Setting | Property (`VaultDavSettings`) | Description |
| :--- | :--- | :--- |
| Server URL | `url` | Nextcloud base URL or WebDAV endpoint (`https://<domain>`). |
| Username | `username` | Nextcloud account username. |
| App password | `appPassword` | Nextcloud app password for HTTP Basic authentication. |
| Remote base directory | `remoteBaseDir` | Target remote folder path inside the Nextcloud user files root. |
| Sync interval | `syncInterval` | Automatic synchronization interval in minutes (`0` to disable). |
| Conflict strategy | `conflictStrategy` | Resolution mode for concurrent edits (`keep_both` or `newest_wins`). |

## Commands

| Command ID | Name | Description |
| :--- | :--- | :--- |
| `vaultdav:sync-now` | Synchronize now | Execute a bidirectional synchronization cycle immediately. |
| `vaultdav:test-connection` | Test Nextcloud WebDAV connection | Verify Nextcloud credentials and remote base directory access. |

## Sync Behavior

- Transfers files as binary payloads (`ArrayBuffer`) over Obsidian `requestUrl`.
- Tracks local and remote modification times and ETags to detect creations, modifications, and deletions (tombstones).
- Excludes the local sync state file (`.obsidian/plugins/vaultdav/sync-state.json`), plugin credentials (`.obsidian/plugins/vaultdav/data.json`), `.obsidian/workspace*.json`, and `.trash/` to prevent sync loops.

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
