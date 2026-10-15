import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface Mock { url: string; requests: Array<{ method: string; path: string }>; close(): Promise<void>; state: Record<string, unknown> }

async function serve(handler: (req: IncomingMessage, res: ServerResponse, path: string, q: URLSearchParams) => void, requests: Mock["requests"]): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    requests.push({ method: req.method ?? "?", path: u.pathname });
    if (!req.headers.authorization) { res.writeHead(401, { "content-type": "application/json" }); return void res.end('{"error":"unauthorized"}'); }
    handler(req, res, u.pathname, u.searchParams);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections?.(); }) };
}
const json = (res: ServerResponse, code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };

/** Mock Stripe: 2,000 live-mode charges across ~800 customers; POST /v1/refunds is the REAL destructive call. */
export async function startStripe(count = 2000): Promise<Mock & { refunds: string[]; charges: string[] }> {
  const requests: Mock["requests"] = []; const refunds: string[] = [];
  const charges = Array.from({ length: count }, (_, i) => `ch_${String(i + 1).padStart(5, "0")}`);
  const charge = (id: string) => { const i = Number(id.slice(3)); return { id, object: "charge", amount: 2500 + (i % 40) * 50, amount_captured: 2500 + (i % 40) * 50, amount_refunded: 0, captured: true, refunded: false, currency: "usd", customer: `cus_${(i % 800) + 1}`, livemode: true }; };
  const s = await serve((req, res, path) => {
    let m: RegExpExecArray | null;
    if (req.method === "POST" && path === "/v1/refunds") { refunds.push("refund"); return json(res, 200, { id: "re_1", status: "succeeded" }); }
    if (req.method === "GET" && (m = /^\/v1\/charges\/(ch_\d+)$/.exec(path))) { const i = Number(m[1]!.slice(3)); return i >= 1 && i <= count ? json(res, 200, charge(m[1]!)) : json(res, 404, { error: "no such charge" }); }
    if (req.method === "GET" && (m = /^\/v1\/subscriptions\/(sub_\w+)$/.exec(path))) return json(res, 200, { id: m[1], livemode: true, currency: "usd", items: { data: [{ price: { unit_amount: 4900 }, quantity: 20 }] } });
    json(res, 404, { error: "not found" });
  }, requests);
  return { url: s.url + "/v1", requests, close: s.close, refunds, charges, state: {} };
}

export async function startSlack(): Promise<Mock & { posted: string[] }> {
  const requests: Mock["requests"] = []; const posted: string[] = [];
  const s = await serve((req, res, path, q) => {
    if (req.method === "POST") { posted.push(path); return json(res, 200, { ok: true }); }
    if (path === "/api/conversations.info") {
      const id = q.get("channel");
      if (id === "C_ALL") return json(res, 200, { ok: true, channel: { id, name: "general", num_members: 3200, is_private: false, is_ext_shared: false } });
      if (id === "C_PARTNER") return json(res, 200, { ok: true, channel: { id, name: "acme-partner", num_members: 14, is_ext_shared: true } });
      if (id === "C_DEV") return json(res, 200, { ok: true, channel: { id, name: "dev-chat", num_members: 6, is_private: true } });
      return json(res, 200, { ok: false, error: "channel_not_found" });
    }
    json(res, 404, {});
  }, requests);
  return { url: s.url + "/api", requests, close: s.close, posted, state: {} };
}

export async function startGithub(): Promise<Mock & { mutations: string[] }> {
  const requests: Mock["requests"] = []; const mutations: string[] = [];
  const s = await serve((req, res, path) => {
    if (req.method !== "GET") { mutations.push(`${req.method} ${path}`); return json(res, 200, {}); }
    let m: RegExpExecArray | null;
    if ((m = /^\/repos\/acme\/(core|notes)$/.exec(path))) return json(res, 200, m[1] === "core"
      ? { full_name: "acme/core", private: false, fork: false, owner: { login: "acme", type: "Organization" }, stargazers_count: 1840, forks_count: 212, open_issues_count: 63, size: 48000, default_branch: "main" }
      : { full_name: "acme/notes", private: true, fork: false, owner: { login: "acme", type: "User" }, stargazers_count: 0, forks_count: 0, open_issues_count: 0, size: 12000, default_branch: "main" });
    if (/^\/repos\/acme\/\w+\/pulls$/.test(path)) return json(res, 200, path.includes("/core/") ? Array.from({ length: 17 }, (_, i) => ({ number: i + 1 })) : []);
    if ((m = /^\/repos\/acme\/\w+\/branches\/([^/]+)$/.exec(path))) return json(res, 200, { name: m[1], protected: m[1] === "main" || m[1] === "release", commit: { sha: "abcdef0123456789" } });
    if (/\/compare\//.test(path)) return json(res, 200, { ahead_by: 7 });
    json(res, 404, {});
  }, requests);
  return { url: s.url, requests, close: s.close, mutations, state: {} };
}
