import { describe, it, expect, afterAll } from "vitest";
import { dryRun, defaultConfig, createReadOnlyHttp, makeReadOnlyContext, type Action } from "@dryrun/core";
import { createSaasSimulator } from "@dryrun/sim-saas";
import { startStripe, startSlack, startGithub } from "../src/index.js";

const ENV = { DRYRUN_STRIPE_READONLY_TOKEN: "rk_live_readonly0000AAAA", AGENT_STRIPE: "sk_live_agent0000BBBBCCCC", DRYRUN_SLACK_READONLY_TOKEN: "xoxb-readonly-00000000", DRYRUN_GITHUB_READONLY_TOKEN: "ghp_readonly000000000000000000000000" };
const run = (a: Action, o: { withHttp?: boolean } = {}) => dryRun(a, [createSaasSimulator({ env: ENV })], { config: defaultConfig(), readOnly: makeReadOnlyContext(createReadOnlyHttp()) });
const closers: Array<() => Promise<void>> = [];
afterAll(async () => { for (const c of closers) await c(); });

describe("stripe: refund storm", () => {
  it("totals the money, counts customers, sees live mode, blocks, never refunds", async () => {
    const m = await startStripe(2000); closers.push(m.close);
    const r = await run({ type: "saas", action: { service: "stripe", operation: "refund", params: { charges: m.charges } }, context: { base_url: m.url, credential_ref: "AGENT_STRIPE" } });
    expect(r.verdict.value).toBe("block");
    expect(r.environment.level).toBe("production");
    expect(r.blast_radius.money?.currency).toBe("USD");
    const expected = m.charges.reduce((s, id) => { const i = Number(id.slice(3)); return s + 2500 + (i % 40) * 50; }, 0) / 100;
    expect(r.blast_radius.money?.amount).toBe(expected);
    expect(r.blast_radius.people).toBe(800);
    expect(r.effects.map((e) => e.text).join(" ")).toMatch(/Would refund 2000 charge\(s\).*LIVE-mode/);
    expect(m.refunds.length).toBe(0);
    for (const q of m.requests) expect(q.method).toBe("GET");
    expect(JSON.stringify(r)).not.toMatch(/sk_live_agent|rk_live_readonly/);
  }, 60_000);
  it("test-mode charges are not production", async () => {
    const m = await startStripe(20); closers.push(m.close);
    const r = await run({ type: "saas", action: { service: "stripe", operation: "refund", params: { charges: ["ch_00001"] } }, context: { base_url: m.url, credential_ref: "NOPE" } });
    expect(r.verdict.value).not.toBe("safe");
  }, 30_000);
  it("reads are safe; unknown services/ops never safe", async () => {
    expect((await dryRun({ type: "saas", action: { service: "stripe", operation: "listCharges" } }, [createSaasSimulator({ env: ENV })], { config: defaultConfig() })).verdict.value).toBe("safe");
    for (const a of [{ service: "nope", operation: "x" }, { service: "stripe", operation: "zap" }])
      expect((await dryRun({ type: "saas", action: a }, [createSaasSimulator({ env: ENV })], { config: defaultConfig() })).verdict.value).toBe("confirm");
  });
  it("without credentials tier 2 errors and verdict is not safe", async () => {
    const r = await dryRun({ type: "saas", action: { service: "stripe", operation: "refund", params: { charges: ["ch_1"] } }, context: { base_url: "http://127.0.0.1:1" } }, [createSaasSimulator({ env: {} })], { config: defaultConfig(), readOnly: makeReadOnlyContext(createReadOnlyHttp()) });
    expect(r.evidence.tiers_run.find((t) => t.tier === 2)?.status).toBe("error");
    expect(r.verdict.value).not.toBe("safe");
  });
});

describe("email", () => {
  const send = (params: Record<string, unknown>) => dryRun({ type: "saas", action: { service: "email", operation: "send", params } }, [createSaasSimulator({ env: ENV })], { config: defaultConfig() });
  it("a bulk external send is blocked and previewed with secrets redacted", async () => {
    const to = Array.from({ length: 120 }, (_, i) => `u${i}@client${i % 9}.com`);
    const r = await send({ to, subject: "Update", body: "Hi. token=abcd1234efgh5678", internal_domains: ["acme.com"] });
    expect(r.verdict.value).toBe("block");
    expect(r.blast_radius.people).toBe(120);
    expect(JSON.stringify(r)).not.toContain("abcd1234efgh5678");
    expect(JSON.stringify(r)).toContain("Subject: Update");
  });
  it("sent email is never safe (cannot be recalled); small sends are confirm, not block", async () => {
    expect((await send({ to: ["a@other.com"], internal_domains: ["acme.com"] })).verdict.value).toBe("confirm");
    expect((await send({ to: ["a@acme.com"], internal_domains: ["acme.com"], subject: "hi", body: "x" })).verdict.value).toBe("confirm");
    expect((await send({ to: ["a@acme.com"], subject: "hi" })).verdict.value).toBe("confirm");
    expect((await send({ to: ["a@acme.com"], internal_domains: ["acme.com"], attachments: ["x.pdf"] })).verdict.value).not.toBe("safe");
    expect((await send({ list: "all-customers" })).verdict.value).not.toBe("safe");
  });
});

describe("slack", () => {
  it("@channel in a 3,200-member channel is blocked; external-shared channel needs confirm; nothing is posted", async () => {
    const m = await startSlack(); closers.push(m.close);
    const post = (channel: string, text: string) => run({ type: "saas", action: { service: "slack", operation: "chat.postMessage", params: { channel, text } }, context: { base_url: m.url } });
    const a = await post("C_ALL", "<!channel> deploy is down");
    expect(a.verdict.value).toBe("block");
    expect(a.blast_radius.people).toBe(3200);
    const b = await post("C_PARTNER", "hello");
    expect(b.verdict.value).toBe("confirm");
    expect(b.effects.map((e) => e.text).join(" ")).toMatch(/SHARED WITH EXTERNAL/);
    const c = await post("C_NOPE", "x");
    expect(c.verdict.value).toBe("confirm");
    expect(m.posted).toEqual([]);
    for (const q of m.requests) expect(q.method).toBe("GET");
  }, 30_000);
});

describe("github", () => {
  it("repo delete, visibility flip and branch delete are assessed read-only", async () => {
    const m = await startGithub(); closers.push(m.close);
    const go = (operation: string, params: Record<string, unknown>) => run({ type: "saas", action: { service: "github", operation, params }, context: { base_url: m.url } });
    const del = await go("repo.delete", { owner: "acme", repo: "core" });
    expect(del.effects.map((e) => e.text).join(" ")).toMatch(/1840 stars, 212 forks, 17 open PR\(s\)/);
    expect(del.verdict.value).toBe("confirm");
    const pub = await go("repo.updateVisibility", { owner: "acme", repo: "notes", private: false });
    expect(pub.verdict.value).toBe("block");
    expect(pub.reversibility).toBe("irreversible");
    const br = await go("branch.delete", { owner: "acme", repo: "core", branch: "main" });
    expect(br.effects.map((e) => e.text).join(" ")).toMatch(/DEFAULT branch/);
    expect(br.environment.level).toBe("production");
    expect(m.mutations).toEqual([]);
    for (const q of m.requests) expect(q.method).toBe("GET");
  }, 30_000);
});
