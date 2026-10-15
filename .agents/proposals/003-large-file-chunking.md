### Proposal 003: Large File Handling & Chunked Transfers
*   **Status:** Implemented
*   **Scope:** `src/types.ts`, `src/settings.ts`, `src/main.ts`, `src/webdav/client.ts`, `src/sync/engine.ts`, `src/log.ts`

#### 1. Objective
Implement robust handling for large files (e.g., > 90MB) using Nextcloud's native OC-Chunked protocol for uploads and HTTP `Range` requests for parallel downloads. Add a real-time progress indicator to the Obsidian status bar.

#### 2. Technical Design

##### 2.1. Settings & Thresholds (`src/types.ts`, `src/settings.ts`)
- Add `chunkingThresholdMB: number` (default: 90) and `chunkSizeMB: number` (default: 10) to `VaultDavSettings`.
- Expose these under an "Advanced Sync Settings" section in `VaultDavSettingTab`.

##### 2.2. Nextcloud OC-Chunked Upload (`src/webdav/client.ts`)
For local files where `size > chunkingThresholdMB * 1024 * 1024`:
1. Generate a unique transfer ID (`uuid` or `Date.now().toString()`).
2. Create transfer directory: `MKCOL /remote.php/dav/uploads/<username>/<transfer-id>`
3. Slice the `ArrayBuffer` into chunks of `chunkSizeMB`.
4. Upload chunks individually via `PUT` to `/remote.php/dav/uploads/<username>/<transfer-id>/<padded-index>` (e.g., `0000000000000001`). Retry up to 3 times per chunk with a 60s timeout.
5. Assemble on server: `MOVE /remote.php/dav/uploads/<username>/<transfer-id>/.file` -> `Destination: /remote.php/dav/files/<username>/<normalized-path>` (include `X-OC-Mtime` header).
6. The server automatically assembles the chunks and moves the file. Extract the returned `ETag`.

##### 2.3. Parallel Range Download (`src/webdav/client.ts`)
For remote files where `size > 5 * 1024 * 1024` (Files < 5MB fast-path: single standard `GET`):
1. Calculate the number of chunks: `Math.ceil(size / chunkSize)`.
2. Create tasks to fetch chunks concurrently using `util.runConcurrent(tasks, 4)`.
3. Each task sends a `GET` request with header `Range: bytes=<start>-<end>`. Retry up to 3 times per chunk.
4. Preallocate a single `Uint8Array(size)` and copy the downloaded `ArrayBuffer` chunks into their respective byte offsets to minimize memory fragmentation.
5. Return the assembled `ArrayBuffer`.

##### 2.4. Real-Time Status Bar Progress (`src/log.ts`, `src/main.ts`, `src/sync/engine.ts`)
- In `src/main.ts`, create a status bar element: `this.statusBarItem = this.addStatusBarItem()`.
- Inject a `ProgressReporter` interface into `SyncEngine` with methods like `reportProgress(message: string)`.
- Update the status bar text in real-time during chunk processing: `Uploading notes.md (3/12 · file 5/18)`.
- Clear the status bar (`setText("")`) when the sync is complete or fails.

#### 3. Implementation Steps
1. Add configuration fields to `src/types.ts` and `src/settings.ts`.
2. Implement `ProgressReporter` in `src/main.ts` and pass it to `SyncEngine`.
3. Add `uploadFileChunked` and `downloadFileChunked` to `src/webdav/client.ts`. Update `tests/client.test.ts` to mock `Range` requests and the Nextcloud upload `MKCOL`/`PUT`/`MOVE` cycle.
4. Update `executePlan` in `src/sync/engine.ts` to select the standard or chunked transfer method based on file size, and report progress. Update `tests/engine.test.ts`.
