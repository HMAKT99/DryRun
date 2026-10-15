import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const Resolve = z.object({
  id: z.string(), get: z.string(), extract: z.record(z.string()).default({}),
  needs: z.array(z.string()).optional(), backup_location_field: z.string().optional(),
});
const Op = z.object({
  id: z.string(),
  match: z.object({ method: z.string().optional(), path: z.string().optional(), graphql: z.string().optional(), operation: z.string().optional(), path_params: z.array(z.string()).optional() }),
  description: z.string(),
  destructive: z.boolean(),
  read_only: z.boolean().optional(),
  reversibility: z.enum(["reversible", "recoverable", "irreversible", "unknown"]),
  recovery: z.string().optional(),
  data_bearing: z.boolean(),
  resource: z.string().optional(),
  safer: z.string().optional(),
  resolve: z.array(Resolve).optional(),
  reversibility_by_param: z.object({ param: z.string(), when_false: z.enum(["reversible", "recoverable", "irreversible"]), when_true: z.enum(["reversible", "recoverable", "irreversible"]), recovery_when_false: z.string().optional() }).optional(),
});
export const CatalogSchema = z.object({
  provider: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string(),
  catalog_version: z.number().int(),
  status: z.string(),
  notes: z.string().optional(),
  base_url: z.string().optional(),
  auth: z.object({ header: z.string(), scheme: z.string() }).optional(),
  token_introspection: z.object({
    get: z.string(), extract: z.record(z.string()),
    broad_if: z.object({ scope_type: z.array(z.string()).optional(), scopes_include: z.array(z.string()).optional() }).optional(),
  }).optional(),
  operations: z.array(Op),
});
export type Catalog = z.infer<typeof CatalogSchema>;
export type CatalogOp = z.infer<typeof Op>;

export function defaultCatalogDir(): string {
  if (process.env["DRYRUN_CATALOG_DIR"]) return process.env["DRYRUN_CATALOG_DIR"];
  const here = dirname(fileURLToPath(import.meta.url));
  // Source layout: <pkg>/dist/../catalog. Bundled layout: <bundle dir>/catalog.
  return [join(here, "..", "catalog"), join(here, "catalog")].find((d) => existsSync(d)) ?? join(here, "catalog");
}

export function loadCatalogs(dir: string = defaultCatalogDir()): Catalog[] {
  return readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => {
    const c = CatalogSchema.parse(JSON.parse(readFileSync(join(dir, f), "utf8")));
    const ids = new Set<string>();
    for (const o of c.operations) { if (ids.has(o.id)) throw new Error(`${f}: duplicate operation id ${o.id}`); ids.add(o.id); }
    return c;
  });
}

export interface Resolved { op: CatalogOp; params: Record<string, string> }
export function pathCandidates(path: string, baseUrl?: string): string[] {
  const p = path.split("?")[0]!;
  const out = [p];
  let bp = "";
  try { bp = baseUrl ? new URL(baseUrl).pathname.replace(/\/$/, "") : ""; } catch { /* ignore */ }
  if (bp) { out.push(p.startsWith(bp + "/") ? p.slice(bp.length) : bp + p); } // agents often omit (or repeat) the API prefix present in the base URL
  return out;
}
export function findOperation(c: Catalog, a: { operation?: string; method?: string; path?: string; params?: Record<string, unknown>; baseUrl?: string }): Resolved | undefined {
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(a.params ?? {})) params[k] = String(v);
  for (const op of c.operations) {
    if (a.operation && (op.id === a.operation || op.match.operation === a.operation || op.match.graphql === a.operation)) return { op, params };
    if (a.method && a.path && op.match.method === a.method.toUpperCase() && op.match.path) {
      const re = new RegExp(op.match.path);
      const m = pathCandidates(a.path, a.baseUrl ?? c.base_url).map((p) => re.exec(p)).find(Boolean);
      if (m) { (op.match.path_params ?? []).forEach((n, i) => { if (m[i + 1]) params[n] = decodeURIComponent(m[i + 1]!); }); return { op, params }; }
    }
  }
  return undefined;
}
