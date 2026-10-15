---
name: vaultdav-dev-workflow
description: Executes the test-driven development (TDD), build, verification loop, and CHANGELOG.md updates for VaultDAV. Use when implementing features, fixing bugs, writing tests, refactoring code in src/, or updating CHANGELOG.md.
---

# VaultDAV Development Workflow

Execute this closed-loop workflow for all code changes in `src/` and `tests/`.

## 1. Pre-Flight Check
1. Verify all target files against `AGENTS.md` architecture rules.
2. If the task changes architecture or adds complex logic, verify whether an approved proposal exists in `.agents/proposals/`.

## 2. Test-Driven Development (TDD) Loop
Execute changes autonomously in this strict sequence until all checks pass with zero regressions:
1. **Write or Update Tests First:** Add unit tests in `tests/` covering happy paths, error status codes (`401`, `403`, `404`, `409`, `423`, `507`), XML edge cases, sync conflict states, path boundary/traversal safety (`.`, `..`, prefix collisions), and `NaN`/non-finite numeric inputs.
2. **Implement Minimal Modular Code:** Edit files in `src/`. Ensure:
   - Zero external dependencies (import only from `"obsidian"` or relative `./` and `../` modules; never add npm packages).
   - 4-space indentation, alphabetical function/method sorting, explicit variable initialization, and zero `any` types.
   - **Zero Hot-Path Allocations:** Define static `Set`, `Map`, and `RegExp` instances at module top-level (`UPPER_SNAKE_CASE`), never inside functions called per-file or per-request.
   - **Strict Path Boundary & Traversal Safety:** Always verify `/` or end-of-string boundaries when stripping URL/path prefixes. Reject any path containing `.` or `..` segments.
   - **Defensive Numeric Guards:** Validate numeric inputs (`timestamp`, `mtime`, `size`, `concurrency`) with `Number.isFinite()` before arithmetic or `Date` construction.
   - **Obsidian Linter Compliance (`eslint-plugin-obsidianmd`):** Verify all changes against `no-inner-html`, `ui/sentence-case`, command naming (`no-plugin-id-in-command-id`, `no-plugin-name-in-command-name`, `no-default-hotkeys`), settings headings, and lifecycle registration (`registerInterval`, `registerEvent`, no `detachLeavesOfType` in `onunload`).
3. **Run Closed-Loop Verification:**
   - Run `npm run typecheck` (must exit with 0 errors).
   - Run `npm test` (all unit, zero-dependency, and `tests/obsidian_linter.test.ts` checks must pass).
   - Run `npm run build` (must bundle `main.js` cleanly via ESBuild `zero-external-dependencies` guard).
4. **Self-Correction:** If any check fails, analyze the output, fix the root cause in `src/` or `tests/`, and re-run step 3 until all three checks pass.

## 3. Changelog Maintenance (`CHANGELOG.md`)
Update `CHANGELOG.md` under the `## [Unreleased]` section (create `## [Unreleased]` above the latest release heading if absent) for every user-facing or architectural change:
- Use Keep a Changelog categories: `### Added`, `### Changed`, `### Fixed`, `### Removed`.
- Write entries in the imperative mood (ASD-STE100), starting with a verb.
- Do not add redundant implementation details already visible in git diffs.

## 4. Post-Execution Sync
- Run `update-documentation` if settings, commands, file names, or architecture changed.
- Stop and report verification results. Do not run `git commit` unless explicitly instructed.
