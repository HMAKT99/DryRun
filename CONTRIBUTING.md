# Contributing

```bash
docker pull alpine/git:latest && docker pull postgres:16-alpine   # optional: enables the sandbox/Postgres tests (skipped without Docker)
npm install && npm run build && npm test     # needs Node 22+
npm run bundle -w dry-run-agents             # builds the CLI/MCP bundle used by the e2e tests
```

Principles for any change: Dry Run never writes to a real system; unknown is never `safe`; secrets never appear in output; every claim cites evidence. A wrong `safe` is the worst bug. Write the failing test first, and add dangerous inputs to the golden corpora.

## Adding a cloud provider (no code needed)

1. Create `packages/sim-cloud/catalog/<provider>.json` (see `acme-cloud.json` for every field, validated by the zod `CatalogSchema` in `catalog.ts`).
2. For each operation set `destructive`, `reversibility` (`reversible | recoverable | irreversible`), `data_bearing`, a `match` (`method`+`path` regex with `path_params`, or `graphql`, or `operation` for SDK-style `service:Operation`), and a `safer` suggestion. Use `reversibility_by_param` when a flag changes it (e.g. AWS `SkipFinalSnapshot`).
3. Optional Tier 2: `resolve` steps (GET-only) with `extract` paths, and `token_introspection` so Dry Run can say what the credential can do.
4. Set `status` honestly: `classification-only`, `classification-verified-resolvers-experimental`, or `verified`. Only mark resolvers verified after running them against the real API with a read-only token.
5. Add a test in `packages/demos/test/` (mock the API with `startAcme`-style servers; assert every request is a GET). The catalog test checks schema validity and unique ids automatically.

## Adding a SaaS service or resource type
- Terraform: add the resource type to `DATA_BEARING` in `packages/sim-terraform/src/index.ts` (and say whether backups live inside it).
- SaaS: add a module beside `stripe.ts` exporting a Tier 1 classifier and an optional read-only Tier 2, wire it in `packages/sim-saas/src/index.ts`.

## Layout
`core` (types, policy, redaction, guards, report/card) · `sim-*` (simulators) · `engine` (wiring, persistence, explain) · `mcp` · `cli` (`dry-run-agents`) · `demos` (mock providers + showcases).

## Pull requests
Keep changes small and tested. If you change a verdict rule or add a classification, add the dangerous inputs to the golden corpus in the relevant `test/` folder (a command that must never be `safe`). CI (`.github/workflows/ci.yml`) runs the full suite, including the Docker tests and `dryrun demo all`, on Ubuntu.

## Regenerating the README recordings
`docs/tapes/*.tape` are [vhs](https://github.com/charmbracelet/vhs) scripts: `npm run build && npm run bundle -w dry-run-agents && vhs docs/tapes/nine-second-deletion.tape`.

## Reporting a wrong verdict
A `safe` that should not be `safe` is a security bug: see [SECURITY.md](SECURITY.md). A `confirm` that should be `safe`, or a `block` that is too strict, is a normal issue.
