import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface AcmeMock {
  url: string;
  /** Every request received, so tests can prove Dry Run never wrote. */
  requests: Array<{ method: string; path: string; auth?: string }>;
  volumes: Map<string, Record<string, unknown>>;
  close(): Promise<void>;
}

/** A local stand-in for a cloud provider: production Postgres volume with same-volume backups. */
export async function startAcme(opts: { port?: number } = {}): Promise<AcmeMock> {
  const volumes = new Map<string, Record<string, unknown>>([
    ["vol_pg_prod", { id: "vol_pg_prod", name: "pg-data", sizeBytes: 40.2e9, project: "acme-api", service: "svc_postgres", tags: { env: "production" } }],
    ["vol_scratch", { id: "vol_scratch", name: "scratch-cache", sizeBytes: 2e6, project: "acme-sandbox", service: "svc_scratch", tags: { env: "dev" } }],
  ]);
  const requests: AcmeMock["requests"] = [];
  const json = (res: import("node:http").ServerResponse, code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0]!;
    requests.push({ method: req.method ?? "?", path, auth: req.headers.authorization ? "present" : undefined });
    const tok = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (!tok) return json(res, 401, { error: "unauthorized" });
    let m: RegExpExecArray | null;
    if (req.method === "DELETE" && (m = /^\/v1\/volumes\/([^/]+)$/.exec(path))) { volumes.delete(m[1]!); return json(res, 200, { deleted: m[1] }); } // the REAL destructive call
    if (req.method !== "GET") return json(res, 405, { error: "method not allowed in mock" });
    if (path === "/v1/token/self") {
      if (tok === "acme_root_token_9f8e7d6c5b4a") return json(res, 200, { label: "deploy-bot (found in .env.local)", type: "account", scopes: ["*"], projects: ["all"] });
      return json(res, 200, { label: "dryrun-readonly", type: "project", scopes: ["volumes:read", "services:read"], projects: ["acme-api"] });
    }
    if ((m = /^\/v1\/volumes\/([^/]+)$/.exec(path))) { const v = volumes.get(m[1]!); return v ? json(res, 200, v) : json(res, 404, { error: "not found" }); }
    if ((m = /^\/v1\/volumes\/([^/]+)\/backups$/.exec(path))) return json(res, 200, { items: [1, 2, 3].map((i) => ({ id: `bkp_${i}`, volumeId: m![1], createdAt: `2026-04-2${i}T03:00:00Z` })) });
    if ((m = /^\/v1\/services\/([^/]+)\/domains$/.exec(path))) return json(res, 200, { items: m[1] === "svc_postgres" ? ["db.acme.com", "api.acme.com"] : [] });
    if ((m = /^\/v1\/services\/([^/]+)\/metrics$/.exec(path))) return json(res, 200, { requestsPerMin: m[1] === "svc_postgres" ? 1240 : 0 });
    json(res, 404, { error: "no such route" });
  });
  await new Promise<void>((r) => server.listen(opts.port ?? 0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}/v1`, requests, volumes, close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections?.(); }) };
}
