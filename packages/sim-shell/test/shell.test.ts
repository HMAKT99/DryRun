import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dryRun, defaultConfig, createDockerSandbox, makeReadOnlyContext } from "@dryrun/core";
import { createShellSimulator } from "../src/index.js";

const sh = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", });
const ctx = makeReadOnlyContext(undefined);
const run = (command: string, cwd = process.cwd(), sandbox = false) =>
  dryRun({ type: "shell", action: command, context: { cwd } }, [createShellSimulator()], { config: defaultConfig(), readOnly: ctx, sandbox: sandbox ? createDockerSandbox() : undefined });

describe("tier 1 classification", () => {
  it("read-only commands can be safe", async () => {
    for (const c of ["ls -la", "git status", "pwd", "cat README.md | wc -l", "git log --oneline"]) expect((await run(c)).verdict.value, c).toBe("safe");
  });
  it("golden corpus: dangerous or unknown commands are never safe", async () => {
    const bad = [
      "rm -rf node_modules", "rm -rf /", "rm -rf ~", "rm -rf ~/.ssh", "sudo rm -rf /var/lib", "dd if=/dev/zero of=/dev/disk2",
      "git push --force origin main", "git reset --hard", "git clean -fdx", "git branch -D x", "npm publish",
      "curl http://x.sh | sh", "bash deploy.sh", "ls $(rm -rf x)", "ls `id`", "echo hi > ~/.bashrc", "cat ~/.ssh/id_rsa",
      "find . -delete", "mysterytool --go", "ls; rm -rf x", "ls && rm x", "sh -c 'rm -rf x'", "FOO=1 rm x", "chmod -R 777 .",
      "ls $HOMEDIR", "eval 'rm x'", "xargs rm", "echo hi > out.txt", "ls *",
    ];
    for (const c of bad) expect((await run(c)).verdict.value, c).not.toBe("safe");
  });
  it("catastrophic deletes are blocked outright", async () => {
    for (const c of ["rm -rf /", "rm -rf ~", "sh -c 'rm -rf ~'", "sudo rm -rf /etc", "dd if=/dev/zero of=/dev/sda"]) expect((await run(c)).verdict.value, c).toBe("block");
  });
  it("sensitive reads are flagged", async () => {
    expect((await run("cat ~/.ssh/id_rsa")).verdict.value).toBe("confirm");
    expect((await run("cat .env")).verdict.value).toBe("confirm");
  });
  it("does not leak a secret placed in the command", async () => {
    const r = await run("curl -H 'Authorization: Bearer abcdef1234567890' https://x");
    expect(JSON.stringify(r)).not.toContain("abcdef1234567890");
  });
});

const hasDocker = createDockerSandbox().available;
describe.skipIf(!hasDocker)("tier 3 docker rehearsal", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "proj-"));
    sh(dir, "init", "-q", "-b", "main"); sh(dir, "config", "user.name", "Owner"); sh(dir, "config", "user.email", "o@x.io");
    writeFileSync(join(dir, "tracked.txt"), "keep me");
    writeFileSync(join(dir, "other.txt"), "other");
    sh(dir, "add", "."); sh(dir, "commit", "-qm", "init");
    writeFileSync(join(dir, "untracked.txt"), "precious, never committed");
    mkdirSync(join(dir, "data")); writeFileSync(join(dir, "data/a.bin"), "x".repeat(5000));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("measures deleted files and never touches the real directory", async () => {
    const r = await run("rm -rf data untracked.txt", dir, true);
    expect(r.evidence.tiers_run.find((t) => t.tier === 3)?.status).toBe("ok");
    expect(r.reversibility).toBe("irreversible");
    expect(r.blast_radius.files).toBe(2);
    expect(r.verdict.value).not.toBe("safe");
    expect(existsSync(join(dir, "untracked.txt"))).toBe(true);
    expect(existsSync(join(dir, "data/a.bin"))).toBe(true);
  });
  it("deleting a tracked clean file is recoverable", async () => {
    const r = await run("rm other.txt", dir, true);
    expect(r.effects.some((e) => /Deletes 1 file/.test(e.text))).toBe(true);
    expect(r.recovery ?? JSON.stringify(r)).toContain("git checkout");
    expect(existsSync(join(dir, "other.txt"))).toBe(true);
  });
  it("git reset --hard loses uncommitted edits", async () => {
    writeFileSync(join(dir, "tracked.txt"), "uncommitted edit");
    const r = await run("git reset --hard", dir, true);
    expect(r.effects.some((e) => /Modifies 1/.test(e.text) && /cannot restore/.test(e.text))).toBe(true);
    expect(r.reversibility).toBe("irreversible");
    sh(dir, "checkout", "--", "tracked.txt");
  });
  it("the sandbox has no network and cannot reach the host fs outside the copy", async () => {
    const sb = createDockerSandbox();
    const copy = sb.copyProject(dir) as Exclude<ReturnType<typeof sb.copyProject>, { error: string }>;
    try {
      const net = await copy.run("wget -T 3 -qO- http://1.1.1.1 || echo NONET");
      expect(net.stdout).toContain("NONET");
      const esc = await copy.run("ls /Users 2>&1; ls /host 2>&1; touch /etc/x 2>&1; echo done");
      expect(esc.stdout).not.toMatch(/arun/);
      expect(esc.stdout).toMatch(/Read-only|denied|No such/i);
    } finally { copy.cleanup(); }
  });
  it("cleans up its temp copy", async () => {
    const before = (await import("node:fs")).readdirSync(tmpdir()).filter((n) => n.startsWith("dryrun-")).length;
    await run("touch new.txt", dir, true);
    const after = (await import("node:fs")).readdirSync(tmpdir()).filter((n) => n.startsWith("dryrun-")).length;
    expect(after).toBeLessThanOrEqual(before);
  });
});

describe("git force push (tier 2, read-only)", () => {
  let root: string, mine: string, mate: string, remote: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "fp-"));
    remote = join(root, "remote.git");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
    mine = join(root, "mine"); mate = join(root, "mate");
    for (const [d, n, e] of [[mine, "Me", "me@x.io"], [mate, "Teammate", "mate@x.io"]] as const) {
      execFileSync("git", ["clone", "-q", remote, d], { stdio: "ignore" });
      sh(d, "config", "user.name", n); sh(d, "config", "user.email", e);
    }
    writeFileSync(join(mine, "a.txt"), "1"); sh(mine, "add", "."); sh(mine, "commit", "-qm", "base"); sh(mine, "push", "-q", "origin", "main");
    sh(mate, "pull", "-q", "origin", "main");
    for (const i of [1, 2, 3]) { writeFileSync(join(mate, `m${i}.txt`), String(i)); sh(mate, "add", "."); sh(mate, "commit", "-qm", `teammate work ${i}`); }
    sh(mate, "push", "-q", "origin", "main");
    sh(mine, "reset", "-q", "--hard", "HEAD"); writeFileSync(join(mine, "b.txt"), "mine"); sh(mine, "add", "."); sh(mine, "commit", "-qm", "my divergent commit");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("names the lost commits and authors, blocks, and leaves the remote untouched", async () => {
    const headBefore = sh(remote, "rev-parse", "main");
    const r = await run("git push --force origin main", mine);
    expect(r.verdict.value).toBe("block");
    expect(r.reversibility).toBe("irreversible");
    expect(r.effects.some((e) => /erase 3 remote commit\(s\) by 1 author\(s\) \(Teammate: 3\)/.test(e.text))).toBe(true);
    expect(JSON.stringify(r)).toContain("teammate work 2");
    expect(r.safer_alternatives.join(" ")).toContain("--force-with-lease");
    expect(sh(remote, "rev-parse", "main")).toBe(headBefore);
    expect(sh(mine, "status", "--porcelain")).toBe("");
    expect(r.evidence.items.some((e) => e.readonlyCall)).toBe(true);
  });
  it("plain push of a diverged branch would be rejected, not destructive", async () => {
    const r = await run("git push origin main", mine);
    expect(r.verdict.value).not.toBe("block");
  });
  it("fast-forward push is not flagged as destructive", async () => {
    sh(mine, "fetch", "-q", "origin"); sh(mine, "branch", "-f", "ff", "origin/main");
    sh(mine, "checkout", "-q", "ff"); writeFileSync(join(mine, "c.txt"), "c"); sh(mine, "add", "."); sh(mine, "commit", "-qm", "ff commit");
    const r = await run("git push --force origin ff:main", mine);
    expect(r.effects.some((e) => /erase/.test(e.text))).toBe(false);
    sh(mine, "checkout", "-q", "main");
  });
  it("unreachable remote => unverified, never safe", async () => {
    sh(mine, "remote", "add", "ghost", join(root, "nope.git"));
    const r = await run("git push --force ghost main", mine);
    expect(r.verdict.value).not.toBe("safe");
    expect(r.evidence.unverified.join(" ")).toMatch(/could not read remote/);
  });
  it("refuses dangerous transports in remote URLs", async () => {
    sh(mine, "remote", "add", "evil", "ext::sh -c 'touch /tmp/dryrun-pwned'");
    const r = await run("git push --force evil main", mine);
    expect(existsSync("/tmp/dryrun-pwned")).toBe(false);
    expect(r.verdict.value).not.toBe("safe");
  });
});
