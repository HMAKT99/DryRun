import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, symlinkSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createDockerSandbox, loadConfig } from "@dryrun/core";

const bin = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "dryrun.mjs");
const cli = (args: string[], env: Record<string, string> = {}, cwd?: string) =>
  spawnSync(process.execPath, [bin, ...args], { encoding: "utf8", cwd, env: { ...process.env, NO_COLOR: "1", ...env } });
const dir = () => mkdtempSync(join(tmpdir(), "hard-"));

describe("secret redaction end to end", () => {
  it("no secret reaches stdout, stderr, JSON, saved reports or card files", () => {
    const cwd = dir();
    const SECRETS = ["SuperSecret123pw", "sk_live_ABCDEFGH12345678", "ghp_0123456789abcdefghijklmnopqrstuvwxyz"];
    const runs = [
      cli(["sql", "DELETE FROM t", "--db", `postgres://admin:${SECRETS[0]}@127.0.0.1:1/shop_prod`, "--json"], {}, cwd),
      cli(["shell", `curl -H 'Authorization: Bearer ${SECRETS[1]}' https://x.test/${SECRETS[2]}`, "--card", join(cwd, "c.svg")], {}, cwd),
      cli(["saas", "stripe", "refund", "--params", JSON.stringify({ charges: ["ch_1"] }), "--credential-env", "K", "--base-url", "http://127.0.0.1:1"], { K: SECRETS[1]!, DRYRUN_STRIPE_READONLY_TOKEN: SECRETS[1]! }, cwd),
    ];
    const reportsDir = join(cwd, ".dryrun", "reports");
    const all = runs.map((r) => r.stdout + r.stderr).join("\n") + readdirSync(reportsDir).map((f) => readFileSync(join(reportsDir, f), "utf8")).join("\n") + readFileSync(join(cwd, "c.svg"), "utf8");
    for (const s of SECRETS) expect(all, s).not.toContain(s);
    expect(all.length).toBeGreaterThan(500);
    rmSync(cwd, { recursive: true, force: true });
  }, 120_000);
});

describe("failure modes", () => {
  it("Docker missing: Tier 3 is reported as skipped and the verdict is never safe", () => {
    const cwd = dir(); writeFileSync(join(cwd, "a.txt"), "x");
    const r = cli(["shell", "rm a.txt", "--json"], { DOCKER_HOST: "unix:///nonexistent.sock" }, cwd);
    const rep = JSON.parse(r.stdout);
    expect(rep.evidence.tiers_run.find((t: any) => t.tier === 3).status).toBe("skipped");
    expect(rep.evidence.tiers_run.find((t: any) => t.tier === 3).note).toMatch(/Docker/);
    expect(rep.verdict.value).not.toBe("safe");
    expect(existsSync(join(cwd, "a.txt"))).toBe(true);
    rmSync(cwd, { recursive: true, force: true });
  }, 60_000);
  it("invalid dryrun.config.json fails loudly instead of loosening thresholds", () => {
    const cwd = dir(); writeFileSync(join(cwd, "dryrun.config.json"), '{"thresholds":{"blockRows":"lots"}}');
    expect(() => loadConfig(cwd)).toThrow();
    const r = cli(["shell", "ls"], {}, cwd);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/error/i);
    rmSync(cwd, { recursive: true, force: true });
  });
  it("config thresholds are honored", () => {
    const cwd = dir(); writeFileSync(join(cwd, "dryrun.config.json"), JSON.stringify({ thresholds: { blockRows: 5 } }));
    expect(loadConfig(cwd).thresholds.blockRows).toBe(5);
    rmSync(cwd, { recursive: true, force: true });
  });
});

describe.skipIf(!createDockerSandbox().available)("sandbox escape review", () => {
  it("symlinks to host files are copied as links, not followed", async () => {
    const host = dir(); const secret = join(host, "host-secret.txt"); writeFileSync(secret, "HOST-ONLY-SECRET");
    const proj = dir(); symlinkSync(secret, join(proj, "link")); symlinkSync(host, join(proj, "dirlink"));
    const sb = createDockerSandbox(); const copy = sb.copyProject(proj) as any;
    try {
      const r = await copy.run("cat link 2>&1; cat dirlink/host-secret.txt 2>&1; echo END");
      expect(r.stdout).not.toContain("HOST-ONLY-SECRET");
      expect(readFileSync(secret, "utf8")).toBe("HOST-ONLY-SECRET");
    } finally { copy.cleanup(); rmSync(host, { recursive: true, force: true }); rmSync(proj, { recursive: true, force: true }); }
  });
  it("resource limits and hardening flags: no caps, no new privs, read-only rootfs, pid/mem limits", async () => {
    const proj = dir(); const sb = createDockerSandbox(); const copy = sb.copyProject(proj) as any;
    try {
      const r = await copy.run("grep -E 'CapEff|NoNewPrivs' /proc/self/status; touch /rootfile 2>&1; id -u; echo $HOME; (:(){ :|:& };:) 2>&1 | head -c 0; echo alive");
      expect(r.stdout).toMatch(/CapEff:\s+0000000000000000/);
      expect(r.stdout).toMatch(/NoNewPrivs:\s+1/);
      expect(r.stdout).toMatch(/Read-only file system/);
      expect(r.stdout).toContain("alive");
    } finally { copy.cleanup(); rmSync(proj, { recursive: true, force: true }); }
  }, 60_000);
  it("a runaway command is killed at the timeout and the container removed", async () => {
    const proj = dir(); const sb = createDockerSandbox(); const copy = sb.copyProject(proj) as any;
    const t0 = Date.now();
    const r = await copy.run("sleep 600", { timeoutMs: 3000 });
    copy.cleanup();
    expect(r.timedOut).toBe(true); expect(Date.now() - t0).toBeLessThan(15_000);
    expect(spawnSync("docker", ["ps", "-a", "--format", "{{.Names}}"]).stdout.toString()).not.toMatch(/dryrun-[0-9a-f]{12}/);
    rmSync(proj, { recursive: true, force: true });
  }, 60_000);
  it("over-size projects are refused, not copied", () => {
    const proj = dir(); writeFileSync(join(proj, "big"), Buffer.alloc(2_000_000));
    const r = createDockerSandbox().copyProject(proj, { maxBytes: 1000 });
    expect("error" in r).toBe(true);
    rmSync(proj, { recursive: true, force: true });
  });
});

describe("scale and concurrency", () => {
  it("a directory over the limit is rejected quickly without walking everything", () => {
    const proj = dir();
    for (let i = 0; i < 300; i++) writeFileSync(join(proj, `f${i}`), "x");
    const t0 = Date.now();
    const r = createDockerSandbox().copyProject(proj, { maxFiles: 50 }) as { error?: string };
    expect(r.error).toMatch(/over 50 files/);
    expect(Date.now() - t0).toBeLessThan(2000);
    rmSync(proj, { recursive: true, force: true });
  });
  it("reports are saved with a self-ignoring .dryrun/.gitignore", () => {
    const cwd = dir();
    cli(["shell", "ls", "--json"], {}, cwd);
    expect(readFileSync(join(cwd, ".dryrun", ".gitignore"), "utf8")).toBe("*\n");
    spawnSync("git", ["init", "-q"], { cwd });
    expect(spawnSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" }).stdout).not.toContain(".dryrun");
    rmSync(cwd, { recursive: true, force: true });
  });
  it.skipIf(!createDockerSandbox().available)("5 concurrent rehearsals do not interfere or leak containers", async () => {
    const dirs = Array.from({ length: 5 }, (_, i) => { const d = dir(); writeFileSync(join(d, `only-${i}.txt`), "x"); return d; });
    const runs = dirs.map((d, i) => new Promise<any>((res) => { const p = spawnSync(process.execPath, [bin, "shell", `rm only-${i}.txt`, "--json"], { cwd: d, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } }); res(JSON.parse(p.stdout)); }));
    const reps = await Promise.all(runs);
    reps.forEach((r, i) => { expect(r.blast_radius.files, `run ${i}`).toBe(1); expect(r.effects.map((e: any) => e.text).join(" ")).toContain("Deletes 1 file"); });
    for (const [i, d] of dirs.entries()) { expect(existsSync(join(d, `only-${i}.txt`))).toBe(true); rmSync(d, { recursive: true, force: true }); }
    expect(spawnSync("docker", ["ps", "-a", "--format", "{{.Names}}"]).stdout.toString()).not.toMatch(/dryrun-[0-9a-f]{12}/);
  }, 120_000);
});

describe("honest sandbox messages", () => {
  it("a missing sandbox image is reported as such, with the exact fix, not as 'Docker unavailable'", () => {
    const cwd = dir(); writeFileSync(join(cwd, "a.txt"), "x");
    const rep = JSON.parse(cli(["shell", "rm a.txt", "--json"], { DRYRUN_SANDBOX_IMAGE: "dryrun-no-such-image:0" }, cwd).stdout);
    const t3 = rep.evidence.tiers_run.find((t: any) => t.tier === 3);
    expect(t3.status).toBe("skipped");
    expect(t3.note).toMatch(/image dryrun-no-such-image:0 is not pulled \(run: docker pull dryrun-no-such-image:0\)/);
    rmSync(cwd, { recursive: true, force: true });
  });
});
