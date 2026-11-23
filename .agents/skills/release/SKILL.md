---
name: release
description: Executes the end-to-end VaultDAV release workflow (pre-release typecheck, tests, build, and eslint-plugin-obsidianmd scan, version alignment, changelog finalization without empty Unreleased section, git commit/tag/push without v prefix, and attested GitHub Release verification via gh). Triggered when the user types `/release <version>`, `/release v<version>`, or asks to release a version.
---

# VaultDAV Release Workflow (`/release`)

Execute this end-to-end workflow autonomously whenever the user invokes `/release <X.Y.Z>` or `/release v<X.Y.Z>`. Because invoking `/release` is an explicit release instruction from the user, execute the git commit, tag, push, and GitHub Release verification steps directly once all verification gates pass.

## 1. Input Parsing & Pre-Flight Validation
1. **Normalize Version & Tag:** Strip any leading `v` from the input argument to obtain `VERSION` (`X.Y.Z`) and validate strict SemVer (`^\d+\.\d+\.\d+$`). Set `TAG` to `X.Y.Z` without a leading `v` prefix (exact match to `manifest.json` `"version"`). If no valid version is provided, abort and ask the user for `X.Y.Z`.
2. **Verify `gh` CLI & Repository:** Run `gh auth status` and resolve `REPO` via `gh repo view --json nameWithOwner --jq .nameWithOwner`. Abort immediately if `gh` is unavailable or unauthenticated.
3. **Check Conflicting Tags & Releases:**
   - Local tags: `git tag -l "vX.Y.Z" "X.Y.Z"` must return empty.
   - Remote tags: `git ls-remote --tags origin "refs/tags/X.Y.Z" "refs/tags/vX.Y.Z"` must return empty.
   - GitHub Releases: `gh release view X.Y.Z` and `gh release view vX.Y.Z` must report not found.
   Abort immediately on any conflict.
4. **Repository, Workflow, & Documentation Check:** Verify that required root files exist (`README.md`, `LICENSE`, `manifest.json`, `versions.json`), `.github/workflows/release.yml` includes `actions/attest-build-provenance` and `gh release create` with `main.js` and `manifest.json`, `README.md` and `AGENTS.md` match `src/` (per `update-documentation`), and implemented proposals in `.agents/proposals/` have `- **Status:** Implemented`.

## 2. Pre-Release Verification Gate
Run the full verification suite before modifying metadata:
1. `npm run typecheck` (`tsc --noEmit`).
2. `npm test` (`vitest run` — all unit, security, metadata, zero-dependency, and `tests/obsidian_linter.test.ts` checks must pass).
3. `npm run build` (`node esbuild.config.mjs production`).
4. **Obsidian ESLint Scanner Check (`eslint-plugin-obsidianmd`):**
   Execute in isolated temporary directories (never modify `package.json`, `package-lock.json`, or repository `node_modules/` to keep zero external dependencies):
   - Copy the repository (excluding `.git` and `node_modules/.cache`) to `$TMP_REPO`.
   - Install `eslint@9`, `typescript@5.9`, `typescript-eslint`, and `eslint-plugin-obsidianmd@latest` in `$TMP_TOOLS`.
   - Run ESLint with `obsidianmd.configs.recommended` and `languageOptions.parserOptions = { projectService: true, tsconfigRootDir: TMP_REPO }`, ignoring `node_modules/**`, `dist/**`, `build/**`, `main.js`, `esbuild.config.mjs`, `**/tests/**`, and `**/*.test.*` (keeping `src/**`, `vitest.config.ts`, `manifest.json`, `package.json`, and `LICENSE` in scope).
   - Require `fatal === 0` and `errors === 0` (advisory `warn` diagnostics such as `obsidianmd/settings-tab/prefer-setting-definitions` are non-blocking).
   - Remove `$TMP_REPO` and `$TMP_TOOLS` on exit.
If any check fails, abort the release immediately and report the exact failure.

## 3. Version Alignment
Set all version-bearing files to `"X.Y.Z"` (4-space indentation):
1. **`package.json`:** Set `"version": "X.Y.Z"`.
2. **`package-lock.json`:** Set root `"version": "X.Y.Z"` and `packages[""].version` to `"X.Y.Z"`.
3. **`manifest.json`:** Set `"version": "X.Y.Z"`. Verify `validate-manifest` compliance (`"isDesktopOnly": false`, required `"author"`, compliant `"description"` <= 250 chars starting with an action verb, ending with `.`, without `"Obsidian"`/`"plugin"`/emojis, no unused `"fundingUrl"`) and note `"minAppVersion"`.
4. **`versions.json`:** Add or update `"X.Y.Z": "<minAppVersion>"` matching `minAppVersion` from `manifest.json`.

## 4. Changelog Finalization (`CHANGELOG.md`)
1. Verify `CHANGELOG.md` contains non-empty release notes under `## [Unreleased]` (or `## [X.Y.Z]`). If missing or empty, populate changes from commits since the last tag (or abort if there are no changes to release).
2. Replace `## [Unreleased]` with `## [X.Y.Z] - YYYY-MM-DD` using the current local date (`YYYY-MM-DD`).
3. **No Empty `[Unreleased]`:** Never insert or leave an empty `## [Unreleased]` heading in `CHANGELOG.md`.

## 5. Post-Bump Verification & Production Build
1. Re-run `npm run typecheck`, `npm test`, `npm run build`, and the Section 2 `eslint-plugin-obsidianmd` scanner check to confirm all checks pass with the updated `manifest.json` and `package.json`.
2. Verify `main.js`, `manifest.json`, `versions.json`, `README.md`, and `LICENSE` exist and are non-empty.

## 6. Git Commit, Tag (`X.Y.Z`), & Push
1. Stage all changes (`git add -A`) and inspect `git status --short` to ensure no ignored or sensitive files (`main.js`, `main.js.map`, `data.json`, `sync-state.json`) are staged.
2. Commit: `git commit -m "Release X.Y.Z"`
3. Create an annotated tag without a `v` prefix: `git tag -a X.Y.Z -m "Release X.Y.Z"`
4. Push branch and tag to `origin` to trigger `.github/workflows/release.yml`:
   `git push origin HEAD && git push origin X.Y.Z`

## 7. GitHub Release & Artifact Attestation Verification (`gh`)
GitHub build provenance attestations (`actions/attest-build-provenance`) require GitHub Actions OIDC signing and cannot be generated locally. Never bypass `.github/workflows/release.yml` by calling `gh release create` manually.
1. Resolve `COMMIT_SHA=$(git rev-parse X.Y.Z^{commit})` and find the triggered workflow run:
   `gh run list --workflow release.yml --commit "$COMMIT_SHA" --event push --limit 1 --json databaseId,status,conclusion,url`
   If GitHub has not registered the run yet, wait briefly (without a shell `sleep` loop) and query again.
2. Monitor the workflow run until completion:
   `gh run watch <run-id> --exit-status`
   If the run fails, inspect `gh run view <run-id> --log-failed`, abort, and report the exact failure.
3. Verify the published GitHub Release via `gh release view X.Y.Z --json tagName,isDraft,isPrerelease,url,assets`:
   - `tagName` equals `"X.Y.Z"` (no leading `v`).
   - `isDraft` is `false` and `isPrerelease` is `false`.
   - `assets` includes both `main.js` and `manifest.json` with `size > 0` (`styles.css` is not required).
4. Download the published assets into a temporary directory `$TMP_VERIFY` and verify provenance attestations and byte-for-byte parity:
   - `gh release download X.Y.Z -p main.js -p manifest.json -D "$TMP_VERIFY"`
   - `gh attestation verify "$TMP_VERIFY/main.js" --repo "$REPO" --signer-workflow "$REPO/.github/workflows/release.yml"`
   - `gh attestation verify "$TMP_VERIFY/manifest.json" --repo "$REPO" --signer-workflow "$REPO/.github/workflows/release.yml"`
   - `cmp -s main.js "$TMP_VERIFY/main.js"` and `cmp -s manifest.json "$TMP_VERIFY/manifest.json"`
   - Remove `$TMP_VERIFY` on exit.
5. Report the final release summary: commit SHA, tag `X.Y.Z`, workflow run URL, GitHub Release URL, verified assets (`main.js`, `manifest.json`), attestation verification status, and byte-for-byte parity check.
