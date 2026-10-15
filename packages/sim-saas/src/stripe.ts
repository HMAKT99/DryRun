import type { Action, Finding, ReadOnlyContext } from "@dryrun/core";
import { creds, evOf, getJson, mk, pool, reuseNotice, type Req } from "./common.js";

const ZERO_DEC = new Set(["jpy", "krw", "vnd", "clp", "pyg", "ugx", "xaf", "xof", "bif", "djf", "gnf", "kmf", "rwf", "vuv", "xpf"]);
const major = (amt: number, cur: string) => (ZERO_DEC.has(cur.toLowerCase()) ? amt : amt / 100);
export const MAX_LOOKUPS = 3000;

export function keyMode(key?: string): "live" | "test" | "unknown" {
  if (!key) return "unknown";
  if (/^(sk|rk)_live_/.test(key)) return "live";
  if (/^(sk|rk)_test_/.test(key)) return "test";
  return "unknown";
}

export function stripeTier1(r: Req, a: Action, env: NodeJS.ProcessEnv): Finding[] {
  const mode = keyMode(a.context?.credential_ref ? env[a.context.credential_ref] : undefined);
  const envInfo = mode === "live" ? { level: "production" as const, evidence: ["the credential in use is a LIVE-mode key"] } : mode === "test" ? { level: "staging" as const, evidence: ["the credential in use is a TEST-mode key"] } : { level: "unknown" as const, evidence: ["key mode (live/test) not determined: no agent credential supplied"] };
  const op = r.operation;
  const n = Array.isArray(r.params["charges"]) ? (r.params["charges"] as unknown[]).length : r.params["charge"] ? 1 : 0;
  if (/^refund/i.test(op)) return [mk({ effect: `Refunds ${n || "an unknown number of"} charge(s) on Stripe. Refunds cannot be undone.`, severity: n > 1 ? "high" : "medium", reversibility: "irreversible", env: envInfo, unverified: ["pending: amounts and customers not yet looked up"], saferAlternative: "Refund a small batch first, or run with a test-mode key." }, "operation classification", `stripe ${op} (${mode} key)`)];
  if (/^subscription.*(cancel|delete)/i.test(op) || /cancel/i.test(op)) return [mk({ effect: "Cancels a Stripe subscription; canceled subscriptions cannot be reactivated (a new one must be created).", severity: "high", reversibility: "irreversible", env: envInfo, unverified: ["pending: subscription not yet looked up"] }, "operation classification", `stripe ${op}`)];
  if (/^customer.*delete|^delete.*customer/i.test(op)) return [mk({ effect: "Deletes a Stripe customer, permanently removing their saved payment methods and cancelling subscriptions.", severity: "critical", reversibility: "irreversible", env: envInfo, unverified: ["pending: customer not yet looked up"] }, "operation classification", `stripe ${op}`)];
  if (/^(list|retrieve|get)/i.test(op)) return [mk({ effect: "Read-only Stripe call.", benign: true }, "operation classification", `stripe ${op}`)];
  return [mk({ effect: `Stripe operation "${op}" is not in the classification table.`, severity: "medium", reversibility: "unknown", env: envInfo, unverified: [`stripe operation ${op} not classified`] }, "operation classification", op)];
}

export async function stripeTier2(r: Req, a: Action, ctx: ReadOnlyContext, env: NodeJS.ProcessEnv): Promise<Finding[]> {
  const c = creds(a, "stripe", env, { base: "https://api.stripe.com/v1" });
  const out: Finding[] = [...reuseNotice(c, "Stripe")];
  const op = r.operation;
  if (/^refund/i.test(op)) {
    const ids = (Array.isArray(r.params["charges"]) ? (r.params["charges"] as string[]) : r.params["charge"] ? [String(r.params["charge"])] : []).map(String);
    if (!ids.length) return [...out, mk({ effect: "No charge ids supplied; refund scope cannot be determined.", severity: "medium", reversibility: "irreversible", unverified: ["refund targets unknown"] }, "input", "charges missing", 2)];
    const sample = ids.slice(0, MAX_LOOKUPS);
    const results = await pool(sample, 16, async (id) => { try { const x = await getJson(ctx, `${c.base}/charges/${encodeURIComponent(id)}`, c.headers()); return x.status === 200 ? x.body : { error: x.status }; } catch (e) { return { error: (e as Error).message }; } });
    const ok = results.filter((x: any) => x && !x.error);
    const missing = results.length - ok.length;
    const byCur: Record<string, number> = {}; const customers = new Set<string>(); let live = 0, test = 0, already = 0, uncaptured = 0;
    for (const ch of ok as any[]) {
      const left = (ch.amount_captured ?? ch.amount ?? 0) - (ch.amount_refunded ?? 0);
      if (ch.refunded || left <= 0) { already++; continue; }
      if (ch.captured === false) { uncaptured++; continue; }
      byCur[String(ch.currency)] = (byCur[String(ch.currency)] ?? 0) + left;
      if (ch.customer) customers.add(String(ch.customer));
      ch.livemode ? live++ : test++;
    }
    const cur = Object.keys(byCur).sort((x, y) => byCur[y]! - byCur[x]!)[0] ?? "usd";
    const exact = major(byCur[cur] ?? 0, cur);
    const extrap = ids.length > sample.length && ok.length ? (exact / Math.max(1, ok.length - already - uncaptured)) * (ids.length - missing) : 0;
    const total = exact + extrap;
    const mode = live && !test ? "live" : test && !live ? "test" : live ? "mixed" : "unknown";
    const unv: string[] = [];
    if (missing) unv.push(`${missing} charge id(s) could not be looked up`);
    if (ids.length > sample.length) unv.push(`only ${sample.length} of ${ids.length} charges were looked up; the total is extrapolated`);
    if (Object.keys(byCur).length > 1) unv.push(`multiple currencies (${Object.keys(byCur).join(", ")}); total shown is for ${cur.toUpperCase()} only`);
    out.push(mk({
      effect: `Would refund ${ok.length - already - uncaptured} charge(s)${ids.length > sample.length ? ` (of ${ids.length}, extrapolated)` : ""}: ${cur.toUpperCase()} ${total.toLocaleString("en-US", { maximumFractionDigits: 2 })} total to ${customers.size} customer(s)${ids.length > sample.length ? " (estimate)" : ""}. Charges are ${mode.toUpperCase()}-mode. ${already ? `${already} already refunded (skipped). ` : ""}Irreversible.`,
      severity: "critical", reversibility: "irreversible",
      blast: { money: { amount: Math.round(total * 100) / 100, currency: cur.toUpperCase() }, people: customers.size },
      env: mode === "live" || mode === "mixed" ? { level: "production", evidence: [`${live} of ${ok.length} looked-up charges have livemode=true`] } : mode === "test" ? { level: "staging", evidence: ["all looked-up charges are test-mode"] } : { level: "unknown", evidence: ["charge mode not determined"] },
      unverified: unv.length ? unv : undefined,
      saferAlternative: "Refund a handful of charges first and confirm the outcome; or run the script with a test-mode key. Refunds are final.",
    }, `${evOf(c.base + "/charges/{id}")} × ${results.length}`, `looked up ${ok.length}/${ids.length}; live=${live} test=${test}; total=${cur} ${total}`, 2, true));
    return out;
  }
  if (/cancel|customer.*delete|delete.*customer/i.test(op)) {
    const id = String(r.params["subscription"] ?? r.params["customer"] ?? r.params["id"] ?? "");
    const path = /cancel/i.test(op) ? `/subscriptions/${encodeURIComponent(id)}` : `/customers/${encodeURIComponent(id)}`;
    const x = await getJson(ctx, c.base + path, c.headers());
    if (x.status !== 200) return [...out, mk({ effect: `Could not look up ${path}.`, severity: "medium", reversibility: "irreversible", unverified: [`lookup failed: HTTP ${x.status}`] }, evOf(c.base + path), `HTTP ${x.status}`, 2, true)];
    const live = x.body?.livemode === true;
    const amt = x.body?.items?.data?.reduce?.((s: number, i: any) => s + (i.price?.unit_amount ?? 0) * (i.quantity ?? 1), 0) ?? 0;
    out.push(mk({ effect: `${/cancel/i.test(op) ? "Cancels subscription" : "Deletes customer"} ${id} (${live ? "LIVE" : "test"} mode${amt ? `, recurring ${major(amt, x.body.currency ?? "usd")} ${String(x.body.currency ?? "usd").toUpperCase()}/period` : ""}). Irreversible.`, severity: "high", reversibility: "irreversible", blast: { people: 1, money: amt ? { amount: major(amt, x.body.currency ?? "usd"), currency: String(x.body.currency ?? "usd").toUpperCase() } : undefined }, env: live ? { level: "production", evidence: ["livemode=true"] } : { level: "staging", evidence: ["livemode=false"] } }, evOf(c.base + path), `livemode=${live}`, 2, true));
  }
  return out;
}
