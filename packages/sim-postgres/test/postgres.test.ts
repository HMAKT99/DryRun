import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import pg from "pg";
import { dryRun, defaultConfig, createDockerSandbox, makeReadOnlyContext, assertReadOnlySql } from "@dryrun/core";
import { createPostgresSimulator, analyzeSql, envFromUrl, createReadOnlyPg } from "../src/index.js";

describe("tier 1 (no database needed)", () => {
  const run = (sql: string, ref?: string) => dryRun({ type: "sql", action: sql, context: ref ? { db_url_ref: ref } : undefined }, [createPostgresSimulator()], { config: defaultConfig() });
  it("select is safe", async () => { expect((await run("SELECT * FROM orders WHERE id = 1")).verdict.value).toBe("safe"); });
  it("golden corpus never safe", async () => {
    for (const s of ["DELETE FROM orders", "DELETE FROM orders WHERE true", "DELETE FROM orders WHERE 1=1", "UPDATE orders SET x=1", "TRUNCATE orders", "TRUNCATE a, b CASCADE", "DROP TABLE orders", "DROP DATABASE prod", "DROP SCHEMA public CASCADE",
      "ALTER TABLE orders DROP COLUMN email", "INSERT INTO t VALUES (1)", "SELECT nextval('s')", "SELECT 1; DROP TABLE x", "WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d", "garbage ((", "VACUUM FULL", "GRANT ALL ON t TO public", "COPY t FROM PROGRAM 'x'"])
      expect((await run(s)).verdict.value, s).not.toBe("safe");
  });
  it("delete with no WHERE is flagged as every row; with WHERE it is not", async () => {
    expect(analyzeSql("DELETE FROM orders")[0]).toMatchObject({ kind: "delete", allRows: true });
    expect(analyzeSql("DELETE FROM orders WHERE id=3")[0]).toMatchObject({ kind: "delete", allRows: false });
  });
  it("env detection from url", () => {
    expect(envFromUrl("postgres://u:p@db.prod.acme.com/app").level).toBe("production");
    expect(envFromUrl("postgres://u:p@x.com/app_staging").level).toBe("staging");
    expect(envFromUrl("postgres://u:p@somehost.com/app").level).toBe("unknown");
    expect(envFromUrl("postgres://u:p@localhost/app").level).toBe("local");
  });
  it("drops in production are blocked even without a connection", async () => {
    const r = await dryRun({ type: "sql", action: "DROP TABLE orders", context: { db_url_ref: "postgres://u:secretpw99@db.prod.acme.com/app" } }, [createPostgresSimulator()], { config: defaultConfig() });
    expect(r.verdict.value).toBe("block");
    expect(JSON.stringify(r)).not.toContain("secretpw99");
  });
  it("read-only client refuses writes before touching the network", async () => {
    let touched = false;
    const ro = createReadOnlyPg("postgres://u:p@localhost:1/x", () => { touched = true; return { connect: async () => {}, query: async () => ({ rows: [] }), end: async () => {} } as unknown as pg.Client; });
    await expect(ro.query("DELETE FROM t")).rejects.toThrow(/read-only/i);
    expect(touched).toBe(true); // factory builds the client, but no query reaches it:
    expect(ro.calls).toEqual([]);
    expect(() => assertReadOnlySql("SELECT 1")).not.toThrow();
  });
});

const hasDocker = createDockerSandbox().available && spawnSync("docker", ["image", "inspect", "postgres:16-alpine"]).status === 0;
describe.skipIf(!hasDocker)("tiers 2 and 3 against a real Postgres (docker)", () => {
  const name = "dryrun-test-src";
  let url: string; let adminUrl: string;
  beforeAll(async () => {
    spawnSync("docker", ["rm", "-f", name]);
    const r = spawnSync("docker", ["run", "-d", "--name", name, "-p", "127.0.0.1::5432", "-e", "POSTGRES_PASSWORD=admin", "-e", "POSTGRES_DB=shop_prod", "postgres:16-alpine"]);
    if (r.status !== 0) throw new Error(String(r.stderr));
    const port = spawnSync("docker", ["port", name, "5432"]).stdout.toString().trim().split("\n")[0]!.split(":").pop();
    adminUrl = `postgres://postgres:admin@127.0.0.1:${port}/shop_prod`;
    let c: pg.Client | undefined;
    for (let i = 0; i < 60; i++) { try { c = new pg.Client({ connectionString: adminUrl }); await c.connect(); break; } catch { c = undefined; await new Promise((r) => setTimeout(r, 1000)); } }
    if (!c) throw new Error("source db did not start");
    await c.query(`CREATE TABLE customers(id serial primary key, name text);
      CREATE TABLE orders(id serial primary key, customer_id int references customers(id) on delete cascade, status text, total numeric);
      CREATE TABLE audit(id serial primary key, order_id int references orders(id) on delete cascade);
      CREATE VIEW big_orders AS SELECT * FROM orders WHERE total > 50;
      INSERT INTO customers(name) SELECT 'c'||g FROM generate_series(1,20) g;
      INSERT INTO orders(customer_id,status,total) SELECT (g%20)+1, CASE WHEN g%4=0 THEN 'cancelled' ELSE 'paid' END, g FROM generate_series(1,200) g;
      INSERT INTO audit(order_id) SELECT id FROM orders;
      CREATE ROLE dryrun_ro LOGIN PASSWORD 'ro'; GRANT pg_read_all_data TO dryrun_ro;`);
    await c.end();
    url = `postgres://dryrun_ro:ro@127.0.0.1:${port}/shop_prod`;
  }, 120_000);
  afterAll(() => { spawnSync("docker", ["rm", "-f", "-v", name]); });

  const run = (sql: string, sandbox = false, u = () => url) => dryRun({ type: "sql", action: sql, context: { db_url_ref: u() } }, [createPostgresSimulator()], { config: defaultConfig(), readOnly: makeReadOnlyContext(undefined), sandbox: sandbox ? createDockerSandbox() : undefined });
  const count = async (t: string) => { const c = new pg.Client({ connectionString: adminUrl }); await c.connect(); const n = Number((await c.query(`select count(*) from ${t}`)).rows[0].count); await c.end(); return n; };

  it("DELETE FROM orders: measures every row and the cascade; changes nothing", async () => {
    const r = await run("DELETE FROM orders");
    expect(r.blast_radius.rows).toBeGreaterThanOrEqual(200);
    expect(r.effects.some((e) => /200 row\(s\).* of public\.orders/.test(e.text))).toBe(true);
    expect(r.effects.some((e) => /Cascades into public\.audit: 200/.test(e.text))).toBe(true);
    expect(r.verdict.value).toBe("block"); // production by name + irreversible
    expect(r.safer_alternatives.join(" ")).toMatch(/WHERE/);
    expect(await count("orders")).toBe(200);
    expect(await count("audit")).toBe(200);
  }, 60_000);
  it("DELETE ... WHERE counts only matches, including cascaded children", async () => {
    const r = await run("DELETE FROM orders WHERE status = 'cancelled'");
    expect(r.effects.some((e) => /Removes 50 row\(s\) matching the WHERE clause of public\.orders \(200 total/.test(e.text))).toBe(true);
    expect(r.effects.some((e) => /Cascades into public\.audit: 50/.test(e.text))).toBe(true);
    expect(r.evidence.items.some((i) => i.readonlyCall && /EXPLAIN/.test(i.source))).toBe(true);
    expect(await count("orders")).toBe(200);
  }, 60_000);
  it("DROP TABLE reports size, dependent views and cascades", async () => {
    const r = await run("DROP TABLE orders CASCADE");
    expect(r.effects.some((e) => /big_orders/.test(e.text))).toBe(true);
    expect(r.verdict.value).toBe("block");
    expect(await count("orders")).toBe(200);
  }, 60_000);
  it("a write-capable credential is reported as over-scoped", async () => {
    const r = await run("DELETE FROM orders WHERE id = 1", false, () => adminUrl);
    expect(r.effects.some((e) => /SUPERUSER/.test(e.text))).toBe(true);
  }, 60_000);
  it("every query sent to the real database was read-only", async () => {
    const calls: string[] = [];
    const sim = createPostgresSimulator({ pgFactory: (u) => { const d = createReadOnlyPg(u); const q = d.query.bind(d); d.query = async (s, p) => { calls.push(s); return q(s, p); }; return d; } });
    await dryRun({ type: "sql", action: "DELETE FROM orders WHERE id < 5; DROP TABLE customers", context: { db_url_ref: url } }, [sim], { config: defaultConfig(), readOnly: makeReadOnlyContext(undefined) });
    expect(calls.length).toBeGreaterThan(3);
    for (const c of calls) expect(() => assertReadOnlySql(c), c).not.toThrow();
    expect(await count("orders")).toBe(200);
  }, 60_000);
  it("tier 3: rehearses in a disposable container, diffs rows and schema, cleans up", async () => {
    const r = await run("DELETE FROM orders", true);
    expect(r.evidence.tiers_run.find((t) => t.tier === 3)?.status).toBe("ok");
    expect(r.effects.some((e) => /Sandbox rehearsal: public\.orders went from 200 to 0/.test(e.text))).toBe(true);
    expect(r.effects.some((e) => /Sandbox rehearsal: public\.audit went from 200 to 0/.test(e.text))).toBe(true);
    expect(await count("orders")).toBe(200);
    const left = spawnSync("docker", ["ps", "-a", "--format", "{{.Names}}"]).stdout.toString();
    expect(left).not.toMatch(/dryrun-pg-/);
    const r2 = await run("ALTER TABLE customers DROP COLUMN name", true);
    expect(r2.effects.some((e) => /column\(s\) dropped: public\.customers\.name/.test(e.text))).toBe(true);
  }, 180_000);
  it("unreachable database => tier 2 error, never safe", async () => {
    const r = await run("DELETE FROM orders WHERE id = 1", false, () => "postgres://x:y@127.0.0.1:1/none");
    expect(r.evidence.tiers_run.find((t) => t.tier === 2)?.status).toBe("error");
    expect(r.verdict.value).not.toBe("safe");
  }, 60_000);
});
