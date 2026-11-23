# Security Policy

## Supported Versions

Security fixes apply to the latest published release of VaultDAV.

| Version | Supported |
| :--- | :--- |
| Latest release | Yes |
| Older releases | No |

## Reporting a Vulnerability

Do not open a public GitHub issue for security vulnerabilities.

Report suspected vulnerabilities privately through [GitHub Security Advisories](https://github.com/akjir/vaultdav/security/advisories/new).

Include the following details in your report:

- Affected VaultDAV version and platform (Desktop, Android, or iOS).
- Description of the vulnerability and potential impact (for example, credential exposure, path traversal, or unintended data deletion).
- Minimal reproduction steps or proof of concept without live personal credentials.

## Security Model

- VaultDAV requires HTTPS for Nextcloud WebDAV endpoints and rejects embedded URL credentials and query strings.
- All network traffic goes exclusively through Obsidian `requestUrl` to the user-configured Nextcloud server with zero telemetry or third-party runtime dependencies.
- App passwords are stored in Obsidian `SecretStorage` (Obsidian 1.11.4+) rather than plaintext in `<config-dir>/plugins/vaultdav/data.json`. Only the secret reference ID (`appPasswordSecret`) is saved in `data.json` (which is also excluded from synchronization). Legacy plaintext `appPassword` fields and embedded URL credentials in `data.json` are migrated or scrubbed automatically on load.
- Sensitive authorization headers and URL userinfo are redacted from logs, error stack traces, status bar updates, and notices.
