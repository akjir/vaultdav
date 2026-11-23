# Contributing to VaultDAV

Thank you for your interest in contributing to VaultDAV.

## Scope

VaultDAV synchronizes Obsidian vaults bidirectionally with Nextcloud over WebDAV on Desktop, Android, and iOS (`isDesktopOnly: false`).

- Keep zero runtime, peer, and optional dependencies in `package.json`.
- Limit `src/` imports strictly to `"obsidian"` and relative local modules (`./`, `../`).
- Do not add Node.js built-in modules (`fs`, `path`, `http`, `crypto`, `node:*`) or non-Nextcloud storage backends.
- Edit modular TypeScript files in `src/`. Never edit or commit the compiled `main.js`.

## Development Setup

1. Install Node.js 20 or newer.
2. Clone the repository and install development dependencies:

```bash
npm install
```

3. Run the verification suite:

```bash
npm run typecheck
npm test
npm run build
```

For incremental local builds during development, run `npm run dev`.

## Code Standards

- Use 4-space indentation and remove trailing spaces.
- Write strict TypeScript without `any` or `@ts-ignore`.
- Initialize all variables explicitly.
- Sort functions and class methods alphabetically.
- Define static `Set`, `Map`, and `RegExp` constants at module scope in `UPPER_SNAKE_CASE`.
- Execute all WebDAV requests through Obsidian `requestUrl` and all vault I/O through `app.vault` or `app.vault.adapter`.
- Derive configuration directory paths dynamically from `Vault#configDir` instead of hardcoding `.obsidian`.
- Use Sentence case for all UI strings, commands, tooltips, and notices.
- Write all code, comments, tests, documentation, and commit messages in concise English without emojis.

## Testing

Add or update unit tests in `tests/` for every new feature, sync state transition, XML parser case, security check, or bug fix. Ensure `tests/obsidian_linter.test.ts` and `tests/setup.test.ts` pass before opening a pull request.

## Pull Requests

1. Create a focused branch from `main`.
2. Update `CHANGELOG.md` under `## [Unreleased]` for user-facing or architectural changes.
3. Update `README.md` and `AGENTS.md` when settings, commands, file structure, or public behavior change.
4. Run `npm run typecheck`, `npm test`, and `npm run build` and verify that all checks pass.
5. Open a pull request against `main` using the repository pull request template.
