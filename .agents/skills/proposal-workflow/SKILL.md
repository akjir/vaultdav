---
name: proposal-workflow
description: Creates, reviews, updates, and archives architectural and feature proposals in .agents/proposals/. Use when the user asks to plan a complex feature, draft a proposal, evaluate architectural changes, or change the status of an existing proposal.
---

# Proposal Workflow

Follow these steps to manage technical proposals in `.agents/proposals/` without duplicating rules from `AGENTS.md`.

## 1. File Naming and Location
- Store all proposals in `.agents/proposals/NNN-<short-kebab-title>.md` (use a 3-digit sequential number, for example `001-initial-scaffolding.md`).
- Keep filenames lowercase and concise.

## 2. Proposal Structure
Every proposal file must use this exact structure:

```markdown
# Proposal NNN: <Title>

- **Status:** Draft | Approved | Implemented | Rejected
- **Date:** YYYY-MM-DD
- **Scope:** <Affected files in src/ and tests/>

## 1. Objective
State the problem and the required outcome in 2-4 sentences.

## 2. Technical Design
List exact interface changes, data structures, WebDAV protocol interactions, or sync state transitions.

## 3. Verification Plan
List the unit tests and edge cases required in `tests/` to verify the change.

## 4. Implementation Steps
1. Ordered, atomic tasks for autonomous execution.
```

## 3. Execution Lifecycle (Argon Alignment)
- **Pre-Flight Check:** Read `AGENTS.md` and existing files in `src/` to verify technical constraints before drafting.
- **Drafting:** Create the proposal with `Status: Draft`. Surface any ambiguous edge cases to the user immediately.
- **Approval Gate:** Pause and wait for explicit user approval before writing application code. When approved, update `Status: Approved`.
- **Completion:** After all implementation steps and tests pass via `vaultdav-dev-workflow`, update `Status: Implemented`.
