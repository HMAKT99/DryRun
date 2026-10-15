# Security policy

## Reporting a vulnerability
Please report privately through GitHub: **Security → Report a vulnerability** on this repository
(https://github.com/HMAKT99/DryRun/security/advisories/new). Do not open a public issue for a vulnerability.

## What counts as a security bug
- A **wrong `safe` verdict** (Dry Run says `safe` for an action that is destructive or whose effects it could not verify).
- Any path where Dry Run **writes to a real system** (a non-GET request, a non-read-only SQL statement, a git push).
- A **secret appearing** in a report, card, log or error message.
- A **sandbox escape**, or untrusted action text being executed outside the sandbox.
- Prompt-injection that changes a verdict.

Please include the exact action (command, SQL, request), the verdict you got, and the verdict you expected. Reports with a failing test case are especially welcome.

## Supported versions
Only the latest release receives fixes. See [docs/security.md](docs/security.md) for the threat model and known limits.
