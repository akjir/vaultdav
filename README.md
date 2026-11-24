# VaultDAV

Bidirectional Nextcloud WebDAV sync for Obsidian on Desktop, Android, and iOS. Requires Obsidian 1.13.2 or newer.

## Installation

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest [GitHub Release](https://github.com/akjir/vaultdav/releases/latest).
2. Copy the files into `<vault>/<config-dir>/plugins/vaultdav/`.
3. Reload Obsidian and enable **VaultDAV** under **Settings > Community plugins**.

### BRAT

1. Install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) community plugin.
2. Add `akjir/vaultdav` in BRAT settings.
3. Enable **VaultDAV** under **Settings > Community plugins**.

## Setup

1. In Nextcloud, go to **Settings > Security > Devices & sessions**, enter a device name, and click **Create new app password**.
2. In Obsidian, open **Settings > VaultDAV** and set **Server URL**, **Username**, **App password** (via Obsidian SecretStorage), and optionally **Remote base directory** (defaults to the vault name).
3. Check **Resolved WebDAV URL** (`https://<domain>/remote.php/dav/files/<user>/<remote-base-dir>/`) and click **Test connection**.

## Settings

| Setting | Description |
| :--- | :--- |
| Server URL | Nextcloud host or WebDAV URL. Uses `https://` if omitted; only `http://` and `https://` are allowed. |
| Username | Nextcloud account username. |
| App password | Obsidian SecretStorage entry for your Nextcloud app password. |
| Remote base directory | Target folder inside your Nextcloud files root. Defaults to the vault name. |
| Sync interval | Auto-sync interval in minutes (`0` to `10080`; `0` disables auto-sync). |
| Conflict strategy | Concurrent edit handling: `Keep both (create conflict copy)` (default) or `Newest wins`. |
| Chunking threshold | File size in MB (`1` to `512`, default `90`) above which uploads use Nextcloud chunked transfer. |
| Chunk size | Chunk size in MB (`1` to `512`, default `10`) for chunked uploads and parallel range downloads. |
| Sync log retention | Days to keep local sync history (`1` to `365`, default `30`). |

## Commands

- **Synchronize now**: Run a sync immediately (also available via the **Synchronize with Nextcloud** ribbon icon).
- **Test Nextcloud WebDAV connection**: Verify credentials and remote folder access.
- **Open sync log**: Open the sync log pane with run history, transfer byte totals, file events, active conflict copies, and Markdown export (also available via the ribbon icon).

On desktop, the status bar displays live transfer progress and stays clickable when a sync finishes with errors or fails.

## Sync Behavior

- Syncs vault content only (notes, attachments, and regular folders). Excludes `<config-dir>`, all hidden dot-files and dot-folders (for example `.trash/`, `.git/`, `.svn/`, `.DS_Store`), `node_modules/`, `Thumbs.db`, and `desktop.ini`.
- Tracks modification times and ETags locally to sync additions, edits, and deletions. Changing the server, username, or remote base directory resets local sync state automatically so existing files are not deleted.
- Transfers files as binary data, using Nextcloud chunked uploads above the configured threshold and parallel range downloads for files larger than 5 MB.
- Resolves identical concurrent edits without creating copies. For differing edits, `Keep both` creates a `.conflict-*` copy and `Newest wins` keeps the newer file.
- Stores sync state and history per device under `<config-dir>/plugins/vaultdav/` (`sync-state.json` and `sync-history.json`). History is pruned automatically by age, run count, and a 1 MB size limit.

## Compatibility & Privacy

- Supports Desktop, Android, and iOS on Obsidian 1.13.2 or newer with zero runtime dependencies.
- Apple iOS blocks self-signed TLS certificates in Obsidian. Use a valid CA-signed HTTPS certificate (for example, Let's Encrypt) when syncing from iOS.
- Communicates only with the configured Nextcloud server (`https://` by default, or `http://` when explicitly specified). Sends no telemetry or third-party requests.
- Stores the app password per device in Obsidian SecretStorage, never in plaintext in `<config-dir>/plugins/vaultdav/data.json`. Legacy plaintext passwords migrate automatically on load.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
npm run dev
```

## License

GNU General Public License v3.0. See [LICENSE](LICENSE).

Sync logic and WebDAV quirk handling are inspired by [remotely-save](https://github.com/remotely-save/remotely-save).
