# Read-only credentials for Dry Run

Dry Run only needs to *read*. Give it credentials that can do nothing else. It warns when a credential it was given can write (and refuses to treat that as a reason to relax anything).

| Target | Environment variable | How to create it |
|---|---|---|
| Postgres | `DRYRUN_DATABASE_URL` | `CREATE ROLE dryrun_ro LOGIN PASSWORD '...'; GRANT pg_read_all_data TO dryrun_ro;` Dry Run also opens the session with `default_transaction_read_only=on`. |
| Stripe | `DRYRUN_STRIPE_READONLY_TOKEN` | Restricted key (`rk_live_…`) with **Read** on Charges, Customers, Subscriptions only. |
| GitHub | `DRYRUN_GITHUB_READONLY_TOKEN` | Fine-grained token, repository permissions: Metadata, Pull requests, Administration: **read-only**. |
| Slack | `DRYRUN_SLACK_READONLY_TOKEN` | Bot token with `channels:read`, `groups:read` only (no `chat:write`). |
| Railway / Vercel / others | `DRYRUN_<PROVIDER>_READONLY_TOKEN` | A read-only/viewer token if the provider offers one. |
| Any provider base URL | `DRYRUN_<PROVIDER>_BASE_URL` | Overrides the catalog URL (self-hosted, mocks). |

Pass **names, not values**, to the agent: `context.db_url_ref` / `readonly_token_ref` / `credential_ref` are env var *names*. The MCP server rejects a URL in `db_url_ref` so credentials never pass through the agent transcript.

Where do the env vars live? In the environment of the MCP server process (your agent's environment). `credential_ref` names the credential the *agent* will use for the real action; Dry Run uses it only to ask the provider what that credential can do (token introspection), never to mutate.

If no read-only credential is set, Dry Run can fall back to the agent's own credential for **GET-only** lookups and says so in the report. Prefer a dedicated read-only one.
