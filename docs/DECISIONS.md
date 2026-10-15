# Decisions

- **D1 Package name:** `dry-run-agents` (available on npm as of 2026-10-15), bin `dryrun`. Nothing is published without explicit approval.
- **D2 Report schema:** `schema_version: "0.1"` until after Phase 6 (MCP); freeze to 1.0 then. Avoids locking in a format before real simulators exercise it.
- **D3 Sandbox:** Docker, copied working dir, `--network none`. macOS has no cheap COW bind mounts.
- **D4 SQL parser:** decide in Phase 3 (leaning `libpg-query`; unparseable => `confirm`).
- **D5 License:** Apache-2.0.
- **D6 Verdict is conservative by construction:** `safe` requires a matched simulator, a known-benign Tier 1 classification, no unverified items and no tier errors.

## Added during the build
- **D7 `@dryrun/engine` package** (not in the original plan): shared wiring for the CLI and MCP server (simulators, read-only context, sandbox, report persistence, explain).
- **D4 resolved: `pgsql-ast-parser`** (pure JS, no native build). Unparseable SQL is reported as unverified, never `safe`. The read-only SQL gate is a conservative allowlist backed by a server-side read-only session.
- **D8 `blockUnknownEnvIrreversible` + `critical` rule:** an irreversible action in production is blocked when critical or over a threshold; a scoped `DELETE ... WHERE` in production is `confirm`, not `block`.
- **D9 Email is never `safe`:** sent mail cannot be recalled. Small sends are `confirm`; large external sends are `block`.
- **D10 Tier 3 for Postgres uses a sample** (1,000 rows/table) and labels results as sampled; exact counts always come from Tier 2.
- **D11 MCP returns text only** (no `structuredContent`): Claude Code showed only the structured part to the model and dropped the verdict instructions and untrusted-data envelope. Found in a real session.
- **D12 Path matching tolerates the base-URL prefix** (agents sent `/volumes/x` while the catalog said `/v1/volumes/x`), found in a real session; unknown operations stay `confirm`.
- **D13 Setup uses `--mcp-config`-independent config edits** with backups; formats verified against current docs for Codex (`config.toml`), Gemini (`settings.json`), Cursor (`mcp.json`); Claude Code edits `~/.claude.json`.
