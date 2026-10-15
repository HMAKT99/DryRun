import { loadConfig, type Config } from "./config.js";
import { buildReport } from "./report.js";
import type { Action, ConsequenceReport, Evidence, Finding, ReadOnlyContext, Sandbox, Simulator, TierRun } from "./types.js";

export interface RunOptions {
  config?: Config;
  readOnly?: ReadOnlyContext;
  sandbox?: Sandbox;
  /** Optional collector for evidence emitted by simulators. */
  evidence?: Evidence[];
}

/** Evidence ids are namespaced by simulator; simulators may add items via `opts.evidence`. */
export async function dryRun(action: Action, simulators: Simulator[], opts: RunOptions = {}): Promise<ConsequenceReport> {
  const config = opts.config ?? loadConfig();
  const matched = simulators.filter((s) => s.canHandle(action));
  const findings: Finding[] = [];
  const tierRuns: TierRun[] = [];
  const evidence = opts.evidence ?? [];

  for (const sim of matched) {
    let n = 0;
    const link = (tier: 1 | 2 | 3, fs: Finding[]): Finding[] =>
      fs.map((f) => {
        const ids = [...f.evidenceIds];
        for (const e of f.evidence ?? []) {
          const id = `${sim.id}-t${tier}-${++n}`;
          evidence.push({ ...e, id });
          ids.push(id);
        }
        return { ...f, tier: f.tier, evidenceIds: ids };
      });
    const run = async (tier: 1 | 2 | 3, fn: (() => Promise<Finding[]>) | undefined, skipNote?: string) => {
      if (!fn) { tierRuns.push({ simulator: sim.id, tier, status: "skipped", note: skipNote ?? "not implemented" }); return; }
      try { findings.push(...link(tier, await fn())); tierRuns.push({ simulator: sim.id, tier, status: "ok" }); }
      catch (e) { tierRuns.push({ simulator: sim.id, tier, status: "error", note: e instanceof Error ? e.message : String(e) }); }
    };
    await run(1, () => sim.analyze(action));
    await run(2, sim.inspect && opts.readOnly ? () => sim.inspect!(action, opts.readOnly!) : undefined,
      sim.inspect ? "no read-only credentials configured" : undefined);
    await run(3, sim.rehearse && opts.sandbox?.available ? () => sim.rehearse!(action, opts.sandbox!) : undefined,
      sim.rehearse ? "sandbox (Docker) unavailable" : undefined);
  }
  // A simulator throwing at Tier 1 must never yield a report that looks verified.
  return buildReport({ action, findings, evidence, tierRuns, matchedSimulators: matched.length, config });
}
