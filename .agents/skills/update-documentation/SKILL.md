---
name: update-documentation
description: Synchronizes project documentation and metadata (README.md, AGENTS.md, manifest.json, versions.json) with the current codebase. Use after modifying settings, commands, file structure, version requirements, or public behavior.
---

# Update Documentation Workflow

Keep documentation and metadata files strictly aligned with `src/`. Avoid redundant prose across files.

## 1. Trigger Matrix
Check which files require updates based on the code change:
- **Architecture, file names, or module responsibilities changed:** Update `AGENTS.md` (Architecture & Naming section).
- **Settings (`src/settings.ts`), commands (`src/main.ts`), conflict strategies, or exclusions changed:** Update `README.md`.
- **Minimum Obsidian API version or plugin metadata changed:** Update `manifest.json` and `versions.json`.

## 2. Content Rules
- **`README.md`:** Include only factual setup instructions (Nextcloud App Password generation, WebDAV URL format `https://<domain>/remote.php/dav/files/<user>/<remote-base-dir>/`), available commands, settings table (using the exact Sentence case labels from `src/settings.ts`), sync behavior, and build commands.
- **`AGENTS.md`:** Keep token-efficient. Update only the affected bullet points.
- **`manifest.json` & `versions.json`:** Format with 4 spaces. Ensure `isDesktopOnly` remains `false`.

## 3. Verification
1. Verify that every setting in `VaultDavSettings` (`src/types.ts`) and its exact Sentence case label in `src/settings.ts` match the documentation in `README.md`.
2. Verify that every file in `src/` is accurately listed in `AGENTS.md`.
3. Do not commit changes unless explicitly instructed.
