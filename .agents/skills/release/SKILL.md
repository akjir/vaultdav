---
name: release
description: Executes the end-to-end VaultDAV release workflow (tests, version alignment, changelog finalization without empty Unreleased section, production build, git commit, and vX.Y.Z tag). Triggered when the user types `/release <version>`, `/release v<version>`, or asks to release a version.
---

# VaultDAV Release Workflow (`/release`)

Execute this end-to-end workflow autonomously whenever the user invokes `/release <X.Y.Z>` or `/release v<X.Y.Z>`. Because invoking `/release` is an explicit release instruction from the user, execute the git commit and tag steps directly once all verification gates pass.

## 1. Input Parsing & Pre-Flight Validation
1. **Normalize Version & Tag:** Strip any leading `v` from the input argument to obtain `VERSION` (`X.Y.Z`) and validate that it matches strict SemVer (`^\d+\.\d+\.\d+$`). Set `TAG` to `vX.Y.Z` (for example, `/release 0.1.0` -> `VERSION="0.1.0"`, `TAG="v0.1.0"`). If no valid version is provided, abort and ask the user for the target `X.Y.Z` version.
2. **Check Existing Tags:** Run `git tag -l "vX.Y.Z" "X.Y.Z"`. If the tag already exists, abort immediately and report the conflict.
3. **Documentation & Proposal Check:** Verify that `README.md` and `AGENTS.md` are synchronized with `src/` (per `update-documentation`), and that implemented proposals in `.agents/proposals/` have `- **Status:** Implemented`.

## 2. Pre-Release Verification Gate
Run the full verification suite before modifying metadata:
1. Run `npm run typecheck` (`tsc --noEmit`).
2. Run `npm test` (`vitest run` — all unit, security, metadata, zero-dependency, and `tests/obsidian_linter.test.ts` checks must pass).
3. Run `npm run build` (`node esbuild.config.mjs production`).
If any check fails, abort the release immediately and report the error.

## 3. Version Alignment
Ensure all version-bearing files are set to `"X.Y.Z"` (formatted with 4 spaces):
1. **`package.json`:** Set `"version": "X.Y.Z"`.
2. **`package-lock.json`:** Set root `"version": "X.Y.Z"` and `packages[""].version` to `"X.Y.Z"`.
3. **`manifest.json`:** Set `"version": "X.Y.Z"`. Verify `"isDesktopOnly": false` and note `"minAppVersion"`.
4. **`versions.json`:** Add or update `"X.Y.Z": "<minAppVersion>"` matching `minAppVersion` from `manifest.json`.

## 4. Changelog Finalization (`CHANGELOG.md`)
1. Verify that `CHANGELOG.md` contains non-empty release notes under `## [Unreleased]` (or `## [X.Y.Z]`). If `## [Unreleased]` is missing or empty and `## [X.Y.Z]` is not present, populate the changes from commits since the last tag (or abort if there are no changes to release).
2. Replace `## [Unreleased]` with `## [X.Y.Z] - YYYY-MM-DD` using the current local date (`YYYY-MM-DD`).
3. **No Empty `[Unreleased]`:** Do **NOT** insert or leave an empty `## [Unreleased]` heading in `CHANGELOG.md`.

## 5. Post-Bump Verification & Production Build
1. Re-run `npm run typecheck`, `npm test`, and `npm run build` to confirm all tests and metadata synchronization assertions pass with the updated version.
2. Verify that `main.js`, `manifest.json`, and `versions.json` exist and are non-empty.

## 6. Git Commit & Tag (`vX.Y.Z`)
1. Stage all changes (`git add -A`) and inspect `git status --short` to ensure no ignored or sensitive files (`main.js`, `main.js.map`, `data.json`, `sync-state.json`) are staged.
2. Commit all staged changes:
   `git commit -m "Release vX.Y.Z"`
3. Create an annotated git tag:
   `git tag -a vX.Y.Z -m "Release vX.Y.Z"`
4. Verify the commit and tag (`git status --short`, `git log -n 1 --oneline`, `git tag -l -n1 vX.Y.Z`) and report the release summary to the user.
