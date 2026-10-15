# Security model and review notes

## Threat model
The action being rehearsed (command, SQL, API payload) and everything read back from inspected systems are untrusted. They may be malicious or contain prompt injections. Dry Run's job is to never be the thing that makes them effective.

## Controls
- **No writes to real systems.** `createReadOnlyHttp` exposes `get` and `graphqlQuery` only; mutations/subscriptions throw before any I/O. `assertReadOnlySql` allows a single SELECT/EXPLAIN/SHOW, rejects `EXPLAIN ANALYZE`, `SELECT INTO`, locking clauses, data-modifying CTEs and side-effect functions; the session is also server-side read-only with a statement timeout. Both are covered by tests, and the mock providers record every request.
- **Sandbox (Docker).** `--network none`, `--cap-drop ALL`, `--security-opt no-new-privileges`, `--read-only` rootfs with a small tmpfs, non-root host uid, CPU/memory/swap/pid limits, wall-clock timeout with `docker kill`, `--rm` plus explicit removal in `finally`. The working directory is a *copy* (size and file caps; over the cap ⇒ Tier 3 skipped). Symlinks are copied verbatim and not followed; the host path is never mounted. SQL rehearsal runs a Postgres container with no network; schema is dumped by a separate short-lived container that holds the read-only credential, and sampled rows are streamed in through `docker exec` stdin.
- **Git.** Remote fetches run in a throwaway bare repo, with `ext::`/`fd::` transports disabled (`GIT_ALLOW_PROTOCOL`), `core.fsmonitor=false`, hooks disabled, URLs starting with `-` refused, no prompts. Tested against an `ext::` remote.
- **Redaction.** One redactor, applied at report construction to every string and key, plus registered exact secrets (loaded tokens). Tested end to end across stdout, stderr, JSON, saved reports and SVG cards.
- **Untrusted output.** Target-derived strings are length-capped and control-character-stripped; MCP output is wrapped and labeled as data; report ids are validated as UUIDs (no path traversal).
- **Fail closed.** Invalid config, missing credentials, unreachable systems, Docker absent, parse failures and internal errors all produce `confirm` (or `block`) with the reason, never `safe`.

## Known limits
- Tier 3 copies the project, not its environment: env vars, services, network and non-Linux tools differ. Reports mark these as unverified.
- Shell semantics are unbounded; dynamic constructs (`$(…)`, variables, globs, scripts) make a command unverifiable, so it cannot be `safe`.
- Read-only calls still reach real systems with the credentials you provide (e.g. `git fetch` against your remote, `pg_dump` for Tier 3 from a container that can reach your database). Use read-only credentials.
- The SQL gate is a conservative allowlist, not a parser-proof; the server-side read-only session is the backstop. Do not point Dry Run at a role with more privileges than needed.
- Resolvers for Railway/Vercel are unverified against live APIs.

Report vulnerabilities privately; see [SECURITY.md](../SECURITY.md). A wrong `safe` verdict is treated as a security bug.
