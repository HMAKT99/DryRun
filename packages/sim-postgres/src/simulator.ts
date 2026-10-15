import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { Action, Finding, ReadOnlyContext, Sandbox, Simulator } from "@dryrun/core";
import { redact, dockerAvailable } from "@dryrun/core";
import { analyzeSql, qident, qn, type Target } from "./analyze.js";
import { createReadOnlyPg, envFromUrl, type ReadOnlyPg } from "./readonly.js";

const SIM = "postgres";
const SAMPLE_ROWS = 1000;
const f = (over: Partial<Finding> & Pick<Finding, "effect">, source: string, detail: string, tier: 1 | 2 | 3 = 1, readonlyCall = false): Finding => ({
  simulator: SIM, tier, severity: "info", reversibility: "reversible", evidenceIds: [],
  evidence: [{ tier, source, detail, readonlyCall }], ...over,
});

const sqlOf = (a: Action) => (typeof a.action === "string" ? a.action : String((a.action as { sql?: unknown }).sql ?? ""));
export function resolveDbUrl(a: Action, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const ref = a.context?.db_url_ref;
  if (!ref) return undefined;
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) return env[ref];
  return ref; // literal URL (CLI --db)
}

const BACKUP_NOTE = "Dry Run cannot verify that a backup or point-in-time recovery exists";

export function createPostgresSimulator(opts: { pgFactory?: (url: string) => ReadOnlyPg; env?: NodeJS.ProcessEnv } = {}): Simulator {
  const mk = opts.pgFactory ?? createReadOnlyPg;
  return {
    id: SIM,
    canHandle: (a) => a.type === "sql",

    async analyze(a) {
      const sql = sqlOf(a);
      const url = resolveDbUrl(a, opts.env);
      const env = envFromUrl(url, a.context?.env_hint);
      const targets = analyzeSql(sql);
      const out: Finding[] = [];
      const envKnown = url || a.context?.env_hint ? env : { level: "unknown" as const, evidence: ["no database connection or environment hint supplied"] };
      for (const t of targets) out.push(...tier1(t, envKnown, sql));
      if (targets.length > 1 || targets.some((t) => t.kind !== "select" || !t.benign)) for (const x of out) x.benign = false;
      return out;
    },

    async inspect(a, _ctx: ReadOnlyContext) {
      const url = resolveDbUrl(a, opts.env);
      if (!url) throw new Error("no read-only database URL (context.db_url_ref / --db)");
      const env = envFromUrl(url, a.context?.env_hint);
      const db = mk(url);
      try {
        const out: Finding[] = [];
        const sql = sqlOf(a);
        const targets = analyzeSql(sql);
        out.push(...(await scopeFinding(db, targets, env)));
        for (const t of targets) out.push(...(await tier2(db, t, env, sql)));
        return out;
      } finally { await db.close(); }
    },

    async rehearse(a, sandbox: Sandbox) {
      const url = resolveDbUrl(a, opts.env);
      if (!url) throw new Error("no database URL to copy schema/data from");
      if (!sandbox.available || !dockerAvailable()) throw new Error(sandbox.reason ?? "Docker unavailable");
      return rehearsePg(url, sqlOf(a), mk);
    },
  };
}

function tier1(t: Target, env: { level: "production" | "staging" | "local" | "unknown"; evidence: string[] }, sql: string): Finding[] {
  const e = { env };
  switch (t.kind) {
    case "select": return t.benign ? [f({ effect: "Read-only query.", benign: true, ...e }, "parser", "single SELECT/EXPLAIN/SHOW")] : [f({ effect: "Query could not be proven read-only (side-effecting function, locking clause or SELECT INTO).", severity: "medium", reversibility: "unknown", unverified: ["query may have side effects"], ...e }, "parser", redact(sql.slice(0, 200)))];
    case "delete": case "update": {
      const verb = t.kind === "delete" ? "Deletes" : "Updates";
      const out = [f({
        effect: t.allRows ? `${verb} EVERY row of ${qn(t.table)} (no effective WHERE clause).` : `${verb} rows of ${qn(t.table)} matching a WHERE clause (count measured in Tier 2).`,
        severity: t.allRows ? "critical" : "medium", reversibility: "irreversible",
        recovery: undefined,
        unverified: [BACKUP_NOTE, ...(t.allRows ? [] : ["pending: number of matching rows not yet measured"])],
        saferAlternative: t.allRows ? `Add a WHERE clause, e.g. ${t.kind === "delete" ? `DELETE FROM ${t.table.name} WHERE <condition>` : `UPDATE ${t.table.name} SET ... WHERE <condition>`}, and take a snapshot first (pg_dump -t ${qn(t.table)}).` : `Take a snapshot first (pg_dump -t ${qn(t.table)}) or run it inside your own transaction on a staging copy.`,
        ...e,
      }, "parser", `${t.kind} ${qn(t.table)}${t.whereSql ? ` where ${redact(t.whereSql).slice(0, 150)}` : ""}`)];
      if (t.hasUsing) out[0]!.unverified!.push("DELETE ... USING / joined UPDATE: affected-row count not computed");
      if (t.hasParams) out[0]!.unverified!.push("statement uses bind parameters ($n): affected-row count cannot be computed");
      return out;
    }
    case "truncate": return [f({ effect: `TRUNCATE ${t.tables.map(qn).join(", ")}${t.cascade ? " CASCADE (also truncates every table with a foreign key to it)" : ""}: removes all rows; not row-by-row recoverable.`, severity: "critical", reversibility: "irreversible", unverified: [BACKUP_NOTE], saferAlternative: "Delete with an explicit WHERE clause, or snapshot first.", ...e }, "parser", "truncate")];
    case "drop": return [f({ effect: `DROP ${t.what.toUpperCase()} ${t.names.map(qn).join(", ")}${t.cascade ? " CASCADE (drops dependent objects too)" : ""}: permanently removes the object and its data.`, severity: "critical", reversibility: "irreversible", unverified: [BACKUP_NOTE], saferAlternative: "Rename the object (ALTER ... RENAME) and drop it after a retention period; take a snapshot first.", ...e }, "parser", `drop ${t.what}`)];
    case "dropColumn": return [f({ effect: `Drops column ${t.column} of ${qn(t.table)}: all values in it are lost.`, severity: "high", reversibility: "irreversible", unverified: [BACKUP_NOTE], saferAlternative: "Stop using the column first; drop it in a later migration after backing up its data.", ...e }, "parser", "drop column")];
    case "alter": return [f({ effect: `ALTER TABLE ${qn(t.table)} (${t.change}) changes the schema; may lock the table or rewrite data.`, severity: "medium", reversibility: "unknown", unverified: ["lock/rewrite impact not measured"], ...e }, "parser", `alter ${t.change}`)];
    case "insert": return [f({ effect: `Inserts rows into ${qn(t.table)}; triggers or defaults may have other effects.`, severity: "low", reversibility: "recoverable", recovery: "delete the inserted rows", unverified: ["triggers/rules not inspected"], ...e }, "parser", "insert")];
    case "other": return [f({ effect: `Statement type "${t.type}" is not in the classification table.`, severity: "medium", reversibility: "unknown", unverified: [`statement type ${t.type} not classified`], ...e }, "parser", t.type)];
    case "unparsed": return [f({ effect: `SQL could not be parsed${t.hint ? ` (${t.hint})` : ""}; treating it as potentially destructive.`, severity: t.hint?.startsWith("contains") ? "high" : "medium", reversibility: "unknown", unverified: ["SQL could not be parsed, so its effects are unknown"], ...e }, "parser", redact(t.text.slice(0, 200)))];
  }
}

async function scopeFinding(db: ReadOnlyPg, targets: Target[], env: { level: "production" | "staging" | "local" | "unknown"; evidence: string[] }): Promise<Finding[]> {
  try {
    const [r] = await db.query("SELECT current_user AS u, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su, (SELECT rolcreatedb OR rolcreaterole FROM pg_roles WHERE rolname = current_user) AS admin, version() AS v, current_database() AS d");
    const writeCaps: string[] = [];
    for (const t of targets) {
      const names = t.kind === "delete" || t.kind === "update" || t.kind === "insert" || t.kind === "dropColumn" || t.kind === "alter" ? [t.table] : t.kind === "truncate" || t.kind === "drop" ? (t.kind === "truncate" ? t.tables : t.names) : [];
      for (const n of names) {
        const [p] = await db.query("SELECT to_regclass($1) IS NOT NULL AS ex, COALESCE(has_table_privilege(to_regclass($1), 'DELETE') OR has_table_privilege(to_regclass($1), 'INSERT') OR has_table_privilege(to_regclass($1), 'UPDATE'), false) AS w", [qn(n)]);
        if (p?.["w"]) writeCaps.push(qn(n));
      }
    }
    const broad = r?.["su"] === true || writeCaps.length > 0;
    return [f({
      effect: broad
        ? `The credential Dry Run was given (role "${r?.["u"]}") ${r?.["su"] ? "is a SUPERUSER" : `can write to ${writeCaps.join(", ")}`}; it is broader than rehearsal needs. Dry Run only used read-only sessions.`
        : `Credential role "${r?.["u"]}" has no write privileges on the affected tables.`,
      severity: broad ? "medium" : "info", reversibility: "reversible", env,
      saferAlternative: broad ? "Create a read-only role for Dry Run: CREATE ROLE dryrun_ro LOGIN PASSWORD '...'; GRANT pg_read_all_data TO dryrun_ro;" : undefined,
      benign: false,
    }, `read-only: role/privilege lookup (pg_roles, has_table_privilege)`, `server ${String(r?.["v"]).slice(0, 40)}, database ${r?.["d"]}`, 2, true)];
  } catch (e) { return [f({ effect: "Could not inspect the credential's privileges.", severity: "low", unverified: [`credential scope not verified: ${(e as Error).message.slice(0, 100)}`] }, "read-only lookup", "failed", 2, true)]; }
}

const num = (v: unknown) => Number(v ?? 0);
type FK = { child_schema: string; child: string; cols: string[]; parent_cols: string[]; on_delete: string; conname: string };

async function foreignKeys(db: ReadOnlyPg, schema: string, table: string): Promise<FK[]> {
  const rows = await db.query(
    `SELECT n.nspname AS child_schema, c.relname AS child, con.conname,
            (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord) JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum) AS cols,
            (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(con.confkey) WITH ORDINALITY k(attnum, ord) JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum) AS parent_cols,
            con.confdeltype AS on_delete
     FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE con.contype = 'f' AND con.confrelid = to_regclass($1)`, [`${q(schema)}.${q(table)}`]);
  return rows.map((r) => ({ child_schema: String(r["child_schema"]), child: String(r["child"]), cols: r["cols"] as string[], parent_cols: r["parent_cols"] as string[], on_delete: String(r["on_delete"]), conname: String(r["conname"]) }));
}
const q = (s: string) => `"${s.replace(/"/g, '""')}"`;

async function tier2(db: ReadOnlyPg, t: Target, env: { level: "production" | "staging" | "local" | "unknown"; evidence: string[] }, sql: string): Promise<Finding[]> {
  const out: Finding[] = [];
  const ev = (what: string, detail: string) => ({ src: `read-only: ${what}`, detail });
  const tables = t.kind === "delete" || t.kind === "update" ? [t.table] : t.kind === "truncate" ? t.tables : t.kind === "drop" && t.what === "table" ? t.names : t.kind === "dropColumn" ? [t.table] : [];
  for (const tbl of tables) {
    const schema = tbl.schema ?? "public";
    const exists = (await db.query("SELECT to_regclass($1) IS NOT NULL AS ex", [`${q(schema)}.${q(tbl.name)}`]))[0]?.["ex"];
    if (!exists) { out.push(f({ effect: `Table ${qn(tbl)} was not found on this database (search_path may differ); the statement may fail or target a different object.`, severity: "low", reversibility: "reversible", unverified: [`${qn(tbl)} not found`], env }, "read-only: to_regclass", qn(tbl), 2, true)); continue; }
    const size = num((await db.query("SELECT pg_total_relation_size($1::regclass) AS s", [`${q(schema)}.${q(tbl.name)}`]))[0]?.["s"]);
    const total = num((await db.query(`SELECT count(*) AS n FROM ${qident(tbl)}`))[0]?.["n"]);
    let affected = total; let measured = true; let whereNote = "";
    if ((t.kind === "delete" || t.kind === "update") && !t.allRows) {
      if (t.hasParams || t.hasUsing || !t.whereSql) { measured = false; }
      else {
        try { affected = num((await db.query(`SELECT count(*) AS n FROM ${qident(tbl)} AS ${q(t.alias ?? tbl.name)} WHERE ${t.whereSql}`))[0]?.["n"]); whereNote = ` matching the WHERE clause`; }
        catch (e) { measured = false; whereNote = ` (count failed: ${(e as Error).message.slice(0, 80)})`; }
      }
    }
    const destructive = t.kind === "delete" || t.kind === "truncate" || t.kind === "drop";
    if (t.kind === "dropColumn") {
      const nn = num((await db.query(`SELECT count(${q(t.column)}) AS n FROM ${qident(tbl)}`).catch(() => [{ n: 0 }]))[0]?.["n"]);
      out.push(f({ effect: `Column ${t.column} holds ${nn} non-null value(s) across ${total} row(s) in ${qn(tbl)}; dropping it loses them.`, severity: nn ? "high" : "low", reversibility: "irreversible", blast: { rows: nn, bytes: 0 }, env, unverified: [BACKUP_NOTE] }, ev("count non-null column values", `${qn(tbl)}.${t.column}: ${nn}/${total}`).src, `${nn}/${total} non-null`, 2, true));
    } else {
      const verb = t.kind === "delete" ? "Removes" : t.kind === "update" ? "Modifies" : t.kind === "truncate" ? "Removes" : "Destroys";
      out.push(f({
        effect: `${verb} ${measured ? affected : "an unmeasured number of"} row(s)${whereNote} of ${qn(tbl)} (${total} total, table size ${fmt(size)}).${t.kind === "drop" || t.kind === "truncate" ? "" : ""}`,
        severity: destructive && affected > 0 ? (affected === total ? "critical" : "high") : "medium",
        reversibility: destructive || t.kind === "update" ? "irreversible" : "reversible",
        blast: { rows: measured ? affected : undefined, bytes: t.kind === "drop" ? size : undefined }, env,
        unverified: measured ? [BACKUP_NOTE] : [BACKUP_NOTE, "affected-row count could not be computed"],
      }, ev("exact row count and pg_total_relation_size", `${qn(tbl)}: affected=${measured ? affected : "?"}, total=${total}, size=${size}B`).src, `affected=${measured ? affected : "?"} total=${total} size=${size}`, 2, true));
    }
    // FK dependents
    if (t.kind === "delete" || t.kind === "truncate" || t.kind === "drop") {
      const fks = await foreignKeys(db, schema, tbl.name);
      const cascading = t.kind === "truncate" || t.kind === "drop" ? t.cascade : false;
      for (const fk of fks) {
        const child = `${fk.child_schema}.${fk.child}`;
        const childId = `${q(fk.child_schema)}.${q(fk.child)}`;
        const isCascade = fk.on_delete === "c";
        const action = { c: "CASCADE", n: "SET NULL", d: "SET DEFAULT", r: "RESTRICT", a: "NO ACTION" }[fk.on_delete] ?? fk.on_delete;
        let kids = 0; let kidsMeasured = true;
        try {
          if (t.kind === "delete" && !t.allRows && t.whereSql && !t.hasParams && !t.hasUsing) {
            const al = q(t.alias ?? tbl.name);
            const join = fk.cols.map((c, i) => `${al}.${q(fk.parent_cols[i]!)} = c.${q(c)}`).join(" AND ");
            kids = num((await db.query(`SELECT count(*) AS n FROM ${childId} c WHERE EXISTS (SELECT 1 FROM ${qident(tbl)} AS ${al} WHERE ${join} AND (${t.whereSql}))`))[0]?.["n"]);
          } else kids = num((await db.query(`SELECT count(*) AS n FROM ${childId}`))[0]?.["n"]);
        } catch (err) { kidsMeasured = false; if (process.env.DRYRUN_DEBUG) console.error("cascade count failed:", (err as Error).message); }
        const wouldCascade = (t.kind === "delete" && isCascade) || (t.kind !== "delete" && cascading);
        if (wouldCascade) {
          out.push(f({ effect: `Cascades into ${child}: ${kidsMeasured ? kids : "an unmeasured number of"} dependent row(s) would also be ${isCascade || t.kind !== "delete" ? "deleted" : "affected"} (FK ${fk.conname}, ON DELETE ${action}).`, severity: kids ? "high" : "low", reversibility: "irreversible", blast: { rows: kidsMeasured ? kids : undefined }, env, unverified: kidsMeasured ? ["cascades deeper than one level are not counted"] : ["cascade row count unavailable"] }, "read-only: pg_constraint + dependent row count", `${child} via ${fk.conname}: ${kidsMeasured ? kids : "?"}`, 2, true));
        } else if (t.kind === "delete" && (fk.on_delete === "r" || fk.on_delete === "a") && kids > 0 && affected > 0) {
          out.push(f({ effect: `${child} references ${qn(tbl)} (ON DELETE ${action}); the DELETE would fail with a foreign-key violation if referenced rows are included.`, severity: "info", reversibility: "reversible", env, unverified: ["whether a referencing row is among the matched rows was not checked"] }, "read-only: pg_constraint", child, 2, true));
        } else if (t.kind === "delete" && (fk.on_delete === "n" || fk.on_delete === "d") && kids > 0) {
          out.push(f({ effect: `${child}.${fk.cols.join(",")} would be set to ${fk.on_delete === "n" ? "NULL" : "DEFAULT"} on up to ${kids} row(s).`, severity: "medium", reversibility: "irreversible", env, blast: { rows: kids } }, "read-only: pg_constraint", child, 2, true));
        }
      }
      if (t.kind === "drop") {
        const views = await db.query(`SELECT DISTINCT n.nspname AS s, c2.relname AS v FROM pg_depend d JOIN pg_rewrite r ON r.oid = d.objid JOIN pg_class c2 ON c2.oid = r.ev_class JOIN pg_namespace n ON n.oid = c2.relnamespace WHERE d.refobjid = $1::regclass AND c2.oid <> $1::regclass`, [`${q(schema)}.${q(tbl.name)}`]);
        if (views.length) out.push(f({ effect: `Views depending on ${qn(tbl)}: ${views.map((v) => `${v["s"]}.${v["v"]}`).join(", ")}${t.cascade ? " would be dropped too" : " would make DROP fail without CASCADE"}.`, severity: t.cascade ? "high" : "info", reversibility: t.cascade ? "irreversible" : "reversible", env }, "read-only: pg_depend", `${views.length} view(s)`, 2, true));
      }
    }
    // Planner view (no ANALYZE => nothing executes)
    if ((t.kind === "delete" || t.kind === "update") && !t.hasParams && !t.hasUsing && t.whereSql) {
      try {
        const plan = await db.query(`EXPLAIN (FORMAT JSON) SELECT * FROM ${qident(tbl)} AS ${q(t.alias ?? tbl.name)} WHERE ${t.whereSql}`);
        const p = (plan[0]?.["QUERY PLAN"] as Array<{ Plan?: { "Plan Rows"?: number; "Total Cost"?: number } }> | undefined)?.[0]?.Plan;
        out.push(f({ effect: `Planner estimates ${p?.["Plan Rows"] ?? "?"} row(s) touched (cost ${p?.["Total Cost"] ?? "?"}); estimate from a SELECT with the same WHERE (EXPLAIN without ANALYZE; nothing executes).`, severity: "info", reversibility: "reversible", env, benign: false }, "read-only: EXPLAIN (FORMAT JSON), no ANALYZE", JSON.stringify(p ?? {}).slice(0, 200), 2, true));
      } catch (e) { out.push(f({ effect: "EXPLAIN failed for this statement.", severity: "info", unverified: [`EXPLAIN failed: ${(e as Error).message.slice(0, 100)}`] }, "read-only: EXPLAIN", "failed", 2, true)); }
    }
  }
  return out;
}

function fmt(b: number): string { return b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : b > 1e3 ? `${(b / 1e3).toFixed(1)} kB` : `${b} B`; }

// ------------------------------------------------------------------ Tier 3

function docker(args: string[], input?: string, timeout = 60_000): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((res) => {
    const p = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (b) => { if (out.length < 5e6) out += b; });
    p.stderr.on("data", (b) => { if (err.length < 1e5) err += b; });
    const t = setTimeout(() => p.kill("SIGKILL"), timeout);
    p.on("close", (code) => { clearTimeout(t); res({ code, out, err }); });
    p.on("error", () => { clearTimeout(t); res({ code: null, out, err: "docker failed to start" }); });
    p.stdin.on("error", () => {});
    p.stdin.end(input ?? "");
  });
}

async function rehearsePg(url: string, sql: string, mk: (u: string) => ReadOnlyPg): Promise<Finding[]> {
  const name = "dryrun-pg-" + randomBytes(5).toString("hex");
  const db = mk(url);
  const unverified: string[] = [`Tier 3 ran on a SAMPLE (up to ${SAMPLE_ROWS} rows per table); row counts there are not the real counts`];
  const env = { level: "local" as const, evidence: ["rehearsed in a disposable no-network Postgres container"] };
  try {
    const ver = String((await db.query("SHOW server_version_num"))[0]?.["server_version_num"] ?? "160000");
    const major = Math.floor(Number(ver) / 10000);
    const image = `postgres:${major}-alpine`;
    const have = spawnSync("docker", ["image", "inspect", image]).status === 0;
    const useImage = have ? image : "postgres:16-alpine";
    if (!have) unverified.push(`server is Postgres ${major} but image ${image} is not installed locally; used ${useImage}`);
    // 1. Disposable server: NO network, memory/cpu/pid limits, data in tmpfs.
    const run = await docker(["run", "-d", "--name", name, "--network", "none", "--memory", "768m", "--cpus", "1", "--pids-limit", "256", "--security-opt", "no-new-privileges",
      "--cap-drop", "ALL", "--cap-add", "CHOWN", "--cap-add", "SETUID", "--cap-add", "SETGID", "--cap-add", "DAC_OVERRIDE", "--cap-add", "FOWNER",
      "--tmpfs", "/var/lib/postgresql/data:rw,size=512m", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-e", "POSTGRES_DB=sandbox", useImage]);
    if (run.code !== 0) throw new Error(`could not start sandbox: ${run.err.trim().slice(0, 150)}`);
    let ready = false;
    for (let i = 0; i < 40 && !ready; i++) { ready = (await docker(["exec", name, "pg_isready", "-U", "postgres", "-d", "sandbox", "-h", "127.0.0.1"], undefined, 5000)).code === 0; if (!ready) await new Promise((r) => setTimeout(r, 750)); }
    if (!ready) throw new Error("sandbox Postgres did not become ready");
    // psql inside the sandbox; the initial entrypoint restart can race, so retry briefly.
    const psql = (input: string, extra: string[] = []) => docker(["exec", "-i", name, "psql", "-X", "-q", "-U", "postgres", "-d", "sandbox", "-h", "127.0.0.1", ...extra], input, 90_000);
    for (let i = 0; i < 10; i++) { if ((await psql("select 1", ["-tA"])).code === 0) break; await new Promise((r) => setTimeout(r, 700)); }

    // 2. Schema: pg_dump --schema-only (a read-only tool) in a separate short-lived container that may reach the source.
    const u = new URL(url);
    const loopback = ["localhost", "127.0.0.1", "::1"].includes(u.hostname);
    // Docker Desktop maps host.docker.internal to the host; on Linux the host's loopback is only reachable with host networking.
    const linuxLoopback = loopback && process.platform === "linux";
    const host = linuxLoopback ? "127.0.0.1" : loopback ? "host.docker.internal" : u.hostname;
    const dump = await docker(["run", "--rm", ...(linuxLoopback ? ["--network", "host"] : []), "--cpus", "1", "--memory", "512m", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "-e", `PGPASSWORD=${decodeURIComponent(u.password)}`, "-e", "PGOPTIONS=-c default_transaction_read_only=on",
      useImage, "pg_dump", "--schema-only", "--no-owner", "--no-privileges", "-h", host, "-p", u.port || "5432", "-U", decodeURIComponent(u.username), "-d", u.pathname.slice(1)], undefined, 120_000);
    if (dump.code !== 0) throw new Error(`schema dump failed: ${redact(dump.err).trim().slice(0, 150)}`);
    const load = await psql(dump.out);
    const loadErrors = (load.err.match(/ERROR/g) ?? []).length;
    if (loadErrors) unverified.push(`${loadErrors} schema statement(s) failed to load in the sandbox (extensions/roles?)`);

    // 3. Sample rows through the read-only connection; load with FK checks off.
    const tables = await db.query("SELECT table_schema AS s, table_name AS t FROM information_schema.tables WHERE table_type='BASE TABLE' AND table_schema NOT IN ('pg_catalog','information_schema') ORDER BY 1,2");
    const realCounts: Record<string, number> = {};
    for (const tb of tables) {
      const id = `${q(String(tb["s"]))}.${q(String(tb["t"]))}`;
      realCounts[`${tb["s"]}.${tb["t"]}`] = num((await db.query(`SELECT count(*) AS n FROM ${id}`))[0]?.["n"]);
      const rows = await db.query(`SELECT coalesce(json_agg(x), '[]'::json) AS j FROM (SELECT * FROM ${id} LIMIT ${SAMPLE_ROWS}) x`);
      const json = JSON.stringify(rows[0]?.["j"] ?? []);
      if (json === "[]") continue;
      const tag = "J" + randomBytes(4).toString("hex");
      const ins = await psql(`SET session_replication_role = replica;\nINSERT INTO ${id} SELECT * FROM json_populate_recordset(null::${id}, $${tag}$${json}$${tag}$::json);\n`);
      if (ins.code !== 0 || /ERROR/.test(ins.err)) unverified.push(`sampling ${tb["s"]}.${tb["t"]} partially failed`);
    }
    const snapshot = async () => {
      const counts: Record<string, number> = {};
      for (const tb of tables) {
        const r = await psql(`select count(*) from ${q(String(tb["s"]))}.${q(String(tb["t"]))}`, ["-tA"]);
        counts[`${tb["s"]}.${tb["t"]}`] = r.code === 0 ? Number(r.out.trim()) : NaN;
      }
      const cols = (await psql("select table_schema||'.'||table_name||'.'||column_name from information_schema.columns where table_schema not in ('pg_catalog','information_schema') order by 1", ["-tA"])).out.split("\n").filter(Boolean);
      const rels = (await psql("select schemaname||'.'||tablename from pg_tables where schemaname not in ('pg_catalog','information_schema') order by 1", ["-tA"])).out.split("\n").filter(Boolean);
      return { counts, cols, rels };
    };
    const before = await snapshot();
    // 4. Run the untrusted statement ONLY here. Failure of the statement is itself information.
    const exec = await psql(`SET session_replication_role = origin;\n${sql}\n`, ["-v", "ON_ERROR_STOP=1"]);
    const after = await snapshot();
    const out: Finding[] = [];
    const ev = (d: string) => ({ source: "disposable Postgres container (--network none), before/after diff", detail: d });
    if (exec.code !== 0) unverified.push(`statement errored in the sandbox: ${redact(exec.err).trim().split("\n")[0]?.slice(0, 160)}`);
    const rowDiffs = Object.keys(before.counts).map((k) => ({ k, b: before.counts[k]!, a: after.counts[k]!, real: realCounts[k] ?? 0 })).filter((d) => d.b !== d.a);
    for (const d of rowDiffs) {
      const pct = d.b ? Math.round(((d.b - (Number.isNaN(d.a) ? 0 : d.a)) / d.b) * 100) : 0;
      out.push(f({ effect: Number.isNaN(d.a) ? `${d.k} no longer exists in the sandbox after the statement.` : `Sandbox rehearsal: ${d.k} went from ${d.b} to ${d.a} sampled row(s) (${pct}% of the sample removed; full table has ${d.real}).`, severity: "low", reversibility: "reversible", env, unverified }, ev(`${d.k}: ${d.b} -> ${d.a}`).source, ev(`${d.k}: ${d.b} -> ${d.a}`).detail, 3));
    }
    const dropped = [...before.cols.filter((c) => !after.cols.includes(c))], added = after.cols.filter((c) => !before.cols.includes(c));
    const goneTables = before.rels.filter((r) => !after.rels.includes(r));
    if (goneTables.length) out.push(f({ effect: `Sandbox rehearsal: table(s) dropped: ${goneTables.join(", ")}.`, severity: "low", reversibility: "reversible", env, unverified }, ev("pg_tables diff").source, `dropped ${goneTables.join(",")}`, 3));
    const colsGone = dropped.filter((c) => !goneTables.some((t) => c.startsWith(t + ".")));
    if (colsGone.length) out.push(f({ effect: `Sandbox rehearsal: column(s) dropped: ${colsGone.join(", ")}.`, severity: "low", reversibility: "reversible", env, unverified }, ev("information_schema.columns diff").source, colsGone.join(","), 3));
    if (added.length) out.push(f({ effect: `Sandbox rehearsal: ${added.length} column(s) added.`, severity: "low", reversibility: "reversible", env, unverified }, ev("information_schema.columns diff").source, added.join(","), 3));
    if (!out.length) out.push(f({ effect: "Sandbox rehearsal observed no row-count or schema change.", severity: "low", reversibility: "reversible", env, unverified }, ev("no diff").source, "no diff", 3));
    return out;
  } finally {
    await db.close();
    spawnSync("docker", ["rm", "-f", "-v", name], { timeout: 20_000 });
  }
}
