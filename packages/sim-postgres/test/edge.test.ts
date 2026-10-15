import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import pg from "pg";
import { dryRun, defaultConfig, makeReadOnlyContext, createDockerSandbox } from "@dryrun/core";
import { createPostgresSimulator } from "../src/index.js";

const hasDocker = createDockerSandbox().available && spawnSync("docker", ["image", "inspect", "postgres:16-alpine"]).status === 0;
describe.skipIf(!hasDocker)("postgres edge cases against a real database", () => {
  const name = "dryrun-test-edge"; let url = ""; let admin: pg.Client;
  beforeAll(async () => {
    spawnSync("docker", ["rm", "-f", name]);
    spawnSync("docker", ["run", "-d", "--name", name, "-p", "127.0.0.1::5432", "-e", "POSTGRES_PASSWORD=admin", "-e", "POSTGRES_DB=app_staging", "postgres:16-alpine"]);
    const port = spawnSync("docker", ["port", name, "5432"]).stdout.toString().trim().split("\n")[0]!.split(":").pop();
    for (let i = 0; i < 60; i++) { try { admin = new pg.Client({ connectionString: `postgres://postgres:admin@127.0.0.1:${port}/app_staging` }); await admin.connect(); break; } catch { await new Promise((r) => setTimeout(r, 1000)); } }
    await admin.query(`CREATE TABLE orders(id serial primary key, status text); INSERT INTO orders(status) SELECT 'paid' FROM generate_series(1,50);
      CREATE SCHEMA billing; CREATE TABLE billing.invoices(id serial primary key, n int); INSERT INTO billing.invoices(n) SELECT g FROM generate_series(1,7) g;
      CREATE SEQUENCE s; CREATE ROLE ro LOGIN PASSWORD 'ro'; GRANT pg_read_all_data TO ro;`);
    url = `postgres://ro:ro@127.0.0.1:${port}/app_staging`;
  }, 120_000);
  afterAll(async () => { await admin?.end(); spawnSync("docker", ["rm", "-f", "-v", name]); });
  const run = (sql: string) => dryRun({ type: "sql", action: sql, context: { db_url_ref: url } }, [createPostgresSimulator()], { config: defaultConfig(), readOnly: makeReadOnlyContext(undefined) });
  const n = async (q: string) => Number((await admin.query(q)).rows[0].count);
  const text = (r: Awaited<ReturnType<typeof run>>) => r.effects.map((e) => e.text).join("\n");

  it("multi-statement input: every statement is measured, nothing runs", async () => {
    const r = await run("DELETE FROM orders; DROP TABLE billing.invoices");
    expect(text(r)).toMatch(/Removes 50 row\(s\) of public\.orders/);
    expect(text(r)).toMatch(/billing\.invoices/);
    expect(r.verdict.value).not.toBe("safe");
    expect(await n("select count(*) from orders")).toBe(50);
    expect(await n("select count(*) from billing.invoices")).toBe(7);
  }, 60_000);
  it("transaction wrappers do not hide the statement and are not trusted", async () => {
    const r = await run("BEGIN; DELETE FROM orders WHERE id < 6; COMMIT;");
    expect(text(r)).toMatch(/Removes 5 row\(s\) matching/);
    expect(r.verdict.value).not.toBe("safe");
  }, 60_000);
  it("UPDATE with no WHERE, TRUNCATE CASCADE and quoted/schema-qualified names", async () => {
    expect(text(await run("UPDATE orders SET status = 'x'"))).toMatch(/Modifies 50 row/);
    expect(text(await run("TRUNCATE orders CASCADE"))).toMatch(/Removes 50 row/);
    expect(text(await run('DELETE FROM billing."invoices" WHERE n > 5'))).toMatch(/Removes 2 row\(s\) matching the WHERE clause of billing\.invoices \(7 total/);
    expect(await n("select count(*) from orders")).toBe(50);
  }, 90_000);
  it("subqueries in WHERE are counted; RETURNING is fine", async () => {
    expect(text(await run("DELETE FROM orders WHERE id IN (SELECT id FROM orders LIMIT 3) RETURNING *"))).toMatch(/Removes 3 row\(s\)/);
  }, 60_000);
  it("a WHERE clause with side effects or slow functions is never executed for counting", async () => {
    const seq = async () => (await admin.query("select last_value, is_called from s")).rows[0];
    const before = await seq();
    const r1 = await run("DELETE FROM orders WHERE nextval('s') > 0");
    expect(r1.evidence.unverified.join(" ")).toMatch(/could not be computed/);
    expect(await seq()).toEqual(before);
    const t0 = Date.now();
    const r2 = await run("DELETE FROM orders WHERE pg_sleep(30) IS NULL");
    expect(Date.now() - t0).toBeLessThan(25_000);
    expect(r2.verdict.value).not.toBe("safe");
    expect(await n("select count(*) from orders")).toBe(50);
  }, 90_000);
  it("unknown table, unparseable SQL, empty SQL and SELECT FOR UPDATE are never safe", async () => {
    expect(text(await run("DELETE FROM nope WHERE id=1"))).toMatch(/was not found/);
    for (const s of ["DELETE FRM orders", "SELECT * FROM orders FOR UPDATE", "", "SELECT 1; DELETE FROM orders"]) expect((await run(s)).verdict.value, s).not.toBe("safe");
  }, 90_000);
  it("a plain read of a staging database with a read-only role is safe", async () => {
    const r = await run("SELECT count(*) FROM orders");
    expect(r.verdict.value).toBe("safe");
  }, 60_000);
});
