import type { Config } from "./config.js";
import type { Finding, TierRun, Verdict, Reversibility, EnvLevel, BlastRadius } from "./types.js";

export interface PolicyInput {
  findings: Finding[];
  tierRuns: TierRun[];
  /** Number of simulators whose canHandle returned true. */
  matchedSimulators: number;
}

export interface Aggregate {
  reversibility: Reversibility;
  env: { level: EnvLevel; evidence: string[] };
  blast: BlastRadius;
  unverified: string[];
}

const REV_ORDER: Reversibility[] = ["reversible", "recoverable", "unknown", "irreversible"];

export function aggregate(findings: Finding[], hints: string[] = []): Aggregate {
  let rev: Reversibility = "reversible";
  let envLevel: EnvLevel = "unknown";
  let sawEnv = false;
  const envEv: string[] = [];
  const blast: BlastRadius = {};
  const unverified: string[] = [];
  for (const f of findings) {
    if (REV_ORDER.indexOf(f.reversibility) > REV_ORDER.indexOf(rev)) rev = f.reversibility;
    if (f.env) {
      // production > unknown > staging > local. Unknown dominates weaker claims: we must not
      // present a mixed picture as confirmed non-production.
      const rank = { production: 3, unknown: 2, staging: 1, local: 0 } as const;
      if (!sawEnv || rank[f.env.level] > rank[envLevel]) envLevel = f.env.level;
      sawEnv = true;
      envEv.push(...f.env.evidence);
    }
    for (const k of ["rows", "files", "bytes", "people"] as const) {
      const v = f.blast?.[k];
      if (v !== undefined) blast[k] = Math.max(blast[k] ?? 0, v);
    }
    if (f.blast?.money) {
      const cur = blast.money;
      if (!cur || f.blast.money.amount > cur.amount) blast.money = f.blast.money;
    }
    unverified.push(...(f.unverified ?? []));
  }
  void hints;
  return { reversibility: findings.length ? rev : "unknown", env: { level: envLevel, evidence: [...new Set(envEv)] }, blast, unverified: [...new Set(unverified)] };
}

/**
 * Verdict logic. Conservative by construction: `safe` is only reachable when every
 * condition holds; every other path returns confirm or block.
 */
export function decide(input: PolicyInput, cfg: Config): Verdict {
  const { findings, tierRuns, matchedSimulators } = input;
  const agg = aggregate(findings);
  const rules: string[] = [];
  const t = cfg.thresholds;

  const dataLoss = findings.some((f) => f.reversibility === "irreversible" && (f.severity === "high" || f.severity === "critical"));
  const overBlock =
    (agg.blast.rows ?? 0) >= t.blockRows ||
    (agg.blast.bytes ?? 0) >= t.blockBytes ||
    (agg.blast.people ?? 0) >= t.blockPeople ||
    (agg.blast.money?.amount ?? 0) >= t.blockMoney;

  const hard = findings.find((f) => f.hardBlock);
  if (hard) {
    return { value: "block", ruleIds: ["R0:hard-block"], reason: hard.hardBlock! };
  }
  const critical = findings.some((f) => f.reversibility === "irreversible" && f.severity === "critical");
  if (agg.reversibility === "irreversible" && agg.env.level === "production" && (critical || overBlock)) {
    rules.push("R1:irreversible-in-production");
    return { value: "block", ruleIds: rules, reason: `Irreversible ${critical ? "critical-severity " : ""}action against a production environment${overBlock ? " exceeding the blast-radius threshold" : ""}.` };
  }
  if (dataLoss && agg.env.level === "unknown" && cfg.blockUnknownEnvIrreversible && hasBlast(agg.blast)) {
    rules.push("R2:irreversible-unknown-env-with-data");
    return { value: "block", ruleIds: rules, reason: "Irreversible data loss and the environment could not be confirmed as non-production." };
  }
  if (agg.reversibility === "irreversible" && overBlock) {
    rules.push("R3:irreversible-over-threshold");
    return { value: "block", ruleIds: rules, reason: "Irreversible action exceeds the configured blast-radius threshold." };
  }

  // Everything below is at most `confirm` unless every safe condition holds.
  const reasons: string[] = [];
  if (matchedSimulators === 0) { rules.push("R4:no-simulator"); reasons.push("No simulator could analyze this action."); }
  if (findings.length === 0) { rules.push("R5:no-findings"); reasons.push("No findings were produced."); }
  if (tierRuns.some((r) => r.status === "error")) { rules.push("R6:tier-error"); reasons.push("A rehearsal tier failed."); }
  if (agg.unverified.length) { rules.push("R7:unverified"); reasons.push(`Could not verify: ${agg.unverified.join("; ")}.`); }
  if (!findings.some((f) => f.tier === 1 && f.benign === true)) { rules.push("R8:not-known-benign"); reasons.push("Action was not positively classified as benign."); }
  if (findings.some((f) => f.severity !== "info" && f.severity !== "low" && !f.benign)) {
    rules.push("R9:risky-effects"); reasons.push("Action has non-trivial effects.");
  }
  if (agg.reversibility !== "reversible") { rules.push("R10:not-reversible"); reasons.push(`Reversibility is ${agg.reversibility}.`); }
  if (
    ((agg.blast.rows ?? 0) >= t.confirmRows && !findings.every((f) => f.benign)) ||
    (agg.blast.files ?? 0) >= t.confirmFiles ||
    (agg.blast.money?.amount ?? 0) >= t.confirmMoney
  ) { rules.push("R11:blast-over-confirm"); reasons.push("Blast radius is over the confirm threshold."); }

  if (rules.length === 0) {
    return { value: "safe", ruleIds: ["S1:verified-benign"], reason: "Positively classified as benign; nothing unverified." };
  }
  return { value: "confirm", ruleIds: rules, reason: reasons.join(" ") };
}

function hasBlast(b: BlastRadius): boolean {
  return (b.rows ?? 0) > 0 || (b.bytes ?? 0) > 0 || (b.files ?? 0) > 0 || (b.people ?? 0) > 0 || !!b.money;
}
