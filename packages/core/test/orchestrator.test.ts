import { describe, it, expect } from "vitest";
import { dryRun, defaultConfig, renderTerminal, type Simulator } from "../src/index.js";

const sim = (over: Partial<Simulator> = {}): Simulator => ({
  id: "fake", canHandle: () => true, analyze: async () => [], ...over,
});
const evidence = () => [{ id: "e1", tier: 1 as const, source: "parser", detail: "d" }];
const act = { type: "shell" as const, action: "ls" };

describe("orchestrator", () => {
  it("no matching simulator => confirm", async () => {
    const r = await dryRun(act, [sim({ canHandle: () => false })], { config: defaultConfig() });
    expect(r.verdict.value).toBe("confirm");
  });
  it("a throwing simulator never yields safe", async () => {
    const r = await dryRun(act, [sim({ analyze: async () => { throw new Error("boom"); } })], { config: defaultConfig() });
    expect(r.verdict.value).toBe("confirm");
    expect(r.evidence.tiers_run[0]?.status).toBe("error");
  });
  it("benign tier-1 finding with skipped tier 2 can be safe, and skipped tiers are reported", async () => {
    const s = sim({
      analyze: async () => [{ simulator: "fake", tier: 1, effect: "lists files", severity: "info", reversibility: "reversible", benign: true, evidenceIds: ["e1"] }],
      inspect: async () => [],
    });
    const r = await dryRun(act, [s], { config: defaultConfig(), evidence: evidence() });
    expect(r.verdict.value).toBe("safe");
    expect(r.evidence.tiers_run.some((t) => t.tier === 2 && t.status === "skipped")).toBe(true);
    expect(renderTerminal(r)).toContain("SAFE");
  });
});
