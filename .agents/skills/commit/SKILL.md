---
name: commit
description: Stages and commits open changes after running the VaultDAV verification gate (or immediately with force), and optionally pushes to origin. Triggered by /commit [force] [push] [<message>].
---

# Commit Workflow

Execute on `/commit [force] [push] [<message>]`. Never edit, fix, or refactor any code or files during this workflow.

- `force`: Skip Section 1 verification.
- `push`: Push the created commit to `origin` (Section 3).
- `<message>`: Explicit commit subject (overrides auto-generated subject).

## 1. Pre-Commit Verification (Skip When `force` Is Set)
1. Run `npm run typecheck && npm test && npm run build`.
2. On non-zero exit, abort immediately. Do NOT edit files, stage, commit, or push; report the exact failure to the user.

## 2. Stage & Commit
1. Run `git status --porcelain`. If empty, report a clean working tree and stop.
2. Run `git add -A`, then verify staged changes with `git status --short` and `git diff --cached --stat`. Abort if any build or sensitive runtime files (`main.js`, `main.js.map`, `data.json`, `sync-state.json`) are staged.
3. Determine the commit subject (`AGENTS.md` language rules — English, imperative ASD-STE100, concise, no emojis): use the user's `<message>` if provided, otherwise write a concise, imperative English summary of the staged changes.
4. Run `git commit -m "<subject>"`, then report `git log -n 1 --oneline` and `git status --short`.

## 3. Push (Only When `push` Is Set)
1. Run `git push origin HEAD`.
2. Report the push result and `git status -sb`.
