import { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { explain, createEngine, writeCard } from "@dryrun/engine";
import type { Action, ConsequenceReport } from "@dryrun/core";
import { runScenario, SCENARIOS, type ScenarioName } from "@dryrun/demos";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "@dryrun/mcp";
import { bold, colorReport, cyan, dim, exitCodeFor, green, red, yellow } from "./print.js";
import { AGENTS, ConfigError, apply, diffText, launchFor, plan, type AgentId } from "./setup.js";
import { doctor } from "./doctor.js";

const program = new Command().name("dryrun").description("Rehearse any risky action before your agent does it. Never changes real systems.").version(process.env["DRYRUN_VERSION"] ?? "dev");

interface Common { json?: boolean; card?: string; cwd?: string; envHint?: string }
const common = (c: Command) => c.option("--json", "print the Consequence Report as JSON").option("--card <file>", "write a shareable report card (.png or .svg)").option("--cwd <dir>", "working directory").option("--env-hint <name>", "tell Dry Run which environment this targets (e.g. production)");

async function finish(action: Action, o: Common): Promise<never> {
  const engine = createEngine({ cwd: o.cwd ? resolve(o.cwd) : process.cwd() });
  const r = await engine.run({ ...action, context: { ...(action.context ?? {}), cwd: o.cwd ? resolve(o.cwd) : undefined, env_hint: o.envHint ?? action.context?.env_hint } });
  out(r, o);
  process.exit(exitCodeFor(r));
}
function out(r: ConsequenceReport, o: Common) {
  console.log(o.json ? JSON.stringify(r, null, 2) : colorReport(r));
  if (o.card) { writeCard(r, resolve(o.card)); if (!o.json) console.error(dim(`report card: ${resolve(o.card)}`)); }
}
const parseParams = (s?: string) => { if (!s) return {}; try { return JSON.parse(s) as Record<string, unknown>; } catch { console.error(red("--params must be valid JSON")); process.exit(1); } };

common(program.command("shell <command>").description("Rehearse a shell/git command (Docker sandbox, no network)"))
  .action((command: string, o: Common) => finish({ type: "shell", action: command }, o));

common(program.command("sql <statement>").description("Rehearse a Postgres statement")
  .option("--db <url>", "READ-ONLY Postgres URL (prefer --db-env: URLs end up in shell history)").option("--db-env <name>", "name of an env var holding the read-only URL"))
  .action((statement: string, o: Common & { db?: string; dbEnv?: string }) => finish({ type: "sql", action: statement, context: { db_url_ref: o.dbEnv ?? o.db } }, o));

common(program.command("tf <plan>").description("Analyze `terraform show -json` output (file or directory with plan.json)"))
  .action((plan: string, o: Common) => finish({ type: "terraform", action: plan }, o));

const apiOpts = (c: Command) => c.option("--params <json>", "operation parameters as JSON").option("--method <verb>").option("--path <path>", "raw REST path instead of an operation id")
  .option("--base-url <url>").option("--readonly-token-env <name>", "env var holding a READ-ONLY token for Dry Run").option("--credential-env <name>", "env var holding the credential the agent will use (inspected for scope only)");
common(apiOpts(program.command("api <provider> [operation]").description("Rehearse a cloud provider API call (railway, vercel, aws, acme)")))
  .action((provider: string, operation: string | undefined, o: Common & Record<string, string | undefined>) =>
    finish({ type: "cloud_api", action: { provider, operation, method: o["method"], path: o["path"], params: parseParams(o["params"]) }, context: { base_url: o["baseUrl"], readonly_token_ref: o["readonlyTokenEnv"], credential_ref: o["credentialEnv"] } }, o));

common(apiOpts(program.command("saas <service> <operation>").description("Rehearse a SaaS action (stripe, email, slack, github)")))
  .action((service: string, operation: string, o: Common & Record<string, string | undefined>) =>
    finish({ type: "saas", action: { service, operation, params: parseParams(o["params"]) }, context: { base_url: o["baseUrl"], readonly_token_ref: o["readonlyTokenEnv"], credential_ref: o["credentialEnv"] } }, o));

program.command("explain <report>").description("Plain-language explanation of a saved report (id or JSON file)").action((r: string) => {
  const engine = createEngine({ persist: false });
  const rep: ConsequenceReport = /\.json$/.test(r) ? JSON.parse(readFileSync(r, "utf8")) : (engine.loadReport(r) ?? (() => { console.error(red(`No report ${r} in ./.dryrun/reports`)); process.exit(1); })());
  console.log(explain(rep));
});

program.command("list").description("What Dry Run can rehearse in this environment, by tier").action(() => {
  for (const s of createEngine({ persist: false }).list()) { console.log(bold(`${s.id}`) + dim(` [${s.handles}]`)); for (const t of s.tiers) console.log(`  tier ${t.tier}: ${t.available ? green("available") : yellow("unavailable")} ${dim("— " + t.note)}`); }
});

program.command("demo [name]").description(`Run a local showcase (${SCENARIOS.join(", ")}, or all)`).option("--out <dir>", "where to write reports and cards", "dryrun-demo-output").action(async (name: string | undefined, o: { out: string }) => {
  const names = !name || name === "all" ? [...SCENARIOS] : [name as ScenarioName];
  if (names.some((n) => !SCENARIOS.includes(n))) { console.error(red(`unknown demo "${name}". Choose: ${SCENARIOS.join(", ")}, all`)); process.exit(1); }
  let bad = 0;
  for (const n of names) {
    console.log("\n" + bold(cyan(`━━ ${n} ━━`)));
    try {
      const res = await runScenario(n, { outDir: o.out, say: (m) => console.log(dim("  ▸ ") + m), show: (r) => console.log("\n" + colorReport(r) + "\n") });
      for (const i of res.invariants) { const ok = !i.startsWith("VIOLATION"); if (!ok) bad++; console.log(`  ${ok ? green("✔") : red("✖")} ${i}`); }
      console.log(dim(`  report card: ${res.files.filter((f) => f.endsWith(".png")).join(", ")}`));
    } catch (e) { bad++; console.error(red(`  demo failed: ${(e as Error).message}`)); }
  }
  process.exit(bad ? 1 : 0);
});

program.command("doctor").description("Check Docker, credentials and agent registration").option("--json").action((o: { json?: boolean }) => {
  const checks = doctor();
  if (o.json) console.log(JSON.stringify(checks, null, 2));
  else for (const c of checks) { console.log(`${c.ok ? green("✔") : red("✖")} ${bold(c.name)}  ${dim(c.detail)}`); if (!c.ok && c.fix) console.log(`    fix: ${c.fix}`); }
  process.exit(checks.every((c) => c.ok) ? 0 : 1);
});

program.command("mcp").description("Run the MCP server on stdio (used by agents)").action(async () => {
  await createServer().connect(new StdioServerTransport());
});

program.command("setup").description("Register Dry Run with your coding agents (shows a diff, backs up, asks first)")
  .option("--agents <list>", `comma-separated: ${AGENTS.join(",")}`).option("--home <dir>", "home directory to modify (testing)").option("--yes", "apply without asking")
  .option("--dry-run", "show the plan, change nothing").option("--uninstall", "remove Dry Run from the agents").option("--npx", "register `npx -y dry-run-agents mcp` instead of this install's path")
  .option("--project <dir>", "also write a project-level Cursor rule in this directory")
  .action(async (o: { agents?: string; home?: string; yes?: boolean; dryRun?: boolean; uninstall?: boolean; npx?: boolean; project?: string }) => {
    const home = o.home ?? homedir();
    const want = (o.agents ? o.agents.split(",").map((s) => s.trim()) : AGENTS) as AgentId[];
    if (want.some((a) => !AGENTS.includes(a))) { console.error(red(`unknown agent in --agents. Choose from ${AGENTS.join(", ")}`)); process.exit(1); }
    const launch = o.uninstall ? null : launchFor({ npx: o.npx });
    const plans = plan(want, home, launch, { project: o.project && resolve(o.project) }).filter((p) => p.detected || o.agents);
    if (!plans.length) { console.log("No supported agents detected (Claude Code, Codex, Cursor, Gemini CLI). Use --agents to force."); return; }
    let total = 0;
    for (const p of plans) {
      console.log("\n" + bold(p.agent) + (p.detected ? "" : dim(" (not detected, forced)")));
      if (p.skipped) { console.log(red(`  skipped: ${p.skipped}`)); continue; }
      if (!p.changes.length) { console.log(dim("  already up to date")); continue; }
      for (const c of p.changes) { console.log(diffText(c)); total++; }
    }
    if (!total) return;
    if (o.dryRun) { console.log(dim("\n--dry-run: nothing was changed.")); return; }
    if (!o.yes) {
      if (!process.stdin.isTTY) { console.error(red("\nNot a terminal: re-run with --yes to apply, or --dry-run to preview.")); process.exit(1); }
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const ans = (await rl.question(`\nApply ${total} change(s)? Existing files are backed up next to themselves. [y/N] `)).trim().toLowerCase(); rl.close();
      if (ans !== "y" && ans !== "yes") { console.log("Aborted. Nothing changed."); return; }
    }
    for (const p of plans) for (const c of p.changes) { const b = apply(c); console.log(`${green("✔")} ${c.file}${b ? dim(`  (backup: ${b})`) : ""}`); }
    console.log(`\n${o.uninstall ? "Removed." : "Done. Restart your agent(s) so they load the new MCP server."} Run ${bold("dryrun doctor")} to verify.`);
  });

program.parseAsync().catch((e) => { console.error(red(e instanceof ConfigError ? e.message : `error: ${(e as Error).message}`)); process.exit(1); });
