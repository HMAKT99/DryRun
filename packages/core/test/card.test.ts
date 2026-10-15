import { describe, it, expect } from "vitest";
import { buildReport, defaultConfig, renderCardSvg, renderTerminal, wrap } from "../src/index.js";

const mkReport = (summary: string, effect: string) => buildReport({
  action: { type: "shell", action: summary },
  findings: [{ simulator: "t", tier: 1, effect, severity: "critical", reversibility: "irreversible", evidenceIds: ["e"], env: { level: "production", evidence: ["x"] }, blast: { bytes: 5e9, rows: 3, money: { amount: 1234.5, currency: "USD" }, people: 9 } }],
  evidence: [{ id: "e", tier: 1, source: "s", detail: "d" }], tierRuns: [], matchedSimulators: 1, config: defaultConfig(),
});

describe("report card and terminal rendering with hostile text", () => {
  it("escapes markup/script injection in the SVG", () => {
    const svg = renderCardSvg(mkReport(`</text><script>alert(1)</script>"&'`, `<img src=x onerror=alert(1)> ]]> </svg><svg onload=alert(2)>`));
    expect(svg).not.toMatch(/<script|<img|onload=alert\(2\)>(?!&)/);
    expect(svg).toContain("&lt;script&gt;");
    expect((svg.match(/<svg /g) ?? []).length).toBe(1);
  });
  it("handles very long, unicode, control-character and empty text", () => {
    for (const t of ["x".repeat(20_000), "🔥".repeat(300), "a\u0000b\u001bc‮", "", "   "]) {
      const r = mkReport(t, t || "empty");
      expect(() => renderCardSvg(r)).not.toThrow();
      expect(() => renderTerminal(r)).not.toThrow();
      expect(JSON.stringify(r)).not.toContain("\u0000");
      expect(r.action.summary.length).toBeLessThanOrEqual(501);
    }
  });
  it("wrap never exceeds the line budget", () => {
    expect(wrap("word ".repeat(500), 40, 3).length).toBeLessThanOrEqual(3);
    expect(wrap("", 40, 3)).toEqual([]);
    expect(wrap("a".repeat(500), 40, 2).every((l) => l.length <= 41)).toBe(true);
  });
});
