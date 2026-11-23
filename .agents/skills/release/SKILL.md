---
name: release
description: Executes the end-to-end VaultDAV release workflow (tests, version alignment, changelog finalization without empty Unreleased section, production build, git commit, and X.Y.Z tag without v prefix). Triggered when the user types `/release <version>`, `/release v<version>`, or asks to release a version.
---

# VaultDAV Release Workflow (`/release`)

Execute this end-to-end workflow autonomously whenever the user invokes `/release <X.Y.Z>` or `/release v<X.Y.Z>`. Because invoking `/release` is an explicit release instruction from the user, execute the git commit and tag steps directly once all verification gates pass.

## 1. Input Parsing & Pre-Flight Validation
1. **Normalize Version & Tag:** Strip any leading `v` from the input argument to obtain `VERSION` (`X.Y.Z`) and validate that it matches strict SemVer (`^\d+\.\d+\.\d+$`). Set `TAG` to `X.Y.Z` without a leading `v` prefix (for example, `/release 0.1.0` -> `VERSION="0.1.0"`, `TAG="0.1.0"`), matching Obsidian Community Plugin requirements that the GitHub release tag matches `manifest.json` `"version"` exactly. If no valid version is provided, abort and ask the user for the target `X.Y.Z` version.
2. **Check Existing Tags:** Run `git tag -l "vX.Y.Z" "X.Y.Z"` and verify no conflicting tag exists locally (also avoid `v`-prefixed release tags on `origin`). If either tag already exists locally, abort immediately and report the conflict.
3. **Documentation, Repository Root, & Proposal Check:** Verify that required Obsidian Community Directory root files exist (`README.md`, `LICENSE`, `manifest.json`, `versions.json`), that `README.md` and `AGENTS.md` are synchronized with `src/` (per `update-documentation`), and that implemented proposals in `.agents/proposals/` have `- **Status:** Implemented`.

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
3. **`manifest.json`:** Set `"version": "X.Y.Z"`. Verify `validate-manifest` compliance (`"isDesktopOnly": false`, required `"author"`, compliant `"description"` <= 250 chars starting with an action verb, ending with `.`, without `"Obsidian"`/`"plugin"`/emojis, no unused `"fundingUrl"`) and note `"minAppVersion"`.
4. **`versions.json`:** Add or update `"X.Y.Z": "<minAppVersion>"` matching `minAppVersion` from `manifest.json`.

## 4. Changelog Finalization (`CHANGELOG.md`)
1. Verify that `CHANGELOG.md` contains non-empty release notes under `## [Unreleased]` (or `## [X.Y.Z]`). If `## [Unreleased]` is missing or empty and `## [X.Y.Z]` is not present, populate the changes from commits since the last tag (or abort if there are no changes to release).
2. Replace `## [Unreleased]` with `## [X.Y.Z] - YYYY-MM-DD` using the current local date (`YYYY-MM-DD`).
3. **No Empty `[Unreleased]`:** Do **NOT** insert or leave an empty `## [Unreleased]` heading in `CHANGELOG.md`.

## 5. Post-Bump Verification & Production Build
1. Re-run `npm run typecheck`, `npm test`, and `npm run build` to confirm all tests and metadata synchronization assertions pass with the updated version.
2. Verify that `main.js`, `manifest.json`, `versions.json`, `README.md`, and `LICENSE` exist and are non-empty.

## 6. Git Commit & Tag (`X.Y.Z`)
1. Stage all changes (`git add -A`) and inspect `git status --short` to ensure no ignored or sensitive files (`main.js`, `main.js.map`, `data.json`, `sync-state.json`) are staged.
2. Commit all staged changes:
   `git commit -m "Release X.Y.Z"`
3. Create an annotated git tag without a `v` prefix:
   `git tag -a X.Y.Z -m "Release X.Y.Z"`
4. Verify the commit and tag (`git status --short`, `git log -n 1 --oneline`, `git tag -l -n1 X.Y.Z`) and report the release summary to the user, reminding them to push `main` and tag `X.Y.Z` (exact match to `manifest.json` `"version"`) and attach the compiled `main.js` and `manifest.json` as binary GitHub Release assets (`styles.css` is not required).
