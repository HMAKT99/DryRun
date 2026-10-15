import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { dockerAvailable, imagePresent, SANDBOX_IMAGE } from "@dryrun/core";
import { AGENTS, detect, type AgentId } from "./setup.js";

export interface Check { name: string; ok: boolean; detail: string; fix?: string }

function registered(agent: AgentId, home: string): boolean {
  const file = { claude: join(home, ".claude.json"), codex: join(home, ".codex", "config.toml"), cursor: join(home, ".cursor", "mcp.json"), gemini: join(home, ".gemini", "settings.json") }[agent];
  if (!existsSync(file)) return false;
  const t = readFileSync(file, "utf8");
  return agent === "codex" ? /\[mcp_servers\.dry-run\]/.test(t) : /"dry-run"\s*:/.test(t);
}

export function doctor(home = homedir(), env: NodeJS.ProcessEnv = process.env): Check[] {
  const out: Check[] = [];
  const major = Number(process.versions.node.split(".")[0]);
  out.push({ name: "Node.js >= 22", ok: major >= 22, detail: process.versions.node, fix: "Install Node 22 or newer" });
  const git = spawnSync("git", ["--version"], { encoding: "utf8" });
  out.push({ name: "git", ok: git.status === 0, detail: git.stdout?.trim() || "not found", fix: "Install git (needed for the force-push rehearsal)" });
  const docker = dockerAvailable();
  out.push({ name: "Docker daemon (Tier 3 sandbox)", ok: docker, detail: docker ? "running" : "not reachable; Dry Run falls back to Tier 1 and 2 and says so in every report", fix: "Start Docker Desktop (macOS/Linux) or use WSL2 + Docker on Windows" });
  if (docker) {
    out.push({ name: `Sandbox image ${SANDBOX_IMAGE}`, ok: imagePresent(), detail: imagePresent() ? "present" : "missing (shell rehearsal needs it)", fix: `docker pull ${SANDBOX_IMAGE}` });
    const pgOk = spawnSync("docker", ["image", "inspect", "postgres:16-alpine"], { stdio: "ignore" }).status === 0;
    out.push({ name: "Image postgres:16-alpine", ok: pgOk, detail: pgOk ? "present" : "missing (SQL rehearsal and the missing-where demo need it)", fix: "docker pull postgres:16-alpine" });
  }
  const creds = Object.keys(env).filter((k) => /^DRYRUN_.*(READONLY_TOKEN|DATABASE_URL)$/.test(k));
  out.push({ name: "Read-only credentials", ok: creds.length > 0, detail: creds.length ? `found: ${creds.join(", ")} (values not shown)` : "none set; Tier 2 will be skipped for databases and APIs", fix: "Create READ-ONLY credentials and export DRYRUN_DATABASE_URL, DRYRUN_STRIPE_READONLY_TOKEN, DRYRUN_GITHUB_READONLY_TOKEN, ... (see docs/credentials.md)" });
  const writey = Object.entries(env).filter(([k, v]) => /^DRYRUN_.*TOKEN$/.test(k) && /^(sk_live_|ghp_|xoxp-)/.test(v ?? "")).map(([k]) => k);
  if (writey.length) out.push({ name: "Read-only credentials look read-only", ok: false, detail: `${writey.join(", ")} look like full-access keys`, fix: "Use restricted keys (Stripe rk_*, GitHub fine-grained read-only, Slack bot with channels:read)" });
  for (const a of AGENTS) {
    const here = detect(a, home);
    out.push({ name: `Agent: ${a}`, ok: !here || registered(a, home), detail: !here ? "not installed (skipped)" : registered(a, home) ? "Dry Run registered" : "installed but Dry Run NOT registered", fix: "npx dry-run-agents setup" });
  }
  return out;
}
