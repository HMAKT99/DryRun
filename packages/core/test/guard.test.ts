import { describe, it, expect } from "vitest";
import { assertReadOnlySql, assertGraphqlQuery, createReadOnlyHttp, buildReport, ReportValidationError, defaultConfig } from "../src/index.js";

describe("never write to real systems", () => {
  it("allows plain reads", () => {
    for (const s of ["SELECT count(*) FROM orders WHERE id > 5", "EXPLAIN SELECT 1", "SHOW server_version", "WITH a AS (SELECT 1) SELECT * FROM a;"])
      expect(() => assertReadOnlySql(s)).not.toThrow();
  });
  it("rejects writes and side effects", () => {
    for (const s of [
      "DELETE FROM orders", "DROP TABLE x", "SELECT 1; DROP TABLE x", "EXPLAIN ANALYZE DELETE FROM x",
      "SELECT * INTO t2 FROM t", "SELECT * FROM t FOR UPDATE", "SELECT nextval('s')", "SELECT pg_terminate_backend(1)",
      "WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d", "COPY t TO '/tmp/x'", "SELECT dblink_exec('x','y')",
    ]) expect(() => assertReadOnlySql(s), s).toThrow();
  });
  it("graphql: queries only", () => {
    expect(() => assertGraphqlQuery("query { me { id } }")).not.toThrow();
    expect(() => assertGraphqlQuery("mutation { volumeDelete(id: 1) }")).toThrow();
    expect(() => assertGraphqlQuery("query { a } mutation { b }")).toThrow();
  });
  it("http client has no write verbs and sends only GET / GraphQL query POSTs", async () => {
    const calls: string[] = [];
    const http = createReadOnlyHttp((async (_u: any, init: any) => { calls.push(init.method); return new Response("{}"); }) as any);
    expect(Object.keys(http).sort()).toEqual(["get", "graphqlQuery"]);
    await http.get("http://x/a");
    await http.graphqlQuery("http://x/g", "query { a }");
    await expect(http.graphqlQuery("http://x/g", "mutation { a }")).rejects.toThrow();
    expect(calls).toEqual(["GET", "POST"]);
  });
});

describe("evidence is mandatory", () => {
  it("rejects findings without evidence", () => {
    expect(() => buildReport({
      action: { type: "sql", action: "x" },
      findings: [{ simulator: "t", tier: 1, effect: "e", severity: "low", reversibility: "reversible", evidenceIds: [] }],
      evidence: [], tierRuns: [], matchedSimulators: 1, config: defaultConfig(),
    })).toThrow(ReportValidationError);
  });
});
