import type { Action, Finding, ReadOnlyContext } from "@dryrun/core";
import { redact, registerSecret } from "@dryrun/core";

export const SIM = "saas";
export interface Req { service: string; operation: string; params: Record<string, unknown> }
export function normalize(a: Action): Req {
  const o = (typeof a.action === "object" ? a.action : {}) as Record<string, unknown>;
  return { service: String(o["service"] ?? a.context?.provider ?? "").toLowerCase(), operation: String(o["operation"] ?? ""), params: { ...(a.context?.params ?? {}), ...((o["params"] as Record<string, unknown>) ?? {}) } };
}
export const mk = (over: Partial<Finding> & Pick<Finding, "effect">, source: string, detail: string, tier: 1 | 2 = 1, readonlyCall = false): Finding => ({
  simulator: SIM, tier, severity: "info", reversibility: "reversible", evidenceIds: [],
  evidence: [{ tier, source, detail, readonlyCall }], ...over,
});

export interface Creds { base: string; headers: (t?: string) => Record<string, string>; ro?: string; agent?: string; tok: string; usedAgent: boolean; roRef: string }
export function creds(a: Action, service: string, env: NodeJS.ProcessEnv, defaults: { base: string; header?: (t: string) => Record<string, string> }): Creds {
  const S = service.toUpperCase();
  const base = (a.context?.base_url ?? env[`DRYRUN_${S}_BASE_URL`] ?? defaults.base).replace(/\/$/, "");
  const roRef = a.context?.readonly_token_ref ?? `DRYRUN_${S}_READONLY_TOKEN`;
  const ro = env[roRef]; const agent = a.context?.credential_ref ? env[a.context.credential_ref] : undefined;
  registerSecret(ro); registerSecret(agent);
  const tok = ro ?? agent;
  if (!tok) throw new Error(`no read-only credential (set ${roRef})`);
  const header = defaults.header ?? ((t: string) => ({ authorization: `Bearer ${t}` }));
  return { base, headers: (t) => header(t ?? tok), ro, agent, tok, usedAgent: !ro, roRef };
}
export function reuseNotice(c: Creds, svc: string): Finding[] {
  return c.usedAgent ? [mk({ effect: `No read-only ${svc} credential configured (${c.roRef}); the agent's own credential was used for GET-only lookups.`, severity: "low", saferAlternative: `Create a restricted read-only ${svc} key and set ${c.roRef}.`, unverified: ["read-only credential not configured"] }, "credential setup", "agent credential reused for GET only", 2)] : [];
}
export async function getJson(ctx: ReadOnlyContext, url: string, headers: Record<string, string>): Promise<{ status: number; body: any }> {
  if (!ctx.http) throw new Error("no read-only HTTP client available");
  const r = await ctx.http.get(url, headers);
  return { status: r.status, body: r.body as any };
}
export const evOf = (url: string) => `GET ${redact(url)}`;
export async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { for (;;) { const k = i++; if (k >= items.length) return; out[k] = await fn(items[k]!); } }));
  return out;
}
