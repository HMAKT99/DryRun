import { describe, it, expect, beforeEach } from "vitest";
import { redact, redactDeep, registerSecret, clearSecrets, buildReport, defaultConfig, renderTerminal } from "../src/index.js";

const SECRETS = [
  "postgres://admin:s3cr3tPassw0rd@db.prod.example.com:5432/app",
  "sk_live_51HabcdefGHIJKLmnop",
  "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
  "xoxb-1234567890-abcdefghij",
  "AKIAIOSFODNN7EXAMPLE",
  "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig",
  "password=hunter2hunter2",
  "-----BEGIN RSA PRIVATE KEY-----\nMIIEabc\n-----END RSA PRIVATE KEY-----",
];
const LEAK = ["s3cr3tPassw0rd", "51HabcdefGHIJKLmnop", "abcdefghijklmnopqrstuvwxyz0123456789", "1234567890-abcdefghij", "IOSFODNN7EXAMPLE", "eyJhbGciOiJIUzI1NiJ9", "hunter2hunter2", "MIIEabc"];

describe("redaction", () => {
  beforeEach(clearSecrets);
  it("masks known token formats", () => {
    const out = redact(SECRETS.join("\n"));
    for (const l of LEAK) expect(out).not.toContain(l);
  });
  it("masks registered exact secrets anywhere", () => {
    registerSecret("my-weird-opaque-value");
    expect(redact("x my-weird-opaque-value y")).not.toContain("my-weird-opaque-value");
  });
  it("deep-redacts objects including keys", () => {
    const o = redactDeep({ a: [SECRETS[0]], "sk_live_51HabcdefGHIJKLmnop": 1 });
    expect(JSON.stringify(o)).not.toContain("s3cr3tPassw0rd");
    expect(JSON.stringify(o)).not.toContain("51HabcdefGHIJKLmnop");
  });
  it("secrets in the action, effects and evidence never reach JSON or terminal output", () => {
    const rep = buildReport({
      action: { type: "shell", action: `curl -H "Authorization: Bearer abcdef1234567890" ${SECRETS[0]}` },
      findings: [{ simulator: "t", tier: 1, effect: `uses ${SECRETS[1]}`, severity: "high", reversibility: "unknown", evidenceIds: ["e1"] }],
      evidence: [{ id: "e1", tier: 1, source: "parser", detail: SECRETS[2] }],
      tierRuns: [], matchedSimulators: 1, config: defaultConfig(),
    });
    const all = JSON.stringify(rep) + renderTerminal(rep);
    for (const l of [...LEAK, "abcdef1234567890"]) expect(all).not.toContain(l);
  });
});
