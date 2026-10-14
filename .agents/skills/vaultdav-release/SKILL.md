---
name: vaultdav-release
description: Prepares and verifies an official VaultDAV release. Use when the user asks to bump the version, prepare a release, finalize CHANGELOG.md, or tag a release version.
---

# VaultDAV Release Workflow

Follow this checklist to prepare a deterministic Obsidian plugin release.

## 1. Pre-Release Verification Gate
Run all verification checks before modifying version numbers:
1. Run `npm run typecheck`.
2. Run `npm test`.
3. Run `npm run build`.
4. Run `git status` to inspect modified or untracked files.
If any test or build step fails, abort the release process immediately and report the error.

## 2. Version Bump & Metadata Alignment
When the target version `X.Y.Z` is specified:
1. **`package.json`:** Set `"version": "X.Y.Z"`.
2. **`manifest.json`:** Set `"version": "X.Y.Z"`.
3. **`versions.json`:** Add or update the mapping `"X.Y.Z": "<minAppVersion>"` (matching `minAppVersion` from `manifest.json`).

## 3. Changelog Finalization
In `CHANGELOG.md`:
1. Rename `## [Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD` (use the current date).
2. Insert a fresh empty `## [Unreleased]` section above it.

## 4. Production Build & Approval Gate
1. Run `npm run build` to generate the production `main.js` artifact.
2. Verify that `main.js`, `manifest.json`, and `versions.json` exist and are valid.
3. **Stop and Ask for Confirmation:** Present a summary of changed files and the proposed git commit/tag commands (`git commit -m "Release vX.Y.Z"`, `git tag X.Y.Z`). Wait for explicit user instruction before executing any git commit or tag command.
