import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Action, Finding, Sandbox, Simulator, ReadOnlyContext } from "@dryrun/core";
import { createDockerSandbox, diffManifests, type DockerSandbox } from "@dryrun/core";
import { basename, expandPath, isInside, parseCommand, sensitiveReason, splitGit, type Segment } from "./classify.js";
import { knownCli } from "./knownCli.js";
import { analyzePush, parsePush, isGitRepo, recoverableSet, tryGit } from "./gitutil.js";

const SIM = "shell";
const BENIGN_CMDS = new Set(["ls", "pwd", "echo", "cat", "head", "tail", "wc", "file", "stat", "du", "df", "which", "whoami", "date", "uname", "grep", "rg", "sort", "uniq", "diff", "tree", "basename", "dirname", "true", "false", "printf", "id", "hostname", "cut", "tr", "less", "more", "realpath", "type"]);
const BENIGN_GIT = new Set(["status", "log", "diff", "show", "rev-parse", "ls-files", "blame", "describe", "shortlog", "ls-remote", "show-ref", "rev-list", "cat-file", "grep"]);
const PROD_BRANCH = /^(main|master|prod|production|release.*|stable|trunk)$/;

const f = (over: Partial<Finding> & Pick<Finding, "effect">, source: string, detail: string): Finding => ({
  simulator: SIM, tier: 1, severity: "info", reversibility: "reversible", evidenceIds: [],
  evidence: [{ tier: 1, source, detail }], ...over,
});

function projectRoot(a: Action): string { return a.context?.cwd ?? process.cwd(); }
function cmdOf(a: Action): string { return typeof a.action === "string" ? a.action : String((a.action as { command?: unknown }).command ?? ""); }

export function createShellSimulator(opts: { sandbox?: DockerSandbox } = {}): Simulator {
  return {
    id: SIM,
    canHandle: (a) => a.type === "shell",

    async analyze(a) {
      const cwd = projectRoot(a);
      const cmd = cmdOf(a);
      if (!cmd.trim()) return [f({ effect: "Empty command.", severity: "low", unverified: ["empty command"] }, "parser", "empty")];
      const { segments, dynamic } = parseCommand(cmd);
      const out: Finding[] = [];
      for (const d of dynamic)
        out.push(f({ effect: `Command uses ${d}, which cannot be resolved statically.`, severity: "medium", unverified: [`${d} not resolved`] }, "parser", `dynamic construct: ${d}`));
      let allBenign = segments.length > 0;
      for (const s of segments) {
        const fs = classifySegment(s, cwd);
        if (!fs.some((x) => x.benign)) allBenign = false;
        out.push(...fs);
      }
      // `safe` is only possible if EVERY segment is positively benign and nothing is dynamic.
      if (!allBenign || dynamic.length) for (const x of out) x.benign = false;
      return out;
    },

    async inspect(a, _ctx: ReadOnlyContext) {
      const cwd = projectRoot(a);
      const { segments } = parseCommand(cmdOf(a));
      const out: Finding[] = [];
      for (const s of segments) {
        if (basename(s.argv[0] ?? "") !== "git") continue;
        const g = splitGit(s.argv.slice(1), cwd);
        if (g.sub !== "push") continue;
        out.push(...pushFindings(g.cwd, g.rest));
      }
      return out;
    },

    async rehearse(a, sandbox: Sandbox) {
      const cwd = projectRoot(a);
      const cmd = cmdOf(a);
      const { segments, dynamic } = parseCommand(cmd);
      const out: Finding[] = [];
      if (segments.some((s) => basename(s.argv[0] ?? "") === "git" && splitGit(s.argv.slice(1), cwd).sub === "push")) return out; // never rehearse a push; Tier 2 reads the remote instead
      const touchesNet = segments.some((s) => ["curl", "wget", "ssh", "scp", "rsync"].includes(basename(s.argv[0] ?? "")) || (basename(s.argv[0] ?? "") === "git" && ["push", "pull", "fetch", "clone"].includes(splitGit(s.argv.slice(1), cwd).sub)));
      const allBenign = segments.every((s) => BENIGN_CMDS.has(basename(s.argv[0] ?? "")) && !writesOrExecs(basename(s.argv[0] ?? ""), s.argv.slice(1)) && !s.redirects.some((r) => r.op.startsWith(">")));
      if (allBenign && !dynamic.length) return out; // nothing to rehearse
      const ds = sandbox as DockerSandbox;
      if (!ds.copyProject) return out;
      const copy = ds.copyProject(cwd);
      if ("error" in copy) {
        return [f({ tier: 3, effect: "Sandbox rehearsal skipped.", severity: "low", unverified: [`rehearsal skipped: ${copy.error}`] }, "sandbox", copy.error)];
      }
      try {
        const res = await copy.run(cmd);
        const d = diffManifests(copy.before, copy.after());
        const real = (p: string) => !(p === ".git/" || p.startsWith(".git/"));
        const deleted = d.deleted.filter((x) => real(x.path) && !x.path.endsWith("/"));
        const modified = d.modified.filter((x) => real(x.path));
        const created = d.created.filter((x) => real(x.path));
        const repoGone = d.deleted.some((x) => x.path === ".git/");
        const rec = recoverableSet(cwd);
        const lostForever = (paths: string[]) => paths.filter((p) => !rec || !rec.tracked.has(p) || rec.dirty.has(p));
        // Original sizes for deleted files come from the "before" manifest.
        const sizeOf = (xs: Array<{ size: number }>) => xs.reduce((n, x) => n + x.size, 0);
        const env = { level: "local" as const, evidence: ["rehearsed on a disposable copy of the working directory"] };
        const ev = (detail: string) => [{ tier: 3 as const, source: "docker sandbox (--network none) + before/after content-hash diff", detail }];
        const unverified: string[] = [];
        if (res.timedOut) unverified.push("rehearsal timed out; effects may be incomplete");
        else if (res.code !== 0) unverified.push(`command exited ${res.code} in the sandbox (${res.stderr.trim().slice(0, 160)}); the real environment may behave differently`);
        if (touchesNet) unverified.push("command uses the network, which is disabled in the sandbox");
        if (!rec) unverified.push("not a git repository: deleted/modified files cannot be restored from version control");
        if (dynamic.length) unverified.push(...dynamic.map((x) => `${x} not resolved statically`));
        const gone = lostForever([...deleted, ...modified].map((x) => x.path));
        if (repoGone) out.push(f({ tier: 3, effect: "Deletes the .git directory: all local version history is lost.", severity: "critical", reversibility: "irreversible", env, blast: { files: 1 }, saferAlternative: "Do not delete .git; clone elsewhere if you need a clean tree.", evidence: ev("sandbox diff: .git/ removed") , evidenceIds: [] }, "", ""));
        if (deleted.length) {
          const lost = lostForever(deleted.map((x) => x.path));
          out.push(f({
            tier: 3,
            effect: `Deletes ${deleted.length} file(s) (${sizeOf(deleted)} bytes)${lost.length ? `; ${lost.length} cannot be restored from git` : "; all are tracked and unmodified"}.`,
            severity: lost.length ? "high" : "medium",
            reversibility: lost.length ? "irreversible" : "recoverable",
            recovery: lost.length ? undefined : "git checkout -- <paths>",
            env, blast: { files: deleted.length, bytes: sizeOf(deleted) }, unverified,
            saferAlternative: lost.length ? "Commit or back up the affected files first, or move them to a trash directory instead of deleting." : undefined,
            evidence: ev(`deleted: ${deleted.slice(0, 20).map((x) => x.path).join(", ")}${deleted.length > 20 ? ", …" : ""}`), evidenceIds: [],
          }, "", ""));
        }
        if (modified.length) {
          const lost = lostForever(modified.map((x) => x.path));
          out.push(f({
            tier: 3, effect: `Modifies ${modified.length} existing file(s)${lost.length ? `; ${lost.length} have changes that git cannot restore` : ""}.`,
            severity: lost.length ? "high" : "low", reversibility: lost.length ? "irreversible" : "recoverable",
            recovery: lost.length ? undefined : "git checkout -- <paths>", env, blast: { files: modified.length }, unverified: deleted.length ? undefined : unverified,
            evidence: ev(`modified: ${modified.slice(0, 20).map((x) => x.path).join(", ")}`), evidenceIds: [],
          }, "", ""));
        }
        if (created.length) out.push(f({ tier: 3, effect: `Creates ${created.length} new file(s) (${sizeOf(created)} bytes).`, severity: "low", reversibility: "reversible", env, blast: { files: created.length }, evidence: ev(`created: ${created.slice(0, 20).map((x) => x.path).join(", ")}`), evidenceIds: [] }, "", ""));
        if (!deleted.length && !modified.length && !created.length && !repoGone)
          out.push(f({ tier: 3, effect: "No file changes observed in the sandbox.", severity: "info", reversibility: "reversible", env, unverified, evidence: ev("sandbox diff empty"), evidenceIds: [] }, "", ""));
        void gone;
      } finally { copy.cleanup(); }
      return out;
    },
  };
}

function pushFindings(cwd: string, args: string[]): Finding[] {
  const ev = (detail: string) => [{ tier: 2 as const, source: "git fetch (read-only) into a throwaway bare repo", detail, readonlyCall: true }];
  if (!isGitRepo(cwd)) return [f({ tier: 2, effect: "Cannot analyze push: not a git repository.", severity: "medium", unverified: ["not a git repo"] }, "git", "rev-parse failed")];
  const spec = parsePush(args, cwd);
  const forceish = spec.force || spec.plusRefspec || spec.mirror || spec.delete;
  let an;
  try { an = analyzePush(cwd, spec); }
  catch (e) { return [f({ tier: 2, effect: "Could not read the remote to evaluate the push.", severity: "medium", unverified: [(e as Error).message], evidence: ev("fetch failed"), evidenceIds: [] }, "", "")]; }
  const branch = spec.dst?.replace(/^refs\/heads\//, "") ?? "?";
  const prod = PROD_BRANCH.test(branch);
  const env = prod
    ? { level: "production" as const, evidence: [`branch "${branch}" is a conventionally protected/default branch`] }
    : { level: "unknown" as const, evidence: [`branch "${branch}" not recognised as production or non-production`] };
  const unverified = ["branch protection and who else depends on this branch were not checked"];
  if (spec.delete) {
    return [f({ tier: 2, effect: `Deletes remote branch "${branch}"${an.remoteSha ? ` (tip ${an.remoteSha.slice(0, 8)}, ${an.lost.length} commit(s) not in your history)` : " (branch not found on remote)"}.`, severity: "high", reversibility: an.lost.every((c) => c.existsLocally) ? "recoverable" : "irreversible", recovery: `git push ${spec.remote} ${an.remoteSha}:refs/heads/${branch}`, env, blast: { people: new Set(an.lost.map((c) => c.email)).size }, unverified, evidence: ev(`remote tip ${an.remoteSha}`), evidenceIds: [], saferAlternative: "Archive the branch with a tag before deleting." }, "", "")];
  }
  if (an.lost.length === 0) {
    return [f({ tier: 2, effect: an.ahead ? `Pushes ${an.ahead} new commit(s) to ${spec.remote}/${branch}; no remote commits are overwritten${forceish ? " (force flag not needed)" : ""}.` : `Nothing new to push to ${spec.remote}/${branch}.`, severity: "low", reversibility: "recoverable", recovery: "git revert (the remote history is preserved)", env, unverified, evidence: ev(`remote ${an.remoteSha ?? "absent"} is an ancestor of local ${an.localSha}`), evidenceIds: [] }, "", "")];
  }
  const authors = new Map<string, number>();
  for (const c of an.lost) authors.set(c.author, (authors.get(c.author) ?? 0) + 1);
  const others = an.lost.filter((c) => c.email !== an.me);
  const allLocal = an.lost.every((c) => c.existsLocally);
  const list = an.lost.slice(0, 5).map((c) => `${c.sha.slice(0, 8)} "${c.subject}" (${c.author})`).join("; ");
  const base = {
    tier: 2 as const, env, unverified,
    blast: { people: new Set(an.lost.map((c) => c.email)).size },
    evidence: ev(`remote ${an.remoteSha} vs local ${an.localSha}: ${an.lost.length} commit(s) unreachable after push: ${list}`),
    evidenceIds: [] as string[],
  };
  if (!forceish) return [f({ ...base, effect: `Push would be rejected (non-fast-forward): ${an.lost.length} remote commit(s) are not in your history. Nothing would be lost.`, severity: "low", reversibility: "reversible", blast: undefined }, "", "")];
  return [f({
    ...base,
    effect: `Force push would erase ${an.lost.length} remote commit(s) by ${authors.size} author(s) (${[...authors].map(([n, c]) => `${n}: ${c}`).join(", ")}) on ${spec.remote}/${branch}: ${list}${an.lost.length > 5 ? ", …" : ""}.${spec.forceWithLease ? " (--force-with-lease only blocks this if the remote moved since your last fetch.)" : ""}`,
    severity: others.length ? "critical" : "high",
    reversibility: allLocal ? "recoverable" : "irreversible",
    recovery: allLocal ? `all lost commits exist in your local repo: git branch rescue ${an.lost[0]!.sha.slice(0, 8)}` : undefined,
    saferAlternative: `git pull --rebase ${spec.remote} ${branch} (or merge), then push without --force. If you must overwrite, record ${an.remoteSha?.slice(0, 8)} first and use --force-with-lease=${branch}:${an.remoteSha?.slice(0, 8)}.`,
  }, "", "")];
}

function classifySegment(s: Segment, cwd: string): Finding[] {
  const [cmdRaw, ...args] = s.argv;
  if (!cmdRaw) return redirectFindings(s, cwd);
  const cmd = basename(cmdRaw);
  const out: Finding[] = [];
  const src = `parsed: ${s.argv.join(" ")}`;
  const flags = args.filter((a) => a.startsWith("-"));
  const paths = args.filter((a) => !a.startsWith("-"));
  const hasFlag = (re: RegExp) => flags.some((x) => re.test(x));
  if (s.wrappers.includes("sudo") || s.wrappers.includes("doas"))
    out.push(f({ effect: "Runs with elevated privileges (sudo).", severity: "high", unverified: ["privileged execution cannot be rehearsed faithfully"] }, "parser", src));

  const pathCheck = (destructive: boolean, label: string) => {
    for (const p of paths) {
      const abs = expandPath(p, cwd);
      const why = sensitiveReason(abs, cwd);
      const outside = !isInside(abs, cwd);
      const catastrophic = abs === "/" || abs === homedir() || /^\/(etc|usr|bin|sbin|lib|var|boot|System|Library)$/.test(abs);
      if (destructive && catastrophic) out.push(f({ effect: `${label} targets ${why}.`, severity: "critical", reversibility: "irreversible", hardBlock: `${label} of ${why}.`, env: { level: "local", evidence: ["local filesystem"] }, blast: { files: 1 } }, "parser", `${abs}`));
      else if (destructive && outside) out.push(f({ effect: `${label} reaches outside the project: ${abs}${why ? ` (${why})` : ""}.`, severity: "high", reversibility: "irreversible", env: { level: "unknown", evidence: ["path outside the working directory"] }, blast: { files: 1 } }, "parser", abs));
      else if (!destructive && why) out.push(f({ effect: `Reads ${abs}, ${why}; its contents would enter the agent's context.`, severity: "medium", unverified: ["sensitive file read"] }, "parser", abs));
    }
  };

  if (cmd === "rm" || cmd === "rmdir" || cmd === "unlink" || cmd === "shred") {
    pathCheck(true, "Deletion");
    out.push(f({ effect: `${cmd}${hasFlag(/^-[a-zA-Z]*r|--recursive/) ? " (recursive)" : ""}: removes ${paths.length || "?"} path(s) from disk.`, severity: "medium", reversibility: "unknown", unverified: ["pending: exact set of deleted files not yet measured"] }, "parser", src));
  } else if (cmd === "mv") {
    // Only the sources are destroyed by a move; the destination may legitimately be ~ or /tmp.
    const srcs = paths.slice(0, -1), dest = paths[paths.length - 1];
    const saved = paths.splice(0, paths.length, ...srcs);
    void saved; pathCheck(true, "Move");
    if (dest) { const abs = expandPath(dest, cwd); if (!isInside(abs, cwd)) out.push(f({ effect: `mv writes outside the project: ${abs}; an existing file there would be overwritten.`, severity: "medium", reversibility: "unknown", env: { level: "unknown", evidence: ["destination outside the working directory"] }, unverified: ["overwritten files not measured"] }, "parser", abs)); }
    out.push(f({ effect: "mv relocates files and may overwrite existing ones.", severity: "low", reversibility: "unknown", unverified: ["pending: overwritten files not yet measured"] }, "parser", src));
  } else if (["cp", "ln", "install", "rsync"].includes(cmd)) {
    const dest = paths[paths.length - 1];
    if (dest) { const abs = expandPath(dest, cwd); if (!isInside(abs, cwd)) out.push(f({ effect: `${cmd} writes outside the project: ${abs}${sensitiveReason(abs, cwd) ? ` (${sensitiveReason(abs, cwd)})` : ""}; existing files there may be overwritten.`, severity: "medium", reversibility: "unknown", env: { level: "unknown", evidence: ["destination outside the working directory"] }, unverified: ["overwritten files not measured"] }, "parser", abs)); }
    if (cmd === "rsync" && flags.some((x) => /--delete/.test(x))) out.push(f({ effect: "rsync --delete removes files at the destination that are missing from the source.", severity: "high", reversibility: "irreversible", unverified: ["pending: deleted set not yet measured"] }, "parser", src));
    out.push(f({ effect: `${cmd} may overwrite existing files.`, severity: "low", reversibility: "unknown", unverified: ["pending: overwritten files not yet measured"] }, "parser", src));
  } else if (["chmod", "chown", "chgrp", "truncate", "dd", "mkfs", "fdisk", "diskutil", "tee", "touch", "mkdir", "sed", "perl", "awk"].includes(cmd) || cmd.startsWith("mkfs")) {
    const dangerous = ["dd", "mkfs", "fdisk", "diskutil"].includes(cmd) || cmd.startsWith("mkfs");
    if (cmd === "dd" || cmd.startsWith("mkfs")) out.push(f({ effect: `${cmd} can overwrite raw disks or files.`, severity: "critical", reversibility: "irreversible", hardBlock: dangerous && args.some((a) => /(^|=)\/dev\//.test(a)) ? `${cmd} targets a raw device.` : undefined, env: { level: "unknown", evidence: ["raw device access"] }, blast: { bytes: 1 } }, "parser", src));
    else { pathCheck(cmd !== "touch" && cmd !== "mkdir", cmd); out.push(f({ effect: `${cmd} modifies files or permissions.`, severity: "low", reversibility: "unknown", unverified: ["pending: effects not yet measured"] }, "parser", src)); }
  } else if (cmd === "find") {
    const risky = args.some((a) => ["-delete", "-exec", "-execdir", "-ok", "-fprint", "-fprintf"].includes(a));
    if (risky) out.push(f({ effect: "find with -delete/-exec acts on every match.", severity: "high", reversibility: "unknown", unverified: ["match set not measured"] }, "parser", src));
    else { pathCheck(false, "find"); out.push(f({ effect: "find (read-only listing).", benign: true }, "parser", src)); }
  } else if (cmd === "git") {
    out.push(...classifyGit(args, src, cwd));
  } else if (["npm", "pnpm", "yarn", "cargo", "twine", "gem", "docker"].includes(cmd) && /publish|upload|push|unpublish|deprecate/.test(args.join(" "))) {
    out.push(f({ effect: `${cmd} ${args[0] ?? ""} publishes to a public registry; published versions are generally permanent.`, severity: "high", reversibility: "irreversible", env: { level: "production", evidence: ["public registry"] }, unverified: ["package contents/version not inspected"], saferAlternative: `Run \`${cmd} publish --dry-run\` (where supported) and check the file list first.` }, "parser", src));
  } else if (knownCli(cmd, s.argv)) {
    const k = knownCli(cmd, s.argv)!;
    out.push(f({ effect: k.effect, severity: k.severity, reversibility: k.reversibility, saferAlternative: k.saferAlternative, env: { level: "unknown", evidence: ["target environment not inspected by the shell simulator"] }, unverified: ["target of the CLI call not inspected (use the matching dryrun subcommand)"] }, "parser", src));
  } else if (cmd === "curl" || cmd === "wget") {
    out.push(f({ effect: `${cmd} makes a network request${s.pipedToNext ? " piped into another command (possible remote code execution)" : ""}.`, severity: s.pipedToNext ? "high" : "medium", unverified: ["remote response and side effects unknown"] }, "parser", src));
  } else if (["eval", "source", ".", "xargs", "exec", "bash", "sh", "zsh", "node", "python", "python3", "ruby", "perl", "php", "deno", "bun", "make", "npx", "tsx"].includes(cmd) || /^\.?\.?\//.test(cmdRaw)) {
    out.push(f({ effect: `${cmd} runs code whose contents are not analyzed (it may call other commands).`, severity: "medium", reversibility: "unknown", unverified: [`${cmd}: script contents not statically analyzable`] }, "parser", src));
  } else if (BENIGN_CMDS.has(cmd) && !writesOrExecs(cmd, args)) {
    pathCheck(false, cmd);
    out.push(f({ effect: `${cmd}: read-only command.`, benign: true }, "parser", src));
  } else {
    out.push(f({ effect: `Unknown command "${cmd}".`, severity: "low", reversibility: "unknown", unverified: [`command "${cmd}" is not in the classification table`] }, "parser", src));
  }
  out.push(...redirectFindings(s, cwd));
  // An unclassified-benign finding is only valid if nothing else in this segment objects.
  if (out.some((x) => !x.benign)) for (const x of out) x.benign = false;
  return out;
}

function redirectFindings(s: Segment, cwd: string): Finding[] {
  const out: Finding[] = [];
  for (const r of s.redirects) {
    if (!r.op.startsWith(">") && r.op !== "&>") continue;
    if (!r.target || r.target === "/dev/null") continue;
    const abs = expandPath(r.target, cwd);
    out.push(f({ effect: `Redirect writes (${r.op}) to ${abs}${isInside(abs, cwd) ? "" : " (outside the project)"}${r.op === ">" ? ", overwriting existing content" : ""}.`, severity: isInside(abs, cwd) ? "low" : "high", reversibility: "unknown", env: { level: isInside(abs, cwd) ? "local" : "unknown", evidence: ["redirect target"] }, unverified: ["overwritten content not measured"] }, "parser", `${r.op} ${abs}`));
  }
  return out;
}

function classifyGit(args: string[], src: string, cwd: string): Finding[] {
  const g = splitGit(args, cwd);
  const sub = g.sub, rest = g.rest;
  const flags = rest.filter((a) => a.startsWith("-"));
  const out: Finding[] = [];
  const unv = (msg: string) => [msg];
  if (g.configOverrides.length) out.push(f({ effect: `git -c ${g.configOverrides.join(" -c ")} overrides configuration for this call (aliases, pagers, hooks and credential helpers can execute programs).`, severity: "medium", reversibility: "unknown", unverified: unv("git -c config override may run arbitrary programs") }, "parser", src));
  const writesFile = flags.some((x) => /^--output(=|$)|^-o$/.test(x)) && !["ls-files", "show-ref", "rev-list"].includes(sub) || flags.some((x) => /^--(ext-diff|textconv)$/.test(x));
  if (!g.configOverrides.length && !writesFile && (BENIGN_GIT.has(sub) || (sub === "branch" && !flags.some((x) => /^-[a-zA-Z]*[dDmMcCu]|--(delete|move|copy|set-upstream)/.test(x)) && rest.filter((a) => !a.startsWith("-")).length === 0) ||
      (sub === "remote" && (rest[0] === "-v" || rest.length === 0 || rest[0] === "get-url")) || (sub === "config" && flags.includes("--get"))))
    return [f({ effect: `git ${sub}: read-only.`, benign: true }, "parser", src)];
  if (writesFile) return [f({ effect: `git ${sub} with ${flags.find((x) => /output|ext-diff|textconv/.test(x))} writes a file or runs an external program.`, severity: "medium", reversibility: "unknown", unverified: unv("git output/external-program flag writes or executes") }, "parser", src)];
  switch (sub) {
    case "push": {
      const force = flags.some((x) => x === "--force" || x === "-f" || /^--force-with-lease/.test(x) || /^-[a-zA-Z]*f/.test(x) || x === "--mirror" || x === "--delete" || x === "-d") || rest.some((a) => a.startsWith("+") || a.startsWith(":"));
      out.push(f({ effect: force ? "git push with force/delete semantics: rewrites or removes remote history." : "git push publishes commits to a remote.", severity: force ? "high" : "medium", reversibility: force ? "unknown" : "recoverable", recovery: force ? undefined : "git revert", env: { level: "unknown", evidence: ["pending: remote not yet inspected"] }, unverified: unv("pending: remote state not inspected (needs Tier 2)") }, "parser", src));
      break;
    }
    case "reset": if (flags.includes("--hard")) out.push(f({ effect: "git reset --hard discards uncommitted changes in tracked files.", severity: "high", reversibility: "unknown", unverified: unv("pending: uncommitted changes not yet measured") }, "parser", src)); else out.push(f({ effect: "git reset moves HEAD/index; working files kept.", severity: "low", reversibility: "recoverable", recovery: "git reflog", unverified: unv("not rehearsed") }, "parser", src)); break;
    case "clean": out.push(f({ effect: "git clean permanently deletes untracked files (they are not in git).", severity: "high", reversibility: "irreversible", env: { level: "local", evidence: ["local filesystem"] }, unverified: unv("pending: set of untracked files not yet measured") }, "parser", src)); break;
    case "checkout": case "restore": case "switch": out.push(f({ effect: `git ${sub} can overwrite uncommitted working-tree changes.`, severity: "medium", reversibility: "unknown", unverified: unv("pending: uncommitted changes not yet measured") }, "parser", src)); break;
    case "branch": out.push(f({ effect: "git branch -d/-D/-m changes or deletes local branches.", severity: "medium", reversibility: "recoverable", recovery: "git reflog", unverified: unv("not rehearsed") }, "parser", src)); break;
    case "stash": out.push(f({ effect: `git stash ${rest[0] ?? "push"} ${/drop|clear/.test(rest[0] ?? "") ? "permanently discards stashed work" : "moves changes into the stash"}.`, severity: /drop|clear/.test(rest[0] ?? "") ? "high" : "low", reversibility: /drop|clear/.test(rest[0] ?? "") ? "unknown" : "recoverable", unverified: unv("not rehearsed") }, "parser", src)); break;
    case "rebase": case "filter-branch": case "filter-repo": case "gc": case "reflog": case "prune": out.push(f({ effect: `git ${sub} rewrites history${sub === "gc" || sub === "prune" || sub === "reflog" ? " / removes unreachable objects" : ""}.`, severity: "high", reversibility: "unknown", unverified: unv("not rehearsed") }, "parser", src)); break;
    default: out.push(f({ effect: `git ${sub || "(none)"}: not in the classification table.`, severity: "low", reversibility: "unknown", unverified: unv(`git ${sub} not classified`) }, "parser", src));
  }
  return out;
}

void statSync; void tryGit; void join;
export { createDockerSandbox };

/** Read-only-looking commands that nevertheless write files or execute programs with certain flags. */
function writesOrExecs(cmd: string, args: string[]): boolean {
  const flags = args.filter((a) => a.startsWith("-")), pos = args.filter((a) => !a.startsWith("-"));
  switch (cmd) {
    case "sort": return flags.some((x) => /^(-[a-zA-Z]*o|--output)/.test(x));
    case "uniq": return pos.length >= 2;
    case "tree": return flags.some((x) => /^-[a-zA-Z]*o/.test(x));
    case "rg": case "grep": return flags.some((x) => /^--(pre|hostname-bin|pre-glob)/.test(x));
    case "hostname": return pos.length > 0 || flags.some((x) => /^-[a-zA-Z]*F|--file/.test(x));
    case "date": return flags.some((x) => /^(-s|--set)/.test(x)) || (pos.length > 0 && /^\d{8,}/.test(pos[0] ?? "") && !pos[0]!.startsWith("+"));
    case "less": case "more": return false;
    case "file": return flags.includes("-C");
    default: return false;
  }
}
