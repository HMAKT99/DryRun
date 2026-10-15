import type { Action, Finding } from "@dryrun/core";
import { redact } from "@dryrun/core";
import { mk, type Req } from "./common.js";

const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === "string" && v ? v.split(/[,;]\s*/) : []);
const domainOf = (e: string) => (/<?([^<>\s]+)@([^<>\s]+)>?/.exec(e)?.[2] ?? "").toLowerCase().replace(/>$/, "");

/** Email is pure Tier 1 + local preview: no provider is contacted. */
export function emailAnalyze(r: Req, a: Action, confirmAt = 50): Finding[] {
  const to = list(r.params["to"]), cc = list(r.params["cc"]), bcc = list(r.params["bcc"]);
  const all = [...to, ...cc, ...bcc];
  const unique = [...new Set(all.map((e) => e.toLowerCase()))];
  const internal = new Set(list(r.params["internal_domains"] ?? a.context?.params?.["internal_domains"]).map((d) => d.toLowerCase()));
  const ext = unique.filter((e) => !internal.has(domainOf(e)));
  const domains = [...new Set(ext.map(domainOf))];
  const unv: string[] = [];
  if (!internal.size) unv.push("no internal_domains supplied, so every recipient is treated as external");
  if (r.params["list"] || r.params["audience"]) unv.push("recipient list is referenced by name; its size was not resolved");
  const attachments = list(r.params["attachments"]);
  const subject = String(r.params["subject"] ?? ""), body = String(r.params["body"] ?? r.params["text"] ?? "");
  const preview = redact(`Subject: ${subject}\n\n${body}`).slice(0, 400);
  const bulk = unique.length >= confirmAt;
  const sev = bulk && ext.length >= confirmAt ? "high" : ext.length ? "medium" : "low";
  const effect = `Sends email to ${unique.length} recipient(s) (${to.length} to, ${cc.length} cc, ${bcc.length} bcc): ${ext.length} external${domains.length ? ` across ${domains.length} domain(s) [${domains.slice(0, 5).join(", ")}${domains.length > 5 ? ", …" : ""}]` : ""}${attachments.length ? `; ${attachments.length} attachment(s)` : ""}. Sent email cannot be recalled.`;
  // Sent email cannot be recalled, so an email is never `safe`: at best the human confirms.
  const benign = false;
  return [mk({
    effect, severity: benign ? "info" : sev, reversibility: "irreversible", benign,
    blast: { people: unique.length }, env: ext.length ? { level: "unknown", evidence: [`${ext.length} external recipient(s): real people outside the organization receive this`] } : internal.size ? { level: "staging", evidence: ["all recipients are on internal domains"] } : undefined,
    unverified: unv.length ? unv : undefined,
    saferAlternative: ext.length ? "Send to yourself first, put recipients in bcc, and stage the send in batches; confirm the list and content with the human." : undefined,
  }, "recipient analysis + local preview (no provider contacted)", preview)];
}
