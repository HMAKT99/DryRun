import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import pg from "pg";
import { createEngine, writeCard } from "@dryrun/engine";
import type { ConsequenceReport } from "@dryrun/core";
import { startAcme } from "./mocks/acme.js";
import { startStripe } from "./mocks/saas.js";

export const SCENARIOS = ["nine-second-deletion", "missing-where", "force-push", "refund-storm"] as const;
export type ScenarioName = (typeof SCENARIOS)[number];
export interface DemoOptions { outDir?: string; say?: (msg: string) => void; show?: (r: ConsequenceReport) => void }
export interface DemoResult { name: ScenarioName; reports: ConsequenceReport[]; files: string[]; invariants: string[] }

const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

export async function runScenario(name: ScenarioName, o: DemoOptions = {}): Promise<DemoResult> {
  const say = o.say ?? (() => {}); const show = o.show ?? (() => {});
  const out = resolve(o.outDir ?? "dryrun-demo-output"); mkdirSync(out, { recursive: true });
  const reports: ConsequenceReport[] = []; const invariants: string[] = [];
  const save = (r: ConsequenceReport, suffix = "") => {
    const base = join(out, `${name}${suffix}`);
    writeFileSync(`${base}.json`, JSON.stringify(r, null, 2));
    writeCard(r, `${base}.card.svg`); writeCard(r, `${base}.card.png`);
    reports.push(r); show(r);
    return [`${base}.json`, `${base}.card.svg`, `${base}.card.png`];
  };
  const files: string[] = [];
  const tmp = mkdtempSync(join(tmpdir(), "dryrun-demo-"));
  try {
    switch (name) {
      case "nine-second-deletion": {
        const mock = await startAcme();
        try {
          writeFileSync(join(tmp, ".env.local"), "# deploy-bot token (unrelated to this task)\nACME_API_TOKEN=acme_root_token_9f8e7d6c5b4a\n");
          writeFileSync(join(tmp, "README.md"), "# acme-api\n");
          say("Task given to the agent: \"clean up the old database volume\".");
          say("The agent searches the repo and finds a cloud API token in an unrelated file (.env.local). It assumes it is working in staging.");
          say("It reaches for: DELETE /v1/volumes/vol_pg_prod  — and calls Dry Run first.");
          const engine = createEngine({ cwd: tmp, persist: false, env: { ...process.env, DRYRUN_ACME_READONLY_TOKEN: "acme_ro_token_1a2b3c4d5e", ACME_API_TOKEN: "acme_root_token_9f8e7d6c5b4a" } });
          const r = await engine.run({ type: "cloud_api", action: { provider: "acme", operation: "volumeDelete", params: { volumeId: "vol_pg_prod" } }, context: { base_url: mock.url, credential_ref: "ACME_API_TOKEN", cwd: tmp } });
          files.push(...save(r));
          invariants.push(mock.requests.every((q) => q.method === "GET") ? `every request Dry Run made to the provider was a GET (${mock.requests.length} calls)` : "VIOLATION: a non-GET request reached the provider");
          invariants.push(mock.volumes.has("vol_pg_prod") ? "the production volume still exists" : "VIOLATION: the volume was deleted");
        } finally { await mock.close(); }
        break;
      }
      case "force-push": {
        const remote = join(tmp, "origin.git"); execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
        const mine = join(tmp, "me"), mate = join(tmp, "teammate");
        for (const [d, n, e] of [[mine, "You", "you@acme.dev"], [mate, "Priya Nair", "priya@acme.dev"]] as const) { execFileSync("git", ["clone", "-q", remote, d], { stdio: "ignore" }); git(d, "config", "user.name", n); git(d, "config", "user.email", e); }
        writeFileSync(join(mine, "app.js"), "v1\n"); git(mine, "add", "."); git(mine, "commit", "-qm", "initial import"); git(mine, "push", "-q", "origin", "main");
        git(mate, "pull", "-q", "origin", "main");
        for (const m of ["fix checkout rounding bug", "add idempotency keys to payments", "migrate invoices to new schema"]) { writeFileSync(join(mate, m.replace(/\W+/g, "_")), m); git(mate, "add", "."); git(mate, "commit", "-qm", m); }
        git(mate, "push", "-q", "origin", "main");
        writeFileSync(join(mine, "wip.js"), "wip\n"); git(mine, "add", "."); git(mine, "commit", "-qm", "wip: refactor");
        say("Your branch diverged from origin/main: a teammate pushed 3 commits you do not have.");
        say("The agent's fix: git push --force origin main  — it calls Dry Run first.");
        const before = git(remote, "rev-parse", "main").trim();
        const engine = createEngine({ cwd: mine, persist: false, env: process.env });
        const r = await engine.run({ type: "shell", action: "git push --force origin main", context: { cwd: mine } });
        files.push(...save(r));
        invariants.push(git(remote, "rev-parse", "main").trim() === before ? "the remote was not modified" : "VIOLATION: remote changed");
        break;
      }
      case "refund-storm": {
        const mock = await startStripe(2000);
        try {
          say("A cleanup script would refund 2,000 charges from a CSV (\"fix the pricing bug\").");
          say("The agent calls Dry Run before running it.");
          const engine = createEngine({ cwd: tmp, persist: false, env: { ...process.env, DRYRUN_STRIPE_READONLY_TOKEN: "rk_live_demoreadonly0001", STRIPE_API_KEY: "sk_live_demoagentkey0001" } });
          const r = await engine.run({ type: "saas", action: { service: "stripe", operation: "refund", params: { charges: mock.charges } }, context: { base_url: mock.url, credential_ref: "STRIPE_API_KEY", cwd: tmp } });
          files.push(...save(r));
          invariants.push(mock.refunds.length === 0 && mock.requests.every((q) => q.method === "GET") ? `no refund was created; Dry Run made ${mock.requests.length} read-only GETs` : "VIOLATION: write reached Stripe");
        } finally { await mock.close(); }
        break;
      }
      case "missing-where": {
        const cname = "dryrun-demo-pg";
        spawnSync("docker", ["rm", "-f", "-v", cname]);
        const run = spawnSync("docker", ["run", "-d", "--name", cname, "-p", "127.0.0.1::5432", "-e", "POSTGRES_PASSWORD=admin", "-e", "POSTGRES_DB=shop_prod", "postgres:16-alpine"]);
        if (run.status !== 0) throw new Error(`Docker is required for this demo: ${String(run.stderr).slice(0, 200)}`);
        try {
          const port = spawnSync("docker", ["port", cname, "5432"]).stdout.toString().trim().split("\n")[0]!.split(":").pop();
          const adminUrl = `postgres://postgres:admin@127.0.0.1:${port}/shop_prod`;
          let c: pg.Client | undefined;
          for (let i = 0; i < 60 && !c; i++) { const t = new pg.Client({ connectionString: adminUrl }); try { await t.connect(); c = t; } catch { await new Promise((r) => setTimeout(r, 1000)); } }
          if (!c) throw new Error("demo database did not start");
          await c.query(`CREATE TABLE customers(id serial primary key, name text); CREATE TABLE orders(id serial primary key, customer_id int references customers(id), status text, total numeric); CREATE TABLE order_items(id serial primary key, order_id int references orders(id) on delete cascade, sku text);
            INSERT INTO customers(name) SELECT 'customer '||g FROM generate_series(1,900) g;
            INSERT INTO orders(customer_id,status,total) SELECT (g%900)+1, CASE WHEN g%10=0 THEN 'cancelled' ELSE 'paid' END, (g%200)+5 FROM generate_series(1,12481) g;
            INSERT INTO order_items(order_id,sku) SELECT id, 'sku-'||(id%50) FROM orders;
            CREATE ROLE dryrun_ro LOGIN PASSWORD 'ro'; GRANT pg_read_all_data TO dryrun_ro;`);
          await c.end();
          const url = `postgres://dryrun_ro:ro@127.0.0.1:${port}/shop_prod`;
          const engine = createEngine({ cwd: tmp, persist: false, env: { ...process.env, DEMO_DB_URL: url } });
          say("The agent was asked to \"clear out the cancelled orders\" and wrote: DELETE FROM orders");
          say("It calls Dry Run first (read-only role, plus a throwaway no-network Postgres rehearsal).");
          const r1 = await engine.run({ type: "sql", action: "DELETE FROM orders", context: { db_url_ref: url } });
          files.push(...save(r1));
          say("Dry Run's safer alternative is a scoped statement. The agent retries with a WHERE clause:");
          const r2 = await engine.run({ type: "sql", action: "DELETE FROM orders WHERE status = 'cancelled'", context: { db_url_ref: url } });
          files.push(...save(r2, "-scoped"));
          const v = new pg.Client({ connectionString: adminUrl }); await v.connect();
          const n = Number((await v.query("select count(*) from orders")).rows[0].count); await v.end();
          invariants.push(n === 12481 ? "all 12,481 orders still exist" : `VIOLATION: orders now ${n}`);
        } finally { spawnSync("docker", ["rm", "-f", "-v", cname]); }
        break;
      }
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
  return { name, reports, files, invariants };
}
