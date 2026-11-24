# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added
- Add a dockable sync log view with run history, upload/download byte totals, file-level sync events, active conflicts, and Markdown export.
- Add device-local sync history with configurable retention and automatic storage limits.
- Show a clickable Desktop status bar indicator when a sync finishes with errors.

### Changed
- Synchronize vault content only by excluding the Obsidian configuration directory and hidden files without deleting existing files.

### Fixed
- Harden local sync state and history storage against invalid paths, concurrent writes, and oversized files.
- Harden the sync log view against unsafe file opening, excluded path exposure, unredacted clipboard exports, and view lifecycle race conditions.
- Improve credential redaction in sync logs to handle malformed URLs safely.

## [1.2.0] - 2026-11-24

### Added
- Support Obsidian 1.13+ settings search while maintaining compatibility with Obsidian 1.11.4 to 1.12.x.

### Changed
- Enforce zero-warning Obsidian plugin checks during releases.

### Fixed
- Harden WebDAV path parsing and exclusion checks against path traversal, spoofing, and filter bypasses.
- Prevent orphaned background transfer requests when a sync fails.

## [1.1.0] - 2026-11-24

### Added
- Add automated CI checks and attested GitHub Release publishing.

### Changed
- Store Nextcloud app passwords in Obsidian SecretStorage instead of plaintext settings (requires Obsidian 1.11.4 or newer).
- Migrate legacy plaintext passwords automatically on load and redact sensitive credentials from URLs and error logs.

### Fixed
- Fix Obsidian plugin review and build configuration issues.

## [1.0.0] - 2026-11-23

### Added
- Initial release of VaultDAV.
