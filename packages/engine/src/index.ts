import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  ActionSchema, buildReport, createDockerSandbox, createReadOnlyHttp, defaultConfig, dockerAvailable, dryRun, loadConfig, makeReadOnlyContext,
  redact, type Action, type Config, type ConsequenceReport, type Evidence, type Simulator, type DockerSandbox,
} from "@dryrun/core";
import { createShellSimulator } from "@dryrun/sim-shell";
import { createPostgresSimulator } from "@dryrun/sim-postgres";
import { createTerraformSimulator } from "@dryrun/sim-terraform";
import { createCloudSimulator, loadCatalogs } from "@dryrun/sim-cloud";
import { createSaasSimulator } from "@dryrun/sim-saas";

export interface SimulatorInfo { id: string; handles: string; tiers: Array<{ tier: 1 | 2 | 3; available: boolean; note: string }> }
export interface Engine {
  config: Config;
  run(action: Action): Promise<ConsequenceReport>;
  explain(report: ConsequenceReport | string): string;
  list(): SimulatorInfo[];
  loadReport(id: string): ConsequenceReport | undefined;
}

export interface EngineOptions { cwd?: string; env?: NodeJS.ProcessEnv; config?: Config; persist?: boolean; sandbox?: DockerSandbox | null; /** hard cap for one rehearsal */ timeoutMs?: number }

export function createEngine(o: EngineOptions = {}): Engine {
  const cwd = o.cwd ?? process.cwd();
  const env = o.env ?? process.env;
  const config = o.config ?? loadConfig(cwd);
  const reportsDir = join(cwd, ".dryrun", "reports");
  let sandbox: DockerSandbox | null | undefined = o.sandbox;
  const getSandbox = () => (sandbox === undefined ? (sandbox = createDockerSandbox()) : sandbox);
  const simulators: Simulator[] = [createShellSimulator(), createPostgresSimulator({ env }), createTerraformSimulator(), createCloudSimulator({ env }), createSaasSimulator({ env, config })];

  async function run(raw: Action): Promise<ConsequenceReport> {
    const parsed = ActionSchema.safeParse(raw);
    const evidence: Evidence[] = [];
    const fail = (msg: string, action: Action) => buildReport({
      action, evidence: [{ id: "engine-1", tier: 1, source: "engine", detail: msg }], tierRuns: [{ simulator: "engine", tier: 1, status: "error", note: msg }], matchedSimulators: 0, config,
      findings: [{ simulator: "engine", tier: 1, effect: "Dry Run could not complete the rehearsal.", severity: "medium", reversibility: "unknown", unverified: [msg], evidenceIds: ["engine-1"] }],
    });
    if (!parsed.success) return persist(fail(`invalid input: ${parsed.error.issues[0]?.message ?? "bad action"}`, { type: "shell", action: "(invalid action)" }));
    const action: Action = parsed.data;
    const ctx = { ...(action.context ?? {}) };
    ctx.cwd ??= cwd;
    if (action.type === "sql" && !ctx.db_url_ref && env["DRYRUN_DATABASE_URL"]) ctx.db_url_ref = "DRYRUN_DATABASE_URL";
    const a: Action = { ...action, context: ctx };
    const calls: string[] = [];
    const ro = makeReadOnlyContext(createReadOnlyHttp(fetch, (c) => calls.push(c)));
    const sb = getSandbox();
    try {
      const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`rehearsal exceeded ${(o.timeoutMs ?? 180_000) / 1000}s`)), o.timeoutMs ?? 180_000).unref());
      const report = await Promise.race([dryRun(a, simulators, { config, readOnly: ro, sandbox: sb ?? undefined, evidence }), timeout]);
      if (!sb?.available) report.evidence.tiers_run = report.evidence.tiers_run.map((t) => t);
      return persist(report);
    } catch (e) {
      return persist(fail(`internal error: ${redact((e as Error).message).slice(0, 200)}`, a));
    }
  }

  function persist(r: ConsequenceReport): ConsequenceReport {
    if (o.persist === false) return r;
    try { mkdirSync(reportsDir, { recursive: true }); writeFileSync(join(reportsDir, `${r.id}.json`), JSON.stringify(r, null, 2)); } catch { /* reports are best-effort */ }
    return r;
  }
  function loadReport(id: string): ConsequenceReport | undefined {
    if (!/^[0-9a-f-]{36}$/.test(id)) return undefined; // no path traversal
    const p = join(reportsDir, `${id}.json`);
    return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as ConsequenceReport) : undefined;
  }

  function list(): SimulatorInfo[] {
    const docker = dockerAvailable();
    const sbNote = docker ? "Docker is running" : "Docker is not available; Tier 3 is skipped and reports say so";
    const cats = loadCatalogs();
    const anyRo = (names: string[]) => names.some((n) => env[`DRYRUN_${n.toUpperCase()}_READONLY_TOKEN`]);
    return [
      { id: "shell", handles: "shell (incl. git)", tiers: [{ tier: 1, available: true, note: "command classification" }, { tier: 2, available: true, note: "git push/force-push: read-only fetch into a throwaway repo" }, { tier: 3, available: docker, note: sbNote }] },
      { id: "postgres", handles: "sql", tiers: [{ tier: 1, available: true, note: "SQL parser" }, { tier: 2, available: !!env["DRYRUN_DATABASE_URL"], note: env["DRYRUN_DATABASE_URL"] ? "read-only URL configured (DRYRUN_DATABASE_URL)" : "pass a read-only URL via context.db_url_ref or set DRYRUN_DATABASE_URL" }, { tier: 3, available: docker, note: sbNote }] },
      { id: "terraform", handles: "terraform", tiers: [{ tier: 1, available: true, note: "parses `terraform show -json` plans (never runs terraform)" }] },
      { id: "cloud", handles: `cloud_api (${cats.map((c) => c.provider).join(", ")})`, tiers: [{ tier: 1, available: true, note: "operation catalog" }, { tier: 2, available: anyRo(cats.map((c) => c.provider)), note: "needs DRYRUN_<PROVIDER>_READONLY_TOKEN; AWS has classification only" }] },
      { id: "saas", handles: "saas (stripe, email, slack, github)", tiers: [{ tier: 1, available: true, note: "classification; email is Tier 1 only" }, { tier: 2, available: anyRo(["stripe", "slack", "github"]), note: "needs DRYRUN_<SERVICE>_READONLY_TOKEN" }] },
    ];
  }

  return { config, run, list, loadReport, explain: (r) => explain(typeof r === "string" ? (loadReport(r) ?? missing(r)) : r) };
}

function missing(id: string): ConsequenceReport { throw new Error(`No saved report with id ${id}`); }

/** Deterministic plain-language explanation. No model, no network. */
export function explain(r: ConsequenceReport): string {
  const L: string[] = [];
  const head = { block: "STOP. Dry Run recommends blocking this action.", confirm: "PAUSE. A human should confirm before this runs.", safe: "No problems found." }[r.verdict.value];
  L.push(head, `Why: ${r.verdict.reason}`, "");
  if (r.effects.length) { L.push("What would happen:"); for (const e of r.effects.filter((x) => x.severity !== "info").slice(0, 8)) L.push(`  - ${e.text}`); L.push(""); }
  L.push(`Environment: ${r.environment.level}${r.environment.evidence.length ? ` (because: ${r.environment.evidence.slice(0, 3).join("; ")})` : ""}.`);
  L.push(`Can it be undone? ${r.reversibility === "irreversible" ? "No." : r.reversibility === "recoverable" ? `Yes, with effort${r.recovery ? `: ${r.recovery}` : ""}.` : r.reversibility === "reversible" ? "Yes." : "Unknown, so assume no."}`);
  if (r.evidence.unverified.length) { L.push("", "What Dry Run could not verify:"); for (const u of [...new Set(r.evidence.unverified)].slice(0, 6)) L.push(`  - ${u}`); }
  if (r.safer_alternatives.length) { L.push("", "Safer options:"); for (const s of r.safer_alternatives) L.push(`  - ${s}`); }
  const skipped = r.evidence.tiers_run.filter((t) => t.status !== "ok");
  if (skipped.length) { L.push("", "Checks that did not run:"); for (const t of skipped) L.push(`  - ${t.simulator} tier ${t.tier}: ${t.status}${t.note ? ` (${t.note})` : ""}`); }
  L.push("", `Report id: ${r.id}`);
  return L.join("\n");
}
void defaultConfig;
export * from "./card.js";
