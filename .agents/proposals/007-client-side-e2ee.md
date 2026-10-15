# Proposal 007: Client-Side End-to-End Encryption

- **Status:** Draft
- **Date:** 2026-10-15
- **Scope:** `src/types.ts`, `src/settings.ts`, `src/log.ts`, `src/crypto/e2ee.ts`, `src/sync/state.ts`, `src/sync/engine.ts`, `src/main.ts`, `tests/e2ee.test.ts`, `tests/log.test.ts`, `tests/settings.test.ts`, `tests/state.test.ts`, `tests/engine.test.ts`

## 1. Objective
Users synchronizing vaults to corporate or shared Nextcloud servers require cryptographic confidentiality so the remote server never stores plaintext note contents. This proposal introduces zero-dependency client-side End-to-End Encryption (E2EE) using the Web Crypto API (`crypto.subtle`) with `PBKDF2-HMAC-SHA256`, `HKDF-SHA256`, and `AES-256-GCM` authenticated encryption applied before WebDAV `PUT` and after WebDAV `GET`.

## 2. Technical Design

### 2.1. Settings and Credential Redaction (`src/types.ts`, `src/settings.ts`, `src/log.ts`)
- Extend `VaultDavSettings` with:
  - `enableEncryption: boolean` (default: `false`)
  - `encryptionPassword: string` (default: `""`)
- Extend `SyncStateRecord` with optional `remoteSize?: number` to track ciphertext size on Nextcloud independently of local plaintext size.
- Add UI controls under an `"End-to-end encryption"` heading in `VaultDavSettingTab` using Sentence case:
  - `"Enable client-side encryption"`: Toggle (`addToggle`) with description `"Encrypt file contents locally with AES-256-GCM before uploading to Nextcloud."`
  - `"Encryption password"`: Password input (`addText` with `inputEl.type = "password"`) with description `"Passphrase used to derive the vault encryption key. Never sent to the server."`
- Update `src/log.ts` (`redactSensitiveText`) so any accidental error message containing the encryption password or key material is redacted.

### 2.2. Binary Envelope and Web Crypto Pipeline (`src/crypto/e2ee.ts`)
Use `globalThis.crypto.subtle` and `globalThis.crypto.getRandomValues` exclusively (zero external dependencies):
- **Binary Envelope Layout (`49 bytes` total overhead):**
  | Byte Offset | Length | Field | Description |
  | :--- | :--- | :--- | :--- |
  | `0..3` | `4 B` | `MAGIC` | ASCII `"VDAV"` (`0x56, 0x44, 0x41, 0x56`) |
  | `4` | `1 B` | `VERSION` | Envelope version `0x01` |
  | `5..20` | `16 B` | `SALT` | Random per-file salt (`crypto.getRandomValues`) |
  | `21..32` | `12 B` | `IV` | Random per-encryption AES-GCM nonce (`crypto.getRandomValues`) |
  | `33..N+32` | `N B` | `CIPHERTEXT` | Encrypted payload |
  | `N+33..N+48` | `16 B` | `AUTH_TAG` | 128-bit AES-GCM authentication tag appended by Web Crypto |

- **Two-Stage Key Derivation for High Throughput:**
  Running `PBKDF2` (`210,000` iterations) from scratch for each file in a 1,000-file vault would block sync execution on mobile devices. Instead, use a two-stage derivation within each `VaultCryptoContext` instance:
  1. **Master Key Derivation (once per sync session):** Derive a 256-bit master secret from `encryptionPassword` and a fixed domain separator (`"VaultDAV-E2EE-v1-Master"`) using `PBKDF2-HMAC-SHA256` with `210,000` iterations, then import the resulting bits as an `HKDF` base `CryptoKey` cached in memory for the duration of the sync run.
  2. **Per-File Key Derivation (per `encryptPayload` / `decryptPayload` call):** Derive a unique non-extractable `AES-GCM` (256-bit) `CryptoKey` from the session `HKDF` key using `crypto.subtle.deriveKey` with the file's 16-byte random `SALT` and `info = TextEncoder().encode("VaultDAV-E2EE-v1-FileKey")`.
- **Authenticated Additional Data (AAD):** Pass the 21-byte header prefix (`MAGIC || VERSION || SALT`) as `additionalData` in `AesGcmParams` (`tagLength: 128`) so any header tampering causes `crypto.subtle.decrypt` to reject with an authentication failure before writing to disk.

### 2.3. Sync Engine and Delta Calculation Integration (`src/sync/engine.ts`, `src/sync/state.ts`)
- **Pre-Flight Validation:** If `settings.enableEncryption === true` and `settings.encryptionPassword.trim() === ""`, `triggerSync()` aborts immediately with `log.notify("Configure an encryption password before syncing with encryption enabled.")`.
- **Upload Path (`executeUpload`, `executeConflict`):**
  - Read local plaintext `ArrayBuffer` (`plaintextSize = content.byteLength`).
  - Encrypt via `encryptPayload(content, cryptoContext)` producing `encryptedBuffer` (`plaintextSize + 49` bytes).
  - Route `encryptedBuffer` through `uploadContent()` (automatically using Nextcloud OC-Chunked upload if `encryptedBuffer.byteLength > thresholdBytes`).
  - Record `size: plaintextSize` and `remoteSize: encryptedBuffer.byteLength` in `SyncStateRecord`.
- **Download Path (`executeDownload`, `executeConflict`):**
  - Download `remoteBuffer` from Nextcloud.
  - Verify `isEncryptedPayload(remoteBuffer)` (`MAGIC === "VDAV"` and `byteLength >= 49`). If `enableEncryption === true` and the remote file is unencrypted (or `decryptPayload` fails due to wrong password or corrupted tag), throw a descriptive error for that file and never overwrite the local file with corrupted or undecryptable bytes.
  - Write decrypted `plaintextBuffer` to disk via `vault.adapter.writeBinary()` and store `size: plaintextBuffer.byteLength` and `remoteSize: remoteBuffer.byteLength` in `SyncStateRecord`.
- **Delta Calculation (`isRemoteModified`, `isMetadataEqual`):**
  - Update `isRemoteModified(remote, state)`: compare `remote.size` against `state.remoteSize ?? state.size` so the 49-byte encryption overhead does not cause false-positive modification detection when ETag is absent or compared alongside size.
  - When `enableEncryption === true`, `isMetadataEqual(local, remote)` checks `remote.size === local.size + 49` alongside `toSecondPrecision(local.mtime) === toSecondPrecision(remote.mtime)`.

## 3. Verification Plan
- `tests/e2ee.test.ts`:
  - Round-trip `encryptPayload` and `decryptPayload` across empty (`0 B`), small (`1 KB`), and large binary payloads produces byte-identical `ArrayBuffer` output.
  - Encrypting the same plaintext twice produces distinct salts, IVs, and ciphertexts.
  - Tampering with any byte in `MAGIC`, `VERSION`, `SALT`, `IV`, `CIPHERTEXT`, or `AUTH_TAG` causes `decryptPayload` to throw an authentication error.
  - Wrong `encryptionPassword` throws a clear decryption error without partial writes.
- `tests/engine.test.ts`:
  - Encrypted upload sends `VDAV`-prefixed ciphertext over WebDAV `PUT` while storing plaintext `size` and ciphertext `remoteSize` in `SyncStateStore`.
  - Subsequent `buildSyncPlan` run with unchanged local and remote encrypted files produces `noop` (no infinite upload/download loop from the 49-byte size difference).
  - Encrypted download decrypts payload before writing to `vault.adapter.writeBinary`.

## 4. Implementation Steps
1. Extend `VaultDavSettings` and `SyncStateRecord` in `src/types.ts`, update `src/sync/state.ts` to persist `remoteSize`, and add UI controls in `src/settings.ts`.
2. Implement `src/crypto/e2ee.ts` (`createCryptoContext`, `encryptPayload`, `decryptPayload`, `isEncryptedPayload`) using `crypto.subtle`.
3. Integrate encryption/decryption hooks and `remoteSize` delta checks into `src/sync/engine.ts`.
4. Add unit and tamper-resistance tests in `tests/e2ee.test.ts`, `tests/state.test.ts`, `tests/engine.test.ts`, and `tests/settings.test.ts`.
