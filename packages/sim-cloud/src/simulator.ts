import type { Action, Finding, ReadOnlyContext, Reversibility, Simulator } from "@dryrun/core";
import { redact, registerSecret } from "@dryrun/core";
import { findOperation, loadCatalogs, type Catalog, type CatalogOp } from "./catalog.js";

const SIM = "cloud";
type Env = { level: "production" | "staging" | "unknown"; evidence: string[] };
const f = (over: Partial<Finding> & Pick<Finding, "effect">, source: string, detail: string, tier: 1 | 2 = 1, readonlyCall = false): Finding => ({
  simulator: SIM, tier, severity: "info", reversibility: "reversible", evidenceIds: [],
  evidence: [{ tier, source, detail, readonlyCall }], ...over,
});

interface Req { provider: string; operation?: string; method?: string; path?: string; params: Record<string, unknown> }
export function normalize(a: Action): Req {
  const o = (typeof a.action === "object" ? a.action : { operation: a.action }) as Record<string, unknown>;
  return {
    provider: String(o["provider"] ?? a.context?.provider ?? ""),
    operation: o["operation"] as string | undefined, method: o["method"] as string | undefined, path: o["path"] as string | undefined,
    params: { ...(a.context?.params ?? {}), ...((o["params"] as Record<string, unknown>) ?? {}) },
  };
}

const get = (obj: unknown, path: string): unknown => path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
const PROD = /(^|[\s\-_.\/])(prod|production|live|prd)([\s\-_.\/]|$)/i;
const NONPROD = /(^|[\s\-_.\/])(dev|development|staging|stage|test|qa|sandbox|preview)([\s\-_.\/]|$)/i;
const NONPROD_DOMAIN = /(localhost|\.local$|\.test$|staging|\.dev$|preview|-git-|\.vercel\.app$|\.up\.railway\.app$)/i;
const gb = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${b} B`);

export function createCloudSimulator(opts: { catalogs?: Catalog[]; env?: NodeJS.ProcessEnv } = {}): Simulator {
  const catalogs = opts.catalogs ?? loadCatalogs();
  const env = opts.env ?? process.env;
  const find = (a: Action) => {
    const r = normalize(a);
    const cat = catalogs.find((c) => c.provider === r.provider.toLowerCase());
    return { r, cat, hit: cat ? findOperation(cat, { operation: r.operation, method: r.method, path: r.path, params: r.params, baseUrl: a.context?.base_url ?? env[`DRYRUN_${cat.provider.toUpperCase()}_BASE_URL`] }) : undefined };
  };
  return {
    id: SIM,
    canHandle: (a) => a.type === "cloud_api",

    async analyze(a) {
      const { r, cat, hit } = find(a);
      if (!cat) return [f({ effect: `Provider "${r.provider}" has no operation catalog; consequences cannot be assessed.`, severity: "medium", reversibility: "unknown", unverified: [`no catalog for provider "${r.provider}" (add one under packages/sim-cloud/catalog)`] }, "catalog", `known: ${catalogs.map((c) => c.provider).join(", ")}`)];
      if (!hit) return [f({ effect: `Operation ${r.operation ?? `${r.method} ${r.path}`} is not in the ${cat.provider} catalog; treating it as potentially destructive.`, severity: "medium", reversibility: "unknown", unverified: [`operation not in ${cat.provider} catalog`] }, "catalog", `${cat.provider} v${cat.catalog_version}`)];
      const { op, params } = hit;
      if (op.read_only) return [f({ effect: `${op.description} (read-only operation).`, benign: true }, "catalog", `${cat.provider}:${op.id} read_only`)];
      let rev: Reversibility = op.reversibility; let recovery = op.recovery;
      const byParam = op.reversibility_by_param;
      const unverified: string[] = [];
      if (byParam) {
        const v = params[byParam.param];
        if (v === undefined) unverified.push(`parameter ${byParam.param} not supplied; assuming the more destructive default`);
        else { const skip = v === "true"; rev = skip ? byParam.when_true : byParam.when_false; if (!skip) recovery = byParam.recovery_when_false; }
      }
      const target = Object.entries(params).map(([k, v]) => `${k}=${String(v)}`).join(", ");
      if (cat.status.includes("classification-only")) unverified.push(`${cat.provider} target resolution is not implemented; what "${target}" contains and whether it is production is unknown`);
      return [f({
        effect: `${op.description}${target ? ` [${target}]` : ""}. Catalog says: ${rev}${op.data_bearing ? ", data-bearing" : ""}.`,
        severity: op.destructive ? (op.data_bearing && rev === "irreversible" ? "critical" : "high") : "low",
        reversibility: rev, recovery, saferAlternative: op.safer, unverified: [...unverified, "pending: target not yet resolved (needs Tier 2 read-only inspection)"],
      }, "operation catalog", `${cat.provider}:${op.id} v${cat.catalog_version} (${cat.status})`)];
    },

    async inspect(a, ctx: ReadOnlyContext) {
      const { r, cat, hit } = find(a);
      if (!cat || !hit || hit.op.read_only) return [];
      if (!ctx.http) throw new Error("no read-only HTTP client available");
      const base = a.context?.base_url ?? env[`DRYRUN_${cat.provider.toUpperCase()}_BASE_URL`] ?? cat.base_url;
      if (!base) throw new Error(`no base URL for provider ${cat.provider}`);
      const roRef = a.context?.readonly_token_ref ?? `DRYRUN_${cat.provider.toUpperCase()}_READONLY_TOKEN`;
      const agentTok = a.context?.credential_ref ? env[a.context.credential_ref] : undefined;
      const roTok = env[roRef];
      registerSecret(roTok); registerSecret(agentTok);
      const tok = roTok ?? agentTok;
      if (!tok) throw new Error(`no read-only credential (set ${roRef})`);
      const hdr = (t: string) => cat.auth ? { [cat.auth.header]: `${cat.auth.scheme} ${t}`.trim() } : {};
      const out: Finding[] = [];
      const { op, params } = hit;
      const ev = (url: string, detail: string) => ({ src: `GET ${redact(url)}`, detail });
      if (!roTok) out.push(f({ effect: `No read-only credential configured (${roRef}); Dry Run used the agent's own credential for GET-only lookups.`, severity: "low", reversibility: "reversible", saferAlternative: `Create a read-only token for Dry Run and set ${roRef}.`, unverified: ["read-only credential not configured"] }, "credential setup", "agent credential reused for GET requests only", 2));

      // --- resolve the target
      const data: Record<string, Record<string, unknown>> = {};
      const known: Record<string, unknown> = { ...params };
      const failed: string[] = [];
      for (const rs of op.resolve ?? []) {
        if (rs.needs?.some((n) => known[n] === undefined)) { failed.push(`${rs.id}: needs ${rs.needs.filter((n) => known[n] === undefined).join(",")}`); continue; }
        const path = rs.get.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(String(known[k] ?? "")));
        const url = base.replace(/\/$/, "") + path;
        try {
          const res = await ctx.http.get(url, hdr(tok));
          if (res.status >= 400) { failed.push(`${rs.id}: HTTP ${res.status}`); continue; }
          const got: Record<string, unknown> = {};
          for (const [k, p] of Object.entries(rs.extract)) { got[k] = get(res.body, p); if (got[k] !== undefined) known[k] = got[k]; }
          data[rs.id] = got;
          out.push(f({ effect: `Resolved ${rs.id} for ${op.id}.`, severity: "info", benign: false }, ev(url, "").src, redact(JSON.stringify(got)).slice(0, 300), 2, true));
        } catch (e) { failed.push(`${rs.id}: ${(e as Error).message.slice(0, 80)}`); }
      }
      const vol = data["volume"] ?? {};
      const name = (vol["name"] as string | undefined) ?? Object.values(params).map(String).join("/");
      const bytes = typeof vol["bytes"] === "number" ? (vol["bytes"] as number) : undefined;

      // --- environment confidence
      const evd: string[] = []; let prodSig = 0, nonSig = 0;
      if (PROD.test(String(name))) { prodSig++; evd.push(`name "${name}" contains a production marker`); }
      if (vol["project"] && PROD.test(String(vol["project"]))) { prodSig++; evd.push(`project "${vol["project"]}" contains a production marker`); }
      const tags = (vol["tags"] ?? {}) as Record<string, unknown>;
      for (const [k, v] of Object.entries(tags)) if (/env|stage|tier/i.test(k)) { if (PROD.test(String(v))) { prodSig++; evd.push(`tag ${k}=${String(v)}`); } else if (NONPROD.test(String(v))) { nonSig++; evd.push(`tag ${k}=${String(v)}`); } }
      const domains = ((data["domains"]?.["domains"] as unknown[]) ?? []).map(String);
      const live = domains.filter((d) => !NONPROD_DOMAIN.test(d));
      if (live.length) { prodSig++; evd.push(`serves public domain(s): ${live.join(", ")}`); }
      const rpm = data["traffic"]?.["rpm"];
      if (typeof rpm === "number" && rpm > 0) { prodSig++; evd.push(`live traffic: ${rpm} requests/min`); }
      const envRes: Env = prodSig ? { level: "production", evidence: nonSig ? [...evd, "(some non-production markers also present; treating as production)"] : evd } : nonSig ? { level: "staging", evidence: evd } : { level: "unknown", evidence: evd.length ? evd : ["no production or staging markers found"] };

      // --- backups
      let rev: Reversibility = op.reversibility; let recovery = op.recovery;
      const unv: string[] = failed.length ? failed.map((x) => `could not resolve ${x}`) : [];
      let backupText = "";
      const bk = op.resolve?.find((x) => x.id === "backups");
      if (bk && data["backups"]) {
        const items = ((data["backups"]["items"] as Array<Record<string, unknown>>) ?? []);
        const field = bk.backup_location_field ?? "volumeId";
        const same = items.filter((b) => String(b[field]) === String(known["volumeId"] ?? params["volumeId"]));
        const other = items.filter((b) => String(b[field]) !== String(known["volumeId"] ?? params["volumeId"]));
        if (other.length) { rev = "recoverable"; recovery = `restore from independent backup ${String(other[0]!["id"])}`; backupText = ` ${other.length} backup(s) are stored elsewhere and would survive.`; }
        else if (same.length) { backupText = ` All ${same.length} backup(s) are stored ON the same volume and would be destroyed with it.`; }
        else backupText = " No backups were found.";
      } else if (bk) unv.push("backups could not be listed; assuming none survive");

      if (Object.keys(data).length) {
        out.push(f({
          effect: `${op.description}: ${name}${bytes ? ` (${gb(bytes)})` : ""}${envRes.level === "production" ? " in a PRODUCTION environment" : envRes.level === "unknown" ? " (environment could not be confirmed)" : ""}.${backupText}${rev === "irreversible" ? " Irreversible." : ""}`,
          severity: op.destructive ? (rev === "irreversible" && op.data_bearing ? "critical" : "high") : "low",
          reversibility: rev, recovery, blast: bytes ? { bytes } : undefined, env: envRes, unverified: unv.length ? unv : undefined, saferAlternative: op.safer,
        }, "synthesis of read-only lookups", `env=${envRes.level} (${envRes.evidence.length} signals); size=${bytes ?? "?"}; reversibility=${rev}`, 2, true));
      } else if (failed.length) out.push(f({ effect: `Could not resolve the target of ${op.id}.`, severity: "medium", reversibility: "unknown", unverified: failed, env: { level: "unknown", evidence: ["target not resolved"] } }, "resolver", failed.join("; "), 2, true));

      // --- token scope (introspect the credential the AGENT will use)
      if (cat.token_introspection) {
        const ti = cat.token_introspection;
        const t = agentTok ?? tok;
        try {
          const url = base.replace(/\/$/, "") + ti.get;
          const res = await ctx.http.get(url, hdr(t));
          if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
          const x = Object.fromEntries(Object.entries(ti.extract).map(([k, p]) => [k, get(res.body, p)]));
          const scopes = Array.isArray(x["scopes"]) ? (x["scopes"] as string[]) : [];
          const projects = Array.isArray(x["projects"]) ? (x["projects"] as string[]) : [];
          const broad = (ti.broad_if?.scope_type ?? []).includes(String(x["scope_type"])) || scopes.some((s) => (ti.broad_if?.scopes_include ?? []).includes(s));
          out.push(f({
            effect: broad
              ? `The credential ${agentTok ? "the agent will use" : "Dry Run holds"} ("${String(x["label"] ?? "unnamed")}") is broader than this task needs: ${String(x["scope_type"] ?? "unknown")}-level, scopes [${scopes.join(", ")}], projects [${projects.join(", ")}]. It can perform this deletion anywhere in the account, not only on ${name}.`
              : `Credential "${String(x["label"] ?? "unnamed")}" is scoped to ${scopes.join(", ") || "unspecified scopes"} on ${projects.join(", ") || "unspecified projects"}.`,
            severity: broad ? "high" : "info", reversibility: "reversible", env: envRes.level !== "unknown" ? envRes : undefined,
            saferAlternative: broad ? "Use a token scoped to a single project and, where supported, to read/deploy only (no delete) for routine agent work." : undefined,
            unverified: undefined,
          }, `GET ${redact(base.replace(/\/$/, "") + ti.get)}`, redact(JSON.stringify({ type: x["scope_type"], scopes, projects })), 2, true));
        } catch (e) { out.push(f({ effect: "Could not determine what the credential can do.", severity: "low", reversibility: "reversible", unverified: [`token scope not verified: ${(e as Error).message.slice(0, 80)}`] }, "token introspection", "failed", 2, true)); }
      } else out.push(f({ effect: `${cat.provider} offers no token-introspection endpoint in the catalog; the credential's scope is unknown.`, severity: "low", reversibility: "reversible", unverified: ["token scope not verified"] }, "catalog", "no token_introspection", 2));
      return out;
    },
  };
}
export type { CatalogOp };
