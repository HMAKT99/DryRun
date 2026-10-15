# Read-only credentials for Dry Run

Dry Run only needs to *read*. Give it credentials that can do nothing else. It warns when it can tell a credential is broader than needed: Postgres roles with write privileges or superuser, provider tokens whose introspection endpoint reports account-wide scope, and (in `dryrun doctor`) env vars that look like full-access keys. It never treats a powerful credential as a reason to relax a verdict.

| Target | Environment variable | How to create it |
|---|---|---|
| Postgres | `DRYRUN_DATABASE_URL` | `CREATE ROLE dryrun_ro LOGIN PASSWORD '...'; GRANT pg_read_all_data TO dryrun_ro;` Dry Run also opens the session with `default_transaction_read_only=on`. |
| Stripe | `DRYRUN_STRIPE_READONLY_TOKEN` | Restricted key (`rk_live_…`) with **Read** on Charges, Customers, Subscriptions only. |
| GitHub | `DRYRUN_GITHUB_READONLY_TOKEN` | Fine-grained token, repository permissions **read-only** on Metadata, Contents (needed for branch and compare lookups), Pull requests and Administration. |
| Slack | `DRYRUN_SLACK_READONLY_TOKEN` | Bot token with `channels:read`, `groups:read` only (no `chat:write`). |
| Railway / Vercel / others | `DRYRUN_<PROVIDER>_READONLY_TOKEN` | A read-only/viewer token if the provider offers one. |
| Any provider base URL | `DRYRUN_<PROVIDER>_BASE_URL` | Overrides the catalog URL (self-hosted, mocks). |

Pass **names, not values**, to the agent: `context.db_url_ref` / `readonly_token_ref` / `credential_ref` are env var *names*. The MCP server rejects a URL in `db_url_ref` so credentials never pass through the agent transcript.

Where do the env vars live? In the environment of the MCP server process. Either export them in the shell that launches your agent, or set them on the registered server. For Claude Code, edit the `dry-run` entry that `setup` wrote to `~/.claude.json` (the `env` object is empty by default):

```json
"dry-run": { "type": "stdio", "command": "npx", "args": ["-y", "dry-run-agents", "mcp"],
             "env": { "DRYRUN_DATABASE_URL": "postgres://dryrun_ro:...@host/db" } }
```

Codex (`~/.codex/config.toml`): `[mcp_servers.dry-run.env]` table. Cursor and Gemini: the `env` object of the server entry. Keep these files out of version control. `credential_ref` names the credential the *agent* will use for the real action; Dry Run uses it only to ask the provider what that credential can do (token introspection), never to mutate.

If no read-only credential is set, Dry Run can fall back to the agent's own credential for **GET-only** lookups and says so in the report. Prefer a dedicated read-only one.
