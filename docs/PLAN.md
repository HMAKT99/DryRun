> **Historical document.** This is the original planning draft written before the build. It is kept for context; several open questions in it were later decided. See [DECISIONS.md](DECISIONS.md) for what changed and why, and the [README](../README.md) for how things work today.

# Dry Run — PLAN.md (draft for review)

## Context
Agents can't picture consequences before acting (the April 2026 nine-second prod-DB deletion). Dry Run is a local-first, read-only "rehearse before you act" tool exposed to any coding agent via MCP + CLI. It reports; it never executes (principle 5). A wrong `safe` verdict is treated as a security bug.

Environment findings: `/Users/arun/dryrun` is empty, not a git repo. Node v24.9 and Docker 28.5 present. npm: `dry-run-agents` is **available** (404); `dryrun` is **taken** as a package name, but we only need it as a `bin` name, which is fine.

On approval, first action is to write this as `/Users/arun/dryrun/PLAN.md` (+ `DECISIONS.md`), `git init`, then start Phase 1. Nothing else is built before your go-ahead on the open questions below.

## Architecture
- TypeScript strict, Node LTS (22 target; dev on 24), npm workspaces + `tsc -b` project references, `vitest` for tests, ESM only.
- Packages: `core`, `mcp`, `cli`, `sim-postgres`, `sim-shell`, `sim-terraform`, `sim-cloud`, `sim-saas`, plus `catalog/` (YAML/JSON op catalogs, validated by zod schema) and `demos/` (mock providers + scenarios).
- `core`: `Action`, `Finding`, `Report` types (zod-derived); `Simulator` interface exactly as in spec; `Orchestrator` (pick simulators via `canHandle`, run tiers 1→2→3, record which tiers ran / failed / were skipped); `PolicyEngine`; `Redactor`; `Sandbox` (Docker); `ReadOnlyContext`; report renderers (JSON, terminal, SVG card).
- **Finding** carries: `effect` text, `reversibility`, `blast` (rows/files/bytes/money/people), `envSignal`, `evidence[]` (tier, source, readonly call made), `unverified[]`, `severity`. Every report claim must reference an evidence id (enforced by a validator in core; report without evidence for a claim fails tests).
- **Verdict rules (conservative by construction):** `safe` only if (a) at least one simulator matched, (b) Tier 1 classified the action as known-benign, (c) no `unverified` entries, (d) no tier errored. Anything else → `confirm` minimum. Unknown action type/operation → `confirm`. `block` when irreversible ∧ (production ∨ unknown-env-with-data) or thresholds exceeded. Thresholds in `dryrun.config.json`.
- **Never-write guarantee (structural, not just policy):**
  - `ReadOnlyContext` exposes only typed read methods (`pgQuery` limited to a SELECT/EXPLAIN allowlist validated by parser + executed in `BEGIN READ ONLY` with `default_transaction_read_only=on`; `http.get`/`head` only, plus allowlisted POST for known read-only GraphQL/search endpoints declared in the catalog).
  - A test harness wraps every network/db/fs call and asserts no non-read method is invoked on real targets across all simulators and demos (mock providers record every request; test fails on any non-GET/non-allowlisted request).
  - Note: spec forbids `BEGIN…ROLLBACK` on the real DB; we use only read-only transactions for inspection queries and never execute the user's statement there (only `EXPLAIN` without `ANALYZE`, and `SELECT count(*)` derived from the WHERE clause).
- **Redaction:** central `Redactor` applied at report construction, log writer, and MCP output; pattern + entropy + known-secret registry (env values, URL passwords, `Authorization` headers, provider token formats). Test: fuzz corpus of secrets never appears in any output.
- **Untrusted content:** MCP outputs wrap inspected-system text in a clearly marked `<untrusted_data>` envelope plus a schema field `untrusted: true`; strings from the target are length-capped and control-char stripped; instruction-like text is never interpreted by us.

## Simulators (build order, phases map to your spec)
1. **sim-shell** (+ git): tokenizer via `shell-quote`/bash-parser for classification (rm, mv, chmod, dd, git push -f, reset --hard, clean, publish, pipes/`sh -c`/`curl|sh`, path escapes outside project/`~`/`/`). Tier 3: Docker container, project copied into a tmp dir (copy for small trees; overlay/COW is not available on macOS Docker bind mounts, so v1 = copy with size cap, fallback to Tier 1+2 if over cap), `--network none`, cpu/mem/pids/time limits, read-only root fs, dropped caps, non-root; diff via before/after content-hash manifest. Git force push: use `git ls-remote`/`git fetch --dry-run` equivalents against the remote read-only to compute `remote..local` divergence, list lost commits + authors.
2. **sim-postgres**: `pgsql-ast-parser` (pure JS; `libpg-query` is a WASM/native alternative with exact PG grammar — see open question). Tier 2 read-only connection checks (count with the statement's WHERE, FK cascade graph via `pg_constraint`, `EXPLAIN`, `pg_total_relation_size`). Tier 3: Docker `postgres` image, schema via `pg_dump --schema-only`-equivalent read queries (not shelling out with creds) + sampled data (`TABLESAMPLE`, capped), run, diff row counts + schema. Because sample ≠ full, Tier 3 results are labeled "sampled"; counts come from Tier 2.
3. **sim-terraform**: parse `terraform show -json` plan; flag delete/replace; data-bearing type table; same-resource-backup detection (e.g. `aws_db_instance` with `skip_final_snapshot`/no separate `aws_db_snapshot`/backup retention inside instance). Accept plan file or directory (runs `terraform plan -out` only if user opts in; plan itself can run providers' read calls, so default is "accept JSON only").
4. **sim-cloud**: operation catalog (`catalog/<provider>.yaml`: operation id, match (method+path / GraphQL op), destructive, reversible, data_bearing, resolver (read-only calls to resolve target), prod-signals). Railway (GraphQL), Vercel (REST), AWS (service/op, via read-only SDK calls) to start. Env confidence from names/tags/domains/traffic with evidence list. Token-scope introspection per provider (read-only "who am I / what can I do" endpoints); where a provider can't introspect, report "scope unverifiable" → never safe.
5. **sim-saas**: Stripe (read-only lookups, `sk_live`/`rk_live` vs test detection, sum amounts), email (recipient count, preview, external domains), Slack (channel members, shared/external, @channel), GitHub (repo/branch delete, visibility, stars/forks/open PRs, branch protection).

## MCP tool schemas (zod → JSON Schema)
- `dry_run`: `{ type: "sql"|"shell"|"terraform"|"cloud_api"|"saas", action: string | object, context?: { cwd?, env_hint?, db_url_ref?, provider?, params? } }` → `ConsequenceReport` (+ `untrusted_data` envelope marker). DB URLs are passed by *reference to config/env var name*, not inline, to keep creds out of agent transcripts.
- `explain_report`: `{ report: ConsequenceReport | report_id }` → plain-language text (generated deterministically from the report; no LLM, no network).
- `list_simulators`: `{}` → per simulator: id, tiers available now (Docker present? read-only creds configured?), unavailable reasons.
- Reports are persisted locally (`.dryrun/reports/<id>.json`, redacted) so `explain_report` can take an id.

## Report schema (v0, will be versioned `schema_version: 1`)
`action` (redacted), `effects[]`, `reversibility` (reversible|recoverable{how}|irreversible|unknown), `environment` {level: production|staging|unknown, confidence, evidence[]}, `blast_radius` {rows,files,bytes,money{amount,currency},people}, `verdict` {value, reason, rule_ids[]}, `safer_alternatives[]`, `evidence` {tiers_run[], readonly_calls[], unverified[]}, `untrusted: true` markers on target-derived strings. Report card: SVG built from a template (no browser needed) + PNG via `@resvg/resvg-js`.

## Agent integration
- Instruction file/skill text per agent (Claude Code `CLAUDE.md` snippet + skill, Codex `AGENTS.md`, Cursor rules `.mdc`, Gemini `GEMINI.md`).
- `npx dry-run-agents setup`: detect agents (`~/.claude.json`/`claude mcp`, `~/.codex/config.toml`, `~/.cursor/mcp.json`, `~/.gemini/settings.json`), show unified diff of planned changes, timestamped backup, apply on approval, `--dry-run`/`--uninstall`/`--yes`. Config paths/formats verified against current docs at Phase 7 (they change).
- Optional stronger enforcement (post-v1 idea): a Claude Code PreToolUse hook that nudges `dry_run` before Bash destructive commands. Instructions alone are advisory; I'll flag this honestly in docs.

## Demos (`dryrun demo <name>`, fully local)
Mock servers (Node http) for the cloud provider and Stripe; Docker Postgres seeded with sample orders; local bare git remote with a teammate's commits. Each demo: scripted agent-style action → report → card PNG; terminal recording via `vhs`/`asciinema`+`agg` (tools to be installed; recordings are an optional build step).

## Phases (each ends with run + tests + short summary, as specified)
1 Foundation (monorepo, types, policy, redactor, config, report JSON+terminal, **tests first**: policy, redaction, never-write harness) → 2 Shell/git + sandbox + force-push demo → 3 Postgres + missing-WHERE demo → 4 Terraform/cloud + catalog + nine-second demo → 5 SaaS + refund-storm demo → 6 MCP + agent instructions → 7 CLI + setup → 8 Report cards → 9 README/docs → 10 Hardening (sandbox escape review, redaction fuzz, Docker/creds-missing modes, e2e incl. a real Claude Code session check).

## Risks
- **False `safe`** (top risk): mitigated by the conservative verdict rules above, property tests ("unverified ⇒ never safe"), and a golden corpus of dangerous commands that must never yield `safe`.
- Shell semantics are unbounded (aliases, subshells, `eval`, scripts calling scripts): Tier 1 marks any unparseable/dynamic construct as unverified → `confirm`; Tier 3 only covers what the container can reproduce (same files, not same env/network/secrets).
- Sandbox ≠ real environment (no network, different OS/tools) so Tier 3 can under- or over-report; reports state the fidelity limits.
- macOS Docker lacks cheap COW mounts → copy-based with size caps.
- Postgres sampled rehearsal can miss FK/trigger behavior on unsampled rows; Tier 2 counts carry the numbers.
- Provider API drift (Railway/Vercel/AWS) → catalog versioned, with "catalog doesn't know this op" ⇒ `confirm`.
- Agent compliance with instructions is not guaranteed.
- Mock provider fidelity: demos prove the pipeline, not real-provider behavior; real-provider resolvers need live read-only-token testing I can't do without your accounts.
- Windows: out of scope, documented as WSL.

## Open questions (need your decision before/at Phase 1; I recommend the first option)
1. **Package name:** `dry-run-agents` (available) with bin `dryrun`. Publishing is hard to reverse — I will *not* publish to npm without your explicit go-ahead; I'll only reserve nothing now.
2. **Report schema:** OK to freeze as `schema_version: 1` as sketched (changes later = breaking)? Or keep `0.x` until after Phase 6?
3. **Sandbox approach:** Docker container + copied working dir + `--network none` (recommended; COW overlay isn't practical on macOS). Alternative: `sandbox-exec`/Seatbelt (no Docker dependency, weaker/deprecated).
4. **SQL parser:** `pgsql-ast-parser` (pure JS, lighter, may reject exotic syntax → we then say "unparseable ⇒ confirm") vs `libpg-query` (exact Postgres grammar, native/WASM dependency). Recommend `libpg-query` for fidelity, falling back to confirm on failure.
5. **Git repo & license:** `git init` here and MIT/Apache-2.0? (Recommend Apache-2.0 for patent grant, MIT if you prefer simplicity.)
6. **Showcase recordings:** OK to install `vhs`/`asciinema`+`agg` via brew in Phase 8, or provide scripted SVG terminal captures instead?
7. **Scope depth:** per "fewer done well," shall I defer AWS in the catalog (Railway + Vercel first, AWS limited to EC2/RDS/EBS/S3 delete ops) and email to a local-SMTP/SES-preview only?

## Verification (for the finished product, per Definition of Done)
- `npm test` green incl. never-write harness, redaction fuzz, "unverified ⇒ not safe" property tests, dangerous-command golden corpus.
- `dryrun demo all` runs the four showcases locally and emits four report cards.
- `dryrun doctor` correct with Docker/creds present and absent (degrades to Tier 1+2 with explicit report note).
- `npx dry-run-agents setup` against a scratch HOME registers Claude Code + Codex; backups verified; uninstall restores.
- Manual: Claude Code session in demo env asked to "clean up the old database volume" calls `dry_run`, gets `block`, stops.
