import { describe, it, expect } from "vitest";
import { decide, defaultConfig, type Finding, type TierRun } from "../src/index.js";

const cfg = defaultConfig();
const ok: TierRun[] = [{ simulator: "t", tier: 1, status: "ok" }];
const base: Finding = { simulator: "t", tier: 1, effect: "x", severity: "info", reversibility: "reversible", evidenceIds: ["e"] };
const v = (findings: Finding[], runs = ok, matched = 1) => decide({ findings, tierRuns: runs, matchedSimulators: matched }, cfg).value;

describe("policy: safe is hard to reach", () => {
  it("safe only for positively benign, verified, reversible", () => {
    expect(v([{ ...base, benign: true }])).toBe("safe");
  });
  it("never safe with no simulator", () => expect(v([], ok, 0)).toBe("confirm"));
  it("never safe with no findings", () => expect(v([])).toBe("confirm"));
  it("never safe when not positively benign", () => expect(v([base])).toBe("confirm"));
  it("never safe with any unverified entry", () => expect(v([{ ...base, benign: true, unverified: ["env"] }])).toBe("confirm"));
  it("never safe after a tier error", () =>
    expect(v([{ ...base, benign: true }], [{ simulator: "t", tier: 2, status: "error" }])).toBe("confirm"));
  it("never safe when recoverable/unknown/irreversible", () => {
    for (const reversibility of ["recoverable", "unknown"] as const)
      expect(v([{ ...base, benign: true, reversibility }])).not.toBe("safe");
  });
  it("property: any single disqualifier prevents safe", () => {
    const disq: Array<Partial<Finding>> = [
      { unverified: ["a"] }, { reversibility: "unknown" }, { severity: "high", benign: false },
      { blast: { rows: 5 } , benign: false }, { blast: { money: { amount: 5, currency: "usd" } } },
    ];
    for (const d of disq) expect(v([{ ...base, benign: true, ...d }])).not.toBe("safe");
  });
});

describe("policy: block rules", () => {
  const del: Finding = { ...base, severity: "critical", reversibility: "irreversible", blast: { bytes: 40e9 } };
  it("blocks irreversible in production", () =>
    expect(v([{ ...del, env: { level: "production", evidence: ["name"] } }])).toBe("block"));
  it("blocks irreversible data loss in unknown env", () => expect(v([del])).toBe("block"));
  it("does not block irreversible in staging below threshold", () =>
    expect(v([{ ...del, blast: { rows: 3 }, env: { level: "staging", evidence: ["tag"] } }])).toBe("confirm"));
  it("blocks over threshold even in staging", () =>
    expect(v([{ ...del, blast: { rows: 5000 }, env: { level: "staging", evidence: ["tag"] } }])).toBe("block"));
});
