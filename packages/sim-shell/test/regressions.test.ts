import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dryRun, defaultConfig, makeReadOnlyContext } from "@dryrun/core";
import { createShellSimulator, parseCommand, splitGit, sensitiveReason } from "../src/index.js";

// cwd under /var and /usr/src/app-like paths: projects there must not make every path "a system directory".
const proj = mkdtempSync(join(tmpdir(), "reg-"));
const run = (c: string, cwd = proj) => dryRun({ type: "shell", action: c, context: { cwd } }, [createShellSimulator()], { config: defaultConfig(), readOnly: makeReadOnlyContext(undefined) });

describe("regressions found in the end-to-end probe", () => {
  it("read-only commands are safe even when the project lives under /var, /usr or /tmp", async () => {
    for (const c of ["echo hi; ls", "cat a.txt | wc -l", "grep -r foo .", "ls 2>&1", "git status", "git -C . log --oneline", "sort a.txt"]) expect((await run(c)).verdict.value, c).toBe("safe");
    expect(sensitiveReason("/usr/src/app/a.txt", "/usr/src/app")).toBeUndefined();
    expect(sensitiveReason("/var/www/site/x", "/var/www/site")).toBeUndefined();
    expect(sensitiveReason("/etc/passwd", "/usr/src/app")).toBe("a system directory");
    expect(sensitiveReason("/usr/src/app/.env", "/usr/src/app")).toMatch(/environment file/);
  });
  it("benign-looking commands that write files or run programs are NOT safe", async () => {
    for (const c of ["git log --output=a.txt", "git diff --output=a.txt", "git log --ext-diff", "git -c core.pager=x log", "sort -o a.txt a.txt", "sort --output=a.txt a.txt", "uniq a.txt out.txt", "rg --pre ./x foo", "tree -o a.txt", "hostname evil", "date -s 2020-01-01", "echo x > a.txt", "ls >> log.txt"])
      expect((await run(c)).verdict.value, c).not.toBe("safe");
  });
  it("wrappers with arguments are unwrapped: catastrophic commands are blocked", async () => {
    for (const c of ["sudo -u root rm -rf /", "nice -n 5 rm -rf /", "env -u X rm -rf /", "sudo -- rm -rf ~", "doas -u root rm -rf /", "time rm -rf /", "nohup rm -rf / &"])
      expect((await run(c)).verdict.value, c).toBe("block");
    expect(parseCommand("sudo -u root rm -rf x").segments[0]!.argv).toEqual(["rm", "-rf", "x"]);
  });
  it("git global options are not mistaken for the subcommand", () => {
    expect(splitGit(["-C", "sub", "push", "--force"], "/p")).toMatchObject({ sub: "push", cwd: "/p/sub", rest: ["--force"] });
    expect(splitGit(["-c", "a=b", "--no-pager", "log"], "/p")).toMatchObject({ sub: "log", configOverrides: ["a=b"] });
  });
  it("copying or moving INTO home is a confirm, never a hard block; moving home away is blocked", async () => {
    for (const c of ["cp a.txt ~/", "cp -r . ~/backup", "mv a.txt ~/", "rsync -a src/ ~/dst/"]) expect((await run(c)).verdict.value, c).toBe("confirm");
    for (const c of ["mv ~ /tmp/x", "mv /etc/hosts /tmp", "rsync -a --delete src/ ~/dst/"]) expect(["block", "confirm"]).toContain((await run(c)).verdict.value);
    expect((await run("mv ~ /tmp/x")).verdict.value).toBe("block");
  });
  it("2>&1 is not a file write", () => {
    expect(parseCommand("ls 2>&1").segments[0]!.redirects).toEqual([]);
    expect(parseCommand("ls > out.txt").segments[0]!.redirects).toHaveLength(1);
  });
  it("well-known destructive CLIs get specific, non-safe findings", async () => {
    const cases: Array<[string, RegExp]> = [
      ["terraform destroy -auto-approve", /destroy deletes every resource/], ["terraform apply", /changes real infrastructure/], ["kubectl delete ns prod", /removes or stops live cluster/],
      ["docker system prune -af", /deletes containers, images or volumes/], ["docker volume rm pgdata", /volumes hold persistent data/], ["aws s3 rm s3://b --recursive", /deletes or terminates/],
      ["gh repo delete o/r --yes", /deletes or changes GitHub/], ["psql -c \"DROP TABLE users\"", /destructive statement directly/], ["dropdb prod", /permanently deletes a database/], ["redis-cli flushall", /destructive statement directly/],
    ];
    for (const [c, re] of cases) { const r = await run(c); expect(r.verdict.value, c).not.toBe("safe"); expect(r.effects.map((e) => e.text).join(" "), c).toMatch(re); }
    for (const c of ["docker ps", "kubectl get pods", "terraform plan"]) expect((await run(c)).verdict.value, c).not.toBe("safe");
  });
});
