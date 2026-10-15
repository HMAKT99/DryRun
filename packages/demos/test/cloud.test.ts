import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { dryRun, defaultConfig, createReadOnlyHttp, makeReadOnlyContext } from "@dryrun/core";
import { createCloudSimulator, loadCatalogs } from "@dryrun/sim-cloud";
import { createTerraformSimulator } from "@dryrun/sim-terraform";
import { startAcme, type AcmeMock } from "../src/index.js";

let mock: AcmeMock;
beforeAll(async () => { mock = await startAcme(); });
afterAll(async () => { await mock.close(); });

const ENV = { DRYRUN_ACME_READONLY_TOKEN: "acme_ro_token_1a2b3c4d5e", AGENT_TOKEN: "acme_root_token_9f8e7d6c5b4a" };
const run = (operation: string, params: Record<string, unknown>, ctx: Record<string, unknown> = {}) =>
  dryRun({ type: "cloud_api", action: { provider: "acme", operation, params }, context: { base_url: mock.url, credential_ref: "AGENT_TOKEN", ...ctx } },
    [createCloudSimulator({ env: ENV })], { config: defaultConfig(), readOnly: makeReadOnlyContext(createReadOnlyHttp()) });

describe("catalogs", () => {
  it("every shipped catalog is valid and has unique operation ids", () => {
    const cats = loadCatalogs();
    expect(cats.map((c) => c.provider).sort()).toEqual(["acme", "aws", "railway", "vercel"]);
    for (const c of cats) for (const o of c.operations) { expect(o.description.length).toBeGreaterThan(5); if (o.destructive) expect(o.read_only).not.toBe(true); }
  });
});

describe("the nine-second deletion (mock provider)", () => {
  it("blocks the production volume delete with evidence, never writing", async () => {
    const r = await run("volumeDelete", { volumeId: "vol_pg_prod" });
    expect(r.verdict.value).toBe("block");
    expect(r.environment.level).toBe("production");
    expect(r.reversibility).toBe("irreversible");
    const text = r.effects.map((e) => e.text).join("\n");
    expect(text).toMatch(/pg-data \(40\.2 GB\) in a PRODUCTION environment/);
    expect(text).toMatch(/All 3 backup\(s\) are stored ON the same volume/);
    expect(text).toMatch(/broader than this task needs/);
    expect(r.blast_radius.bytes).toBe(40.2e9);
    expect(r.safer_alternatives.join(" ")).toMatch(/scoped to this one volume|Snapshot/);
    // evidence links + only GETs reached the provider, and the volume still exists
    expect(r.evidence.items.filter((e) => e.readonlyCall).length).toBeGreaterThan(3);
    expect(mock.requests.length).toBeGreaterThan(3);
    for (const q of mock.requests) expect(q.method).toBe("GET");
    expect(mock.volumes.has("vol_pg_prod")).toBe(true);
    expect(JSON.stringify(r)).not.toMatch(/acme_root_token|acme_ro_token/);
  });
  it("a dev scratch volume is not production, so it does not hard-block via R1", async () => {
    const r = await run("volumeDelete", { volumeId: "vol_scratch" });
    expect(r.environment.level).toBe("staging");
    expect(r.verdict.value).not.toBe("safe");
    for (const q of mock.requests) expect(q.method).toBe("GET");
  });
  it("read-only operations are safe", async () => {
    mock.requests.length = 0;
    const r = await run("volumeList", {});
    expect(r.verdict.value).toBe("safe");
  });
  it("unknown provider / operation => confirm, never safe", async () => {
    const a = await dryRun({ type: "cloud_api", action: { provider: "nope", operation: "x" } }, [createCloudSimulator()], { config: defaultConfig() });
    const b = await run("selfDestruct", {});
    expect(a.verdict.value).toBe("confirm"); expect(b.verdict.value).toBe("confirm");
  });
  it("missing credentials => tier 2 errors, verdict is never safe", async () => {
    const r = await dryRun({ type: "cloud_api", action: { provider: "acme", operation: "volumeDelete", params: { volumeId: "vol_pg_prod" } }, context: { base_url: mock.url } },
      [createCloudSimulator({ env: {} })], { config: defaultConfig(), readOnly: makeReadOnlyContext(createReadOnlyHttp()) });
    expect(r.evidence.tiers_run.find((t) => t.tier === 2)?.status).toBe("error");
    expect(r.verdict.value).not.toBe("safe");
  });
  it("matches raw REST calls by method+path", async () => {
    const r = await dryRun({ type: "cloud_api", action: { provider: "acme", method: "DELETE", path: "/v1/volumes/vol_pg_prod" }, context: { base_url: mock.url, credential_ref: "AGENT_TOKEN" } },
      [createCloudSimulator({ env: ENV })], { config: defaultConfig(), readOnly: makeReadOnlyContext(createReadOnlyHttp()) });
    expect(r.verdict.value).toBe("block");
  });
  it("AWS RDS: SkipFinalSnapshot decides reversibility; target is unverified so never safe", async () => {
    const aws = (p: Record<string, unknown>) => dryRun({ type: "cloud_api", action: { provider: "aws", operation: "rds:DeleteDBInstance", params: p } }, [createCloudSimulator()], { config: defaultConfig() });
    expect((await aws({ DBInstanceIdentifier: "x", SkipFinalSnapshot: true })).reversibility).toBe("irreversible");
    const kept = await aws({ DBInstanceIdentifier: "x", SkipFinalSnapshot: false });
    expect(kept.reversibility).toBe("recoverable");
    expect(kept.verdict.value).toBe("confirm");
  });
});

describe("terraform", () => {
  const plan = (rcs: unknown[]) => dryRun({ type: "terraform", action: { resource_changes: rcs } as never }, [createTerraformSimulator()], { config: defaultConfig() });
  it("destroying a production database with in-resource backups is blocked", async () => {
    const r = await plan([{ address: "aws_db_instance.main", type: "aws_db_instance", change: { actions: ["delete"], before: { identifier: "acme-prod-db", allocated_storage: 100, skip_final_snapshot: true, backup_retention_period: 7, tags: { Environment: "production" } }, after: null } }]);
    expect(r.verdict.value).toBe("block");
    expect(r.effects[0]!.text).toMatch(/DESTROYS database aws_db_instance\.main \(100\.0 GB provisioned\).*automated backups are stored in the same resource/);
  });
  it("replace is flagged; final snapshot makes it recoverable (but not safe)", async () => {
    const r = await plan([{ address: "aws_db_instance.x", type: "aws_db_instance", change: { actions: ["delete", "create"], before: { identifier: "x-staging", skip_final_snapshot: false, final_snapshot_identifier: "snap" }, after: {} } }]);
    expect(r.effects[0]!.text).toMatch(/REPLACES/);
    expect(r.reversibility).toBe("recoverable");
    expect(r.verdict.value).not.toBe("safe");
  });
  it("no-op plan is safe; creates-only and garbage are not", async () => {
    expect((await plan([{ address: "a", type: "aws_s3_bucket", change: { actions: ["no-op"] } }])).verdict.value).toBe("safe");
    expect((await plan([{ address: "a", type: "aws_s3_bucket", change: { actions: ["create"], before: null, after: {} } }])).verdict.value).toBe("confirm");
    const g = await dryRun({ type: "terraform", action: "not json at all" }, [createTerraformSimulator()], { config: defaultConfig() });
    expect(g.verdict.value).toBe("confirm");
  });
});

describe("path matching tolerates the API prefix in the base URL", () => {
  it("DELETE /volumes/<id> (no /v1) still matches", async () => {
    for (const path of ["/volumes/vol_pg_prod", "/v1/volumes/vol_pg_prod"]) {
      const r = await dryRun({ type: "cloud_api", action: { provider: "acme", method: "DELETE", path }, context: { base_url: mock.url, credential_ref: "AGENT_TOKEN" } },
        [createCloudSimulator({ env: ENV })], { config: defaultConfig(), readOnly: makeReadOnlyContext(createReadOnlyHttp()) });
      expect(r.verdict.value, path).toBe("block");
    }
  });
});
