import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { CLAUDE_SKILL, CURSOR_RULE, INSTRUCTIONS, MARK_BEGIN, MARK_END } from "./templates.js";

export type AgentId = "claude" | "codex" | "cursor" | "gemini";
export const AGENTS: AgentId[] = ["claude", "codex", "cursor", "gemini"];
export const SERVER_NAME = "dry-run";

export interface Launch { command: string; args: string[] }
export interface Change { agent: AgentId; file: string; before: string | null; after: string | null; note: string }
export interface Plan { agent: AgentId; detected: boolean; changes: Change[]; skipped?: string }

const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : null);
const onPath = (bin: string) => spawnSync(process.platform === "win32" ? "where" : "which", [bin], { stdio: "ignore" }).status === 0;

export function detect(agent: AgentId, home: string): boolean {
  switch (agent) {
    case "claude": return existsSync(join(home, ".claude")) || existsSync(join(home, ".claude.json")) || onPath("claude");
    case "codex": return existsSync(join(home, ".codex")) || onPath("codex");
    case "cursor": return existsSync(join(home, ".cursor")) || existsSync("/Applications/Cursor.app") || onPath("cursor");
    case "gemini": return existsSync(join(home, ".gemini")) || onPath("gemini");
  }
}

// ---- pure editors (also used for uninstall) ----
export class ConfigError extends Error {}

export function editJsonServers(text: string | null, file: string, entry: unknown | null): string {
  let obj: Record<string, unknown> = {};
  if (text && text.trim()) { try { obj = JSON.parse(text); } catch { throw new ConfigError(`${file} is not valid JSON; refusing to modify it. Fix or move it, then re-run.`); } }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) throw new ConfigError(`${file} does not contain a JSON object`);
  const servers = ((obj["mcpServers"] as Record<string, unknown>) ?? {}) as Record<string, unknown>;
  if (entry) servers[SERVER_NAME] = entry; else delete servers[SERVER_NAME];
  if (entry || Object.keys(servers).length) obj["mcpServers"] = servers; else delete obj["mcpServers"];
  return JSON.stringify(obj, null, 2) + "\n";
}

const tomlStr = (s: string) => JSON.stringify(s); // JSON string escaping is valid TOML basic-string escaping for our inputs
const TOML_BEGIN = "# >>> dry-run (managed by dry-run-agents) >>>", TOML_END = "# <<< dry-run <<<";
export function editToml(text: string | null, launch: Launch | null): string {
  let t = text ?? "";
  const re = new RegExp(`\\n?${TOML_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${TOML_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n?`);
  t = t.replace(re, "\n");
  if (/^\[mcp_servers\.dry-run\]/m.test(t) || /^\[mcp_servers\."dry-run"\]/m.test(t)) throw new ConfigError("config.toml already has an unmanaged [mcp_servers.dry-run] table; remove it or rename it first.");
  t = t.replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "");
  t = t.trimEnd() ? t.trimEnd() + "\n" : "";
  if (!launch) return t;
  const block = `${TOML_BEGIN}\n[mcp_servers.dry-run]\ncommand = ${tomlStr(launch.command)}\nargs = [${launch.args.map(tomlStr).join(", ")}]\n${TOML_END}\n`;
  return t + (t ? "\n" : "") + block;
}

export function editMdBlock(text: string | null, body: string | null): string {
  let t = text ?? "";
  const re = new RegExp(`\\n*${MARK_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${MARK_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n*`);
  t = t.replace(re, "\n");
  if (!body) return t.trim() ? t.trim() + "\n" : "";
  return (t.trim() ? t.trim() + "\n\n" : "") + `${MARK_BEGIN}\n${body}\n${MARK_END}\n`;
}

export function launchFor(opts: { npx?: boolean; script?: string }): Launch {
  const script = opts.script ?? process.argv[1] ?? "";
  if (opts.npx || /[\\/]_npx[\\/]/.test(script)) return { command: "npx", args: ["-y", "dry-run-agents", "mcp"] };
  return { command: process.execPath, args: [script, "mcp"] };
}

export function plan(agents: AgentId[], home: string, launch: Launch | null, o: { project?: string } = {}): Plan[] {
  const out: Plan[] = [];
  const install = launch !== null;
  const mk = (agent: AgentId, file: string, after: (before: string | null) => string | null, note: string): Change => ({ agent, file, before: read(file), after: after(read(file)), note });
  for (const agent of agents) {
    const detected = detect(agent, home);
    const changes: Change[] = [];
    try {
      switch (agent) {
        case "claude": {
          const f = join(home, ".claude.json");
          changes.push(mk(agent, f, (b) => editJsonServers(b, f, launch && { type: "stdio", command: launch.command, args: launch.args, env: {} }), "register MCP server (user scope)"));
          const skill = join(home, ".claude", "skills", "dry-run", "SKILL.md");
          changes.push({ agent, file: skill, before: read(skill), after: install ? CLAUDE_SKILL : null, note: "agent instructions (skill)" });
          const md = join(home, ".claude", "CLAUDE.md");
          changes.push(mk(agent, md, (b) => editMdBlock(b, install ? INSTRUCTIONS : null) || null, "agent instructions (always-on)"));
          break;
        }
        case "codex": {
          const f = join(home, ".codex", "config.toml");
          changes.push(mk(agent, f, (b) => editToml(b, launch), "register MCP server"));
          const md = join(home, ".codex", "AGENTS.md");
          changes.push(mk(agent, md, (b) => editMdBlock(b, install ? INSTRUCTIONS : null) || null, "agent instructions"));
          break;
        }
        case "cursor": {
          const f = join(home, ".cursor", "mcp.json");
          changes.push(mk(agent, f, (b) => editJsonServers(b, f, launch && { type: "stdio", command: launch.command, args: launch.args }), "register MCP server (global)"));
          if (o.project) { const r = join(o.project, ".cursor", "rules", "dry-run.mdc"); changes.push({ agent, file: r, before: read(r), after: install ? CURSOR_RULE : null, note: "project rule (Cursor has no global rules file; add the text in Settings → Rules for all projects)" }); }
          break;
        }
        case "gemini": {
          const f = join(home, ".gemini", "settings.json");
          changes.push(mk(agent, f, (b) => editJsonServers(b, f, launch && { command: launch.command, args: launch.args }), "register MCP server (user scope)"));
          const md = join(home, ".gemini", "GEMINI.md");
          changes.push(mk(agent, md, (b) => editMdBlock(b, install ? INSTRUCTIONS : null) || null, "agent instructions"));
          break;
        }
      }
    } catch (e) { out.push({ agent, detected, changes: [], skipped: (e as Error).message }); continue; }
    out.push({ agent, detected, changes: changes.filter((c) => c.before !== c.after) });
  }
  return out;
}

export function diffText(c: Change): string {
  const a = (c.before ?? "").split("\n"), b = (c.after ?? "").split("\n");
  const removed = a.filter((l) => !b.includes(l)), added = b.filter((l) => !a.includes(l));
  const head = c.before === null ? "(new file)" : c.after === null ? "(file removed)" : "(modified)";
  return [`  ${c.file} ${head} — ${c.note}`, ...removed.map((l) => `    - ${l}`), ...added.map((l) => `    + ${l}`)].join("\n");
}

/** Back up, then write atomically. Returns the backup path (if the file existed). */
export function apply(c: Change, stamp = new Date().toISOString().replace(/[:.]/g, "-")): string | undefined {
  let backup: string | undefined;
  if (c.before !== null) { backup = `${c.file}.dryrun-backup-${stamp}`; copyFileSync(c.file, backup); }
  if (c.after === null || (c.after === "" && c.before !== null)) { if (existsSync(c.file)) rmSync(c.file); return backup; }
  mkdirSync(dirname(c.file), { recursive: true });
  const tmp = `${c.file}.dryrun-tmp-${process.pid}`;
  writeFileSync(tmp, c.after);
  renameSync(tmp, c.file);
  return backup;
}
