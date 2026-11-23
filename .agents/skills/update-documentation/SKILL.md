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
- **`README.md`:** Include only factual setup instructions (Nextcloud App Password generation, WebDAV URL format `https://<domain>/remote.php/dav/files/<user>/<remote-base-dir>/`), available commands, settings table (using the exact Sentence case labels and bounds from `src/settings.ts`), sync behavior (referencing dynamic `<config-dir>` exclusions, not hardcoded `.obsidian`), compatibility & privacy disclosures (Desktop/Android/iOS support, Apple iOS self-signed TLS certificate blocking, HTTPS-only communication without telemetry), and build commands.
- **`AGENTS.md`:** Keep token-efficient. Update only the affected bullet points.
- **`manifest.json` & `versions.json`:** Format with 4 spaces. Enforce Obsidian Community Directory `validate-manifest` rules: keep required `id`, `name`, `version`, `minAppVersion`, `description`, and `author` fields; ensure `description` is <= 250 chars, starts with an action verb, ends with `.`, and contains no `"Obsidian"`, `"plugin"`, or emojis; ensure `isDesktopOnly` remains `false`; omit `fundingUrl` when unused; ensure optional `authorUrl` uses HTTPS and never points to `obsidian.md`; keep `package.json` `description` aligned.

## 3. Verification
1. Verify that every setting in `VaultDavSettings` (`src/types.ts`) and its exact Sentence case label and limits in `src/settings.ts` match `README.md`.
2. Verify that every file in `src/` is accurately listed in `AGENTS.md`.
3. Verify `manifest.json` and `versions.json` pass `tests/setup.test.ts` and `tests/obsidian_linter.test.ts`.
4. Do not commit changes unless explicitly instructed.
