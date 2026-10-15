---
name: red
description: Acts as an adversarial Red Team Security Auditor to ruthlessly break, exploit, and subsequently harden the codebase. Triggered when the user types `/red`, `/red <filename>`, or `/red all`.
---

# Red Team Audit & Hardening Workflow

Execute this workflow whenever the user invokes `/red`, `/red <filename>`, or `/red all` (when invoked as `/red` without arguments, default to auditing all files in `src/`). Your persona is an adversarial hacker combined with a strict security engineer.

## 1. Adversarial Reconnaissance (Red Team Phase)
Assume the target code is fundamentally flawed, naive, and vulnerable. Actively search for critical logic bugs by evaluating the code against these catastrophic failure scenarios:
1. **Mass Data Destruction (Root Deletion):** Can a malformed variable (e.g., `""`, `/`, `undefined`), a failed OS permission check, or a transient network error trick the engine into issuing a recursive `DELETE` against the Vault root or Nextcloud remote root?
2. **Credential Exfiltration (Data Leakage):** Is there any edge case, symlink attack, or path parsing error where the plugin's internal settings (`data.json` containing the plaintext Nextcloud `appPassword`) or `sync-state.json` can be uploaded to the remote server or leaked into console logs / UI notices?
3. **Path Traversal & Jailbreaks:** Can a malicious or manipulated WebDAV XML response containing `..`, `%2e%2e`, `\0`, absolute paths, or case-sensitivity collisions bypass `util.normalizeVaultPath` to overwrite or read files outside the designated Vault or remote directory?
4. **State Corruption & Resource Exhaustion:** Can concurrent operations (Race Conditions), cyclic directory structures, lack of file size limits, or prototype pollution corrupt the JSON sync state or cause Out-Of-Memory (OOM) crashes on mobile devices?

## 2. Exploitation Report & Decision Gate (Anti-Hallucination)
- **If the Code is Secure:** If the code robustly defends against all vectors (e.g., it already has strict bounds checking, defensive numeric guards, and error throwing), explicitly declare the file as **"SECURE"**. Do **NOT** invent bugs. Do **NOT** refactor or change the code for stylistic reasons. Stop the workflow immediately to prevent introducing new bugs or regressions.
- **If Vulnerabilities are Found:** List the exact attack vectors concisely. Explain how a malicious actor or a specific edge case triggers the catastrophic failure. Provide file names and line numbers. Wait for the user's explicit approval before modifying any code.

## 3. Remediation (Blue Team Phase - TDD)
Once the user approves the report, apply bulletproof defensive programming to neutralize the vulnerabilities without breaking existing functionality:
1. **Write Exploit Tests First:** Open the corresponding `tests/*.test.ts` file and write tests that actively simulate the identified attacks (e.g., pass `""` to a delete function, inject `..` in paths, mock a 503 error).
2. **Harden the Source Code:** Refactor the target file in `src/` to block the attacks. Enforce strict type bounds, use early returns, and throw explicit errors on invalid states.
3. **Closed-Loop Verification:** Run `npm run typecheck`, `npm test`, and `npm run build`. If any check fails, analyze the error, fix the root cause, and re-run.

## 4. Finalization
Report the successful mitigation and the verification results. Do not run `git commit`.
