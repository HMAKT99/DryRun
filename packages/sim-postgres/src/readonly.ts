import pg from "pg";
import { assertReadOnlySql, redact, registerSecret } from "@dryrun/core";

export interface ReadOnlyPg {
  query(sql: string, params?: unknown[]): Promise<Array<Record<string, unknown>>>;
  calls: string[];
  close(): Promise<void>;
}

/**
 * Postgres client for Tier 2. Defense in depth:
 *  1. every statement must pass assertReadOnlySql (single SELECT/EXPLAIN/SHOW, no side-effect functions),
 *  2. the session is read-only at the server (default_transaction_read_only=on),
 *  3. statement timeout bounds expensive counts.
 * The user's own statement is NEVER sent here except inside EXPLAIN (no ANALYZE).
 */
export function createReadOnlyPg(url: string, factory: (cfg: pg.ClientConfig) => pg.Client = (c) => new pg.Client(c)): ReadOnlyPg {
  try { registerSecret(decodeURIComponent(new URL(url).password)); } catch { /* not a URL */ }
  const client = factory({
    connectionString: url,
    options: "-c default_transaction_read_only=on -c statement_timeout=8000 -c lock_timeout=1000 -c idle_in_transaction_session_timeout=10000",
    application_name: "dryrun-readonly",
    connectionTimeoutMillis: 8000,
  });
  let connected: Promise<unknown> | undefined;
  const calls: string[] = [];
  return {
    calls,
    async query(sql, params) {
      assertReadOnlySql(sql);
      connected ??= client.connect();
      await connected;
      calls.push(redact(sql.replace(/\s+/g, " ").trim()));
      const r = await client.query(sql, params as unknown[]);
      return r.rows;
    },
    async close() { if (connected) { try { await client.end(); } catch { /* ignore */ } } },
  };
}

export function envFromUrl(url: string | undefined, hint?: string): { level: "production" | "staging" | "local" | "unknown"; evidence: string[] } {
  const ev: string[] = [];
  if (hint) ev.push(`caller-supplied environment hint "${hint}"`);
  let host = "", db = "";
  if (url) { try { const u = new URL(url); host = u.hostname; db = u.pathname.replace(/^\//, ""); } catch { /* ignore */ } }
  const text = `${host} ${db} ${hint ?? ""}`.toLowerCase();
  if (/(^|[\s\-_.])(prod|production|live|prd)([\s\-_.]|$)/.test(text)) { ev.push(`name contains a production marker (host "${host}", database "${db}")`); return { level: "production", evidence: ev }; }
  if (/(^|[\s\-_.])(staging|stage|dev|test|qa|sandbox)([\s\-_.]|$)/.test(text)) { ev.push(`name contains a non-production marker (host "${host}", database "${db}")`); return { level: "staging", evidence: ev }; }
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") { ev.push("connection is to localhost; not a shared environment as far as can be verified"); return { level: "local", evidence: ev }; }
  ev.push(`no environment marker found in host "${host || "?"}" or database "${db || "?"}"`);
  return { level: "unknown", evidence: ev };
}
