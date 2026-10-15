import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { redact } from "@dryrun/core";

const SAFE_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "true",
  SSH_ASKPASS: "true",
  // `ext::` and `fd::` transports execute commands: never allow them.
  GIT_ALLOW_PROTOCOL: "file:https:http:ssh:git",
  GIT_OPTIONAL_LOCKS: "0",
};
// Untrusted repo config (fsmonitor, pager, etc.) must not run code during our reads.
const HARDEN = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "protocol.ext.allow=never"];

export function git(cwd: string, args: string[], timeout = 30_000): string {
  return execFileSync("git", [...HARDEN, ...args], { cwd, env: SAFE_ENV, timeout, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 20e6 });
}
export const tryGit = (cwd: string, args: string[], timeout?: number): string | undefined => {
  try { return git(cwd, args, timeout).trim(); } catch { return undefined; }
};

export function isGitRepo(cwd: string): boolean {
  return tryGit(cwd, ["rev-parse", "--is-inside-work-tree"]) === "true";
}

export interface PushSpec {
  force: boolean;
  forceWithLease: boolean;
  delete: boolean;
  remote: string;
  src?: string;
  dst?: string;
  plusRefspec: boolean;
  all: boolean;
  mirror: boolean;
}

export function parsePush(args: string[], cwd: string): PushSpec {
  const flags = args.filter((a) => a.startsWith("-"));
  const pos = args.filter((a) => !a.startsWith("-"));
  const has = (...n: string[]) => flags.some((f) => n.includes(f));
  const spec: PushSpec = {
    force: has("-f", "--force") || flags.some((f) => /^-[a-zA-Z]*f[a-zA-Z]*$/.test(f)),
    forceWithLease: flags.some((f) => f.startsWith("--force-with-lease") || f.startsWith("--force-if-includes")),
    delete: has("-d", "--delete"),
    remote: pos[0] ?? "origin",
    plusRefspec: false, all: has("--all"), mirror: has("--mirror"),
  };
  let refspec = pos[1];
  if (!refspec) {
    const b = tryGit(cwd, ["symbolic-ref", "--short", "HEAD"]);
    if (b) { spec.src = b; spec.dst = b; }
    return spec;
  }
  if (refspec.startsWith("+")) { spec.plusRefspec = true; refspec = refspec.slice(1); }
  const [s, d] = refspec.includes(":") ? (refspec.split(":", 2) as [string, string]) : [refspec, refspec];
  if (s === "") { spec.delete = true; spec.dst = d; } else { spec.src = s; spec.dst = d === "HEAD" ? tryGit(cwd, ["symbolic-ref", "--short", "HEAD"]) ?? d : d; }
  if (spec.src === "HEAD" && !refspec.includes(":")) spec.dst = tryGit(cwd, ["symbolic-ref", "--short", "HEAD"]) ?? "HEAD";
  return spec;
}

export interface LostCommit { sha: string; author: string; email: string; subject: string; date: string; existsLocally: boolean }
export interface PushAnalysis {
  remoteUrl: string;
  remoteSha?: string;
  localSha?: string;
  fastForward: boolean;
  lost: LostCommit[];
  ahead: number;
  me?: string;
}

/**
 * Read-only computation of what a push would overwrite. Fetches the remote branch into a
 * THROWAWAY bare repo (sharing local objects via alternates) so neither the real remote nor
 * the user's repository is modified.
 */
export function analyzePush(cwd: string, spec: PushSpec): PushAnalysis {
  const url = git(cwd, ["remote", "get-url", spec.remote]).trim();
  if (url.startsWith("-")) throw new Error("refusing remote URL beginning with '-'");
  const dst = spec.dst;
  if (!dst) throw new Error("could not determine destination ref");
  const ref = dst.startsWith("refs/") ? dst : `refs/heads/${dst}`;
  const tmp = mkdtempSync(join(tmpdir(), "dryrun-git-"));
  try {
    git(tmp, ["init", "--bare", "-q", "."]);
    const alt = resolve(cwd, git(cwd, ["rev-parse", "--git-path", "objects"]).trim());
    mkdirSync(join(tmp, "objects/info"), { recursive: true });
    writeFileSync(join(tmp, "objects/info/alternates"), alt + "\n");
    let remoteSha: string | undefined;
    try {
      git(tmp, ["fetch", "-q", "--no-tags", "--", url, `+${ref}:refs/dryrun/remote`], 45_000);
      remoteSha = git(tmp, ["rev-parse", "refs/dryrun/remote"]).trim();
    } catch (e) {
      const msg = redact(String((e as { stderr?: string }).stderr ?? e));
      if (!/couldn't find remote ref/i.test(msg)) throw new Error(`could not read remote: ${msg.slice(0, 200)}`);
    }
    const localSha = spec.src ? tryGit(cwd, ["rev-parse", "--verify", `${spec.src}^{commit}`]) : undefined;
    const me = tryGit(cwd, ["config", "user.email"]);
    if (!remoteSha) return { remoteUrl: redact(url), localSha, fastForward: true, lost: [], ahead: 0, me };
    const isAncestor = localSha ? tryGit(tmp, ["merge-base", "--is-ancestor", remoteSha, localSha]) !== undefined : false;
    const range = spec.delete || !localSha ? remoteSha : `${localSha}..${remoteSha}`;
    const log = tryGit(tmp, ["log", "--format=%H%x1f%an%x1f%ae%x1f%s%x1f%aI", range]) ?? "";
    const lost: LostCommit[] = log.split("\n").filter(Boolean).map((l) => {
      const [sha = "", author = "", email = "", subject = "", date = ""] = l.split("\x1f");
      return { sha, author, email, subject, date, existsLocally: tryGit(cwd, ["cat-file", "-e", `${sha}^{commit}`]) !== undefined };
    });
    const ahead = localSha ? Number(tryGit(tmp, ["rev-list", "--count", `${remoteSha}..${localSha}`]) ?? 0) : 0;
    return { remoteUrl: redact(url), remoteSha, localSha, fastForward: isAncestor, lost: isAncestor ? [] : lost, ahead, me };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Tracked & unmodified paths can be restored from git; everything else cannot. */
export function recoverableSet(cwd: string): { tracked: Set<string>; dirty: Set<string> } | undefined {
  if (!isGitRepo(cwd)) return undefined;
  const top = tryGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (!top || resolve(top) !== resolve(cwd)) {
    // Subdirectory of a repo: paths are relative to cwd via --relative.
  }
  const tracked = new Set((tryGit(cwd, ["ls-files", "-z"]) ?? "").split("\0").filter(Boolean));
  const dirty = new Set((tryGit(cwd, ["diff", "--relative", "--name-only", "-z", "HEAD"]) ?? "").split("\0").filter(Boolean));
  return { tracked, dirty };
}
