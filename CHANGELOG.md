# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added
- Implement dual declarative settings support (`getSettingDefinitions()`, `getControlValue()`, and `setControlValue()`) in `VaultDavSettingTab` for Obsidian 1.13+ settings search while preserving the `display()` fallback for Obsidian 1.11.4 to 1.12.x.

### Changed
- Enforce zero `eslint-plugin-obsidianmd` warnings (`fatal === 0`, `errors === 0`, `warnings === 0`) in `.github/workflows/release.yml` and the `/release` workflow.

## [1.1.0] - 2026-11-24

### Added
- Add GitHub Actions workflows for pull request/push verification (`.github/workflows/ci.yml`) and SemVer tag-triggered release publishing (`.github/workflows/release.yml`).
- Generate GitHub build provenance attestations for `main.js` and `manifest.json` in `.github/workflows/release.yml`.

### Changed
- Store Nextcloud app passwords in Obsidian `SecretStorage` via `SecretComponent` instead of plaintext in `data.json`, and raise `minAppVersion` to `1.11.4`.
- Automatically migrate legacy plaintext `appPassword` values from `data.json` into Obsidian `SecretStorage` and scrub legacy password fields and embedded URL credentials on load.
- Fetch app passwords on demand during WebDAV requests without retaining plaintext passwords in `VaultDavSettings` or long-lived `WebDavClient` state, and redact sensitive tokens from logged error stack traces.

### Fixed
- Avoid chained `.setHeading()` on helper calls in settings UI to prevent fatal ESLint crashes in `eslint-plugin-obsidianmd`.
- Include `vitest.config.ts` in `tsconfig.json` for TypeScript Project Service compatibility.
- Use `window`-scoped timers and remove unnecessary type assertions and redundant variable assignments for `eslint-plugin-obsidianmd` compliance.

## [1.0.0] - 2026-11-23

### Added
- Initial release of VaultDAV.
