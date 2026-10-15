import type { ReadOnlyContext } from "./types.js";

export class WriteAttemptError extends Error {
  constructor(what: string) {
    super(`Dry Run refused a non-read-only operation against a real system: ${what}`);
  }
}

/**
 * HTTP client that can only GET/HEAD. Every call is also recorded so reports can list
 * the exact read-only calls made. POST-based read APIs (e.g. GraphQL queries) must go
 * through `graphqlQuery`, which rejects mutations/subscriptions.
 */
export function createReadOnlyHttp(
  fetchImpl: typeof fetch = fetch,
  log: (call: string) => void = () => {},
) {
  async function send(method: "GET" | "POST", url: string, headers?: Record<string, string>, body?: string) {
    log(`${method} ${stripQuerySecrets(url)}`);
    const res = await fetchImpl(url, { method, headers, body, redirect: "manual" });
    const text = await res.text();
    let parsed: unknown = text;
    try { parsed = JSON.parse(text); } catch { /* keep text */ }
    return { status: res.status, body: parsed };
  }
  return {
    get: (url: string, headers?: Record<string, string>) => send("GET", url, headers),
    async graphqlQuery(url: string, query: string, variables?: unknown, headers?: Record<string, string>) {
      assertGraphqlQuery(query);
      return send("POST", url, { "content-type": "application/json", ...headers }, JSON.stringify({ query, variables }));
    },
  };
}

function stripQuerySecrets(url: string): string {
  return url.replace(/([?&](?:key|token|api_key|apikey|access_token)=)[^&]+/gi, "$1[REDACTED]");
}

/** Allow only anonymous/named `query` operations; reject mutation/subscription anywhere. */
export function assertGraphqlQuery(q: string): void {
  const stripped = q.replace(/#[^\n]*/g, "").replace(/"(?:[^"\\]|\\.)*"/g, '""');
  if (/\b(mutation|subscription)\b/i.test(stripped)) throw new WriteAttemptError("GraphQL mutation/subscription");
  if (!/^\s*(query\b|\{)/i.test(stripped)) throw new WriteAttemptError("GraphQL document is not a plain query");
}

const FORBIDDEN_SQL_FN =
  /\b(nextval|setval|set_config|pg_terminate_backend|pg_cancel_backend|pg_advisory\w*|pg_reload_conf|pg_rotate_logfile|pg_switch_wal|pg_create_\w+|pg_drop_\w+|pg_read_\w+|pg_ls_\w+|lo_\w+|dblink\w*|copy|do|call|refresh|vacuum|analyze|cluster|reindex|listen|notify|lock)\b/i;

/**
 * Conservative gate for SQL Dry Run itself sends to a real database. This is
 * defense-in-depth; the connection is ALSO opened read-only at the server level.
 * Throws unless the text is a single SELECT / EXPLAIN (without ANALYZE) / SHOW.
 */
export function assertReadOnlySql(sql: string): void {
  const s = sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "").trim().replace(/;\s*$/, "");
  const noStrings = s.replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"]|"")*"/g, '""');
  if (noStrings.includes(";")) throw new WriteAttemptError("multiple SQL statements");
  if (!/^(select|with|show|explain)\b/i.test(noStrings)) throw new WriteAttemptError("SQL is not SELECT/EXPLAIN/SHOW");
  if (/^explain\b[^]*\banalyze\b/i.test(noStrings)) throw new WriteAttemptError("EXPLAIN ANALYZE executes the statement");
  if (/\binto\b/i.test(noStrings) || /\bfor\s+(update|share|no\s+key\s+update|key\s+share)\b/i.test(noStrings))
    throw new WriteAttemptError("SELECT INTO / locking clause");
  if (/^with\b/i.test(noStrings) && /\b(insert|update|delete|merge)\b/i.test(noStrings))
    throw new WriteAttemptError("data-modifying CTE");
  if (FORBIDDEN_SQL_FN.test(noStrings)) throw new WriteAttemptError("side-effecting function or command");
}

export function makeReadOnlyContext(http: ReadOnlyContext["http"]): ReadOnlyContext {
  return Object.freeze({ kind: "readonly" as const, http });
}
