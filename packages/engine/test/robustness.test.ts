import { describe, it, expect } from "vitest";
import { createEngine } from "../src/index.js";

const engine = createEngine({ persist: false, env: {}, sandbox: null, timeoutMs: 30_000 });
const types = ["sql", "shell", "terraform", "cloud_api", "saas"] as const;

// Deterministic PRNG so failures are reproducible.
let seed = Number(process.env.FUZZ_SEED ?? 12345); const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)]!;
const junk = (d = 0): unknown => {
  const k = Math.floor(rnd() * (d > 2 ? 6 : 9));
  switch (k) {
    case 0: return null; case 1: return Math.floor(rnd() * 1e6) - 5e5; case 2: return rnd() > 0.5;
    case 3: return pick(["", " ", "rm -rf /", "DELETE FROM t", "../../etc/passwd", "\u0000\u001b[31m", "a".repeat(5000), "{{}}", "$(id)", "🔥", "__proto__", "constructor"]);
    case 4: return rnd() > 0.5 ? pick([[], [1, 2], ["a"], [null]]) : Array.from({ length: 1 + Math.floor(rnd() * 20) }, () => junk(d + 1));
    case 5: return {};
    default: { const o: Record<string, unknown> = {}; for (let i = 0; i < 1 + Math.floor(rnd() * 5); i++) o[pick(["provider", "service", "operation", "method", "path", "params", "resource_changes", "tags", "channel", "to", "charges", "__proto__", "constructor", "x"])] = junk(d + 1); return o; }
  }
};

describe("engine robustness", () => {
  it("1,000 random hostile actions: never throws, always a valid report, never 'safe' for junk", async () => {
    for (let i = 0; i < Number(process.env.FUZZ_N ?? 1000); i++) {
      const type = pick([...types]);
      const a = { type, action: junk() as never, context: rnd() > 0.5 ? (junk() as never) : undefined };
      const r = await engine.run(a);
      expect(["safe", "confirm", "block"]).toContain(r.verdict.value);
      expect(r.schema_version).toBe("0.1");
      expect(Array.isArray(r.evidence.items)).toBe(true);
      if (r.verdict.value === "safe") {
        // Legitimate `safe` for random input: trivially benign shell/SQL, or a Terraform plan that changes nothing.
        const ok = a.type === "terraform"
          ? Array.isArray((a.action as { resource_changes?: unknown[] })?.resource_changes) && (a.action as { resource_changes: Array<{ change?: { actions?: string[] } }> }).resource_changes.every((c) => c?.change?.actions?.every((x) => x === "no-op"))
          : /^(ls|pwd|echo[^|;&$`<>]*|SELECT 1)$/.test(String(a.action));
        expect(ok, JSON.stringify(a)).toBe(true);
      }
    }
  }, 300_000);
  it("invalid envelope shapes yield a report, not an exception", async () => {
    for (const bad of [null, undefined, 5, "x", [], { type: "nope", action: "x" }, { type: "shell" }, { action: "ls" }]) {
      const r = await engine.run(bad as never);
      expect(r.verdict.value).not.toBe("safe");
    }
  });
  it("huge inputs are bounded in the report", async () => {
    const big = "A".repeat(5_000_000);
    const r = await engine.run({ type: "shell", action: `echo ${big}` });
    expect(JSON.stringify(r).length).toBeLessThan(100_000);
    const r2 = await engine.run({ type: "terraform", action: { resource_changes: Array.from({ length: 20_000 }, (_, i) => ({ address: `a.${i}`, type: "aws_db_instance", change: { actions: ["delete"], before: { identifier: `prod-${i}`, allocated_storage: 10 } } })) } as never });
    expect(r2.verdict.value).toBe("block");
  }, 120_000);
  it("prototype pollution attempts do not affect later runs", async () => {
    await engine.run({ type: "cloud_api", action: JSON.parse('{"provider":"acme","operation":"volumeList","params":{"__proto__":{"polluted":true}},"__proto__":{"polluted":true}}') });
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });
});
