## Summary

Describe the change and why it is needed.

## Related Issue

Closes #

## Verification Checklist

- [ ] Keeps zero runtime dependencies (imports in `src/` use only `"obsidian"` and relative paths).
- [ ] Preserves Desktop and Mobile compatibility (`isDesktopOnly: false`) and uses `Vault#configDir` dynamically.
- [ ] Uses Obsidian `requestUrl` for all HTTP/WebDAV requests and `ArrayBuffer` for binary file transfers.
- [ ] Follows code style (4-space indentation, strict TypeScript without `any`, alphabetically sorted functions and methods, Sentence case UI labels).
- [ ] `npm run typecheck` passes without errors.
- [ ] `npm test` passes (including `tests/obsidian_linter.test.ts` and `tests/setup.test.ts`).
- [ ] `npm run build` succeeds cleanly.
- [ ] `CHANGELOG.md` is updated under `## [Unreleased]`.
- [ ] `README.md` and `AGENTS.md` are updated if settings, commands, or architecture changed.
