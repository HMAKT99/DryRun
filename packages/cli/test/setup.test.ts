import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { AGENTS, apply, plan, launchFor, editToml, editJsonServers, editMdBlock, ConfigError } from "../src/setup.js";

const bin = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "dryrun.mjs");
let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "home-")); });
afterEach(() => rmSync(home, { recursive: true, force: true }));
const launch = launchFor({ script: "/opt/dryrun/dryrun.mjs" });

describe("setup (scratch HOME)", () => {
  it("registers Claude Code, Codex, Cursor and Gemini, preserving existing config, with backups", () => {
    mkdirSync(join(home, ".claude"), { recursive: true }); mkdirSync(join(home, ".codex"), { recursive: true }); mkdirSync(join(home, ".cursor"), { recursive: true }); mkdirSync(join(home, ".gemini"), { recursive: true });
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ numStartups: 7, mcpServers: { other: { command: "x" } } }));
    writeFileSync(join(home, ".codex", "config.toml"), 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "y"\n');
    writeFileSync(join(home, ".claude", "CLAUDE.md"), "# my rules\nbe nice\n");
    writeFileSync(join(home, ".gemini", "settings.json"), '{"theme":"dark"}');
    const plans = plan(AGENTS, home, launch);
    expect(plans.every((p) => p.detected)).toBe(true);
    for (const p of plans) for (const c of p.changes) apply(c, "T1");
    const cj = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
    expect(cj.numStartups).toBe(7); expect(cj.mcpServers.other).toBeTruthy();
    expect(cj.mcpServers["dry-run"]).toEqual({ type: "stdio", command: process.execPath, args: ["/opt/dryrun/dryrun.mjs", "mcp"], env: {} });
    expect(readFileSync(join(home, ".claude", "CLAUDE.md"), "utf8")).toContain("# my rules");
    expect(readFileSync(join(home, ".claude", "CLAUDE.md"), "utf8")).toContain("Dry Run: rehearse before you act");
    expect(existsSync(join(home, ".claude", "skills", "dry-run", "SKILL.md"))).toBe(true);
    const toml = readFileSync(join(home, ".codex", "config.toml"), "utf8");
    expect(toml).toContain('model = "gpt-5"'); expect(toml).toContain("[mcp_servers.other]"); expect(toml).toContain("[mcp_servers.dry-run]");
    expect(readFileSync(join(home, ".codex", "AGENTS.md"), "utf8")).toContain("dry_run");
    expect(JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8")).mcpServers["dry-run"].command).toBe(process.execPath);
    expect(JSON.parse(readFileSync(join(home, ".gemini", "settings.json"), "utf8")).theme).toBe("dark");
    expect(readdirSync(home).some((f) => f.startsWith(".claude.json.dryrun-backup-"))).toBe(true);
    expect(readdirSync(join(home, ".codex")).some((f) => f.startsWith("config.toml.dryrun-backup-"))).toBe(true);
    // idempotent
    expect(plan(AGENTS, home, launch).every((p) => p.changes.length === 0)).toBe(true);
  });
  it("uninstall restores the original content", () => {
    mkdirSync(join(home, ".codex"), { recursive: true });
    const orig = 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "y"\n';
    writeFileSync(join(home, ".codex", "config.toml"), orig);
    writeFileSync(join(home, ".codex", "AGENTS.md"), "# mine\n");
    for (const p of plan(["codex"], home, launch)) for (const c of p.changes) apply(c, "T1");
    for (const p of plan(["codex"], home, null)) for (const c of p.changes) apply(c, "T2");
    expect(readFileSync(join(home, ".codex", "config.toml"), "utf8").trim()).toBe(orig.trim());
    expect(readFileSync(join(home, ".codex", "AGENTS.md"), "utf8").trim()).toBe("# mine");
  });
  it("refuses to touch invalid JSON and unmanaged conflicting TOML", () => {
    expect(() => editJsonServers("{ not json", "f", { command: "x" })).toThrow(ConfigError);
    expect(() => editToml('[mcp_servers.dry-run]\ncommand = "mine"\n', launch)).toThrow(ConfigError);
    mkdirSync(join(home, ".gemini"), { recursive: true }); writeFileSync(join(home, ".gemini", "settings.json"), "{ broken");
    const p = plan(["gemini"], home, launch)[0]!;
    expect(p.skipped).toMatch(/not valid JSON/);
    expect(readFileSync(join(home, ".gemini", "settings.json"), "utf8")).toBe("{ broken");
  });
  it("npx launch is used when running from the npx cache", () => {
    expect(launchFor({ script: "/Users/x/.npm/_npx/abc/node_modules/dry-run-agents/dist/dryrun.mjs" })).toEqual({ command: "npx", args: ["-y", "dry-run-agents", "mcp"] });
  });
  it("markdown block replace is stable", () => {
    const a = editMdBlock("hello\n", "BODY"); expect(editMdBlock(a, "BODY")).toBe(a); expect(editMdBlock(a, null)).toBe("hello\n");
  });
  it("CLI: --dry-run changes nothing; --yes applies; non-TTY without --yes refuses", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    const run = (...a: string[]) => spawnSync(process.execPath, [bin, "setup", "--home", home, "--agents", "claude", ...a], { encoding: "utf8", stdin: "ignore" } as never);
    const d = run("--dry-run"); expect(d.status).toBe(0); expect(d.stdout).toContain("+ ");
    expect(existsSync(join(home, ".claude.json"))).toBe(false);
    const n = run(); expect(n.status).toBe(1); expect(n.stderr).toMatch(/--yes/);
    expect(existsSync(join(home, ".claude.json"))).toBe(false);
    const y = run("--yes"); expect(y.status).toBe(0);
    expect(JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")).mcpServers["dry-run"].args[1]).toBe("mcp");
  });
});

describe("CLI exit codes and doctor", () => {
  const cli = (...a: string[]) => spawnSync(process.execPath, [bin, ...a], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  it("block=3, confirm=2, safe=0", () => {
    expect(cli("shell", "rm -rf /").status).toBe(3);
    expect(cli("shell", "ls").status).toBe(0);
    expect(cli("shell", "mysterytool --go").status).toBe(2);
  });
  it("--card writes a PNG", () => {
    const f = join(home, "c.png"); cli("shell", "rm -rf /", "--card", f);
    expect(readFileSync(f).subarray(1, 4).toString()).toBe("PNG");
  });
  it("doctor reports and exits non-zero when something is missing", () => {
    const r = cli("doctor"); expect(r.stdout).toContain("Docker daemon");
  });
  it("sql without a database: tier 2 skipped/errored, never safe", () => {
    const r = cli("sql", "DELETE FROM orders", "--json"); expect(r.status).not.toBe(0);
  });
});

describe("CLI error paths", () => {
  const cli = (...a: string[]) => spawnSync(process.execPath, [bin, ...a], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  it("bad --params JSON, unknown demo, unknown agent and missing report all fail clearly with exit 1", () => {
    expect(cli("saas", "stripe", "refund", "--params", "{nope").status).toBe(1);
    expect(cli("demo", "bogus").status).toBe(1);
    expect(cli("setup", "--agents", "emacs", "--dry-run").status).toBe(1);
    const r = cli("explain", "00000000-0000-0000-0000-000000000000"); expect(r.status).toBe(1); expect(r.stderr).toMatch(/No report/);
    expect(cli("explain", "../../etc/passwd").status).toBe(1);
  });
  it("terraform with a real plan file: delete of a prod DB is exit 3; a no-op plan is exit 0", () => {
    const d = mkdtempSync(join(tmpdir(), "tf-"));
    writeFileSync(join(d, "bad.json"), JSON.stringify({ resource_changes: [{ address: "aws_db_instance.p", type: "aws_db_instance", change: { actions: ["delete"], before: { identifier: "shop-prod", allocated_storage: 50, skip_final_snapshot: true } } }] }));
    writeFileSync(join(d, "ok.json"), JSON.stringify({ resource_changes: [{ address: "x", type: "aws_s3_bucket", change: { actions: ["no-op"] } }] }));
    expect(cli("tf", join(d, "bad.json"), "--cwd", d).status).toBe(3);
    expect(cli("tf", join(d, "ok.json"), "--cwd", d).status).toBe(0);
    expect(cli("tf", d, "--cwd", d).status).not.toBe(0); // directory without plan.json
    rmSync(d, { recursive: true, force: true });
  });
});
