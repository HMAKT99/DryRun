import { parse, type ParseEntry } from "shell-quote";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, relative, sep } from "node:path";

export interface Segment {
  /** argv after unwrapping sudo/env/nohup/etc. */
  argv: string[];
  wrappers: string[];
  redirects: Array<{ op: string; target?: string }>;
  /** Connected to the next segment with a pipe. */
  pipedToNext: boolean;
}

export interface Parsed {
  segments: Segment[];
  /** Constructs we cannot statically resolve. Each one prevents `safe`. */
  dynamic: string[];
}

const WRAPPERS = new Set(["sudo", "doas", "env", "nohup", "time", "command", "nice", "exec", "builtin"]);
const REDIR = new Set([">", ">>", ">|", "<", "<<", "<<<", ">&", "<&", "&>"]);

export function parseCommand(cmd: string, depth = 0): Parsed {
  const dynamic: string[] = [];
  const home = homedir();
  // Resolve $HOME / ${HOME} statically; anything else dynamic is flagged.
  let src = cmd.replace(/\$\{HOME\}|\$HOME\b/g, home);
  if (/\$\(|`/.test(src)) dynamic.push("command substitution");
  if (/\$\{|\$[A-Za-z_]/.test(src.replace(/'[^']*'/g, ""))) dynamic.push("shell variable expansion");
  if (/<\(|>\(/.test(src)) dynamic.push("process substitution");
  if (/<<-?\s*['"]?\w+/.test(src)) dynamic.push("heredoc");
  if (/\bfor\b[^;]*\bin\b|\bwhile\b|\buntil\b|\bif\b[^;]*\bthen\b|\bfunction\b|\(\)\s*\{/.test(src)) dynamic.push("shell control flow / functions");
  if (/[*?\[]/.test(src.replace(/'[^']*'|"[^"]*"/g, ""))) dynamic.push("glob expansion (set of matched files not resolved)");

  const tokens = parse(src, (k) => `$${k}`) as ParseEntry[];
  const segments: Segment[] = [];
  let cur: string[] = [];
  let redirects: Segment["redirects"] = [];
  const flush = (piped: boolean) => {
    if (cur.length || redirects.length) segments.push(finish(cur, redirects, piped));
    cur = []; redirects = [];
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (typeof t === "string") { cur.push(t); continue; }
    if ("comment" in t) continue;
    if ("op" in t) {
      const op = t.op;
      if (op === "glob") { cur.push((t as { pattern: string }).pattern); continue; }
      if (REDIR.has(op)) {
        const next = tokens[i + 1];
        redirects.push({ op, target: typeof next === "string" ? next : undefined });
        if (typeof next === "string") i++;
        continue;
      }
      if (op === "|" || op === "|&") flush(true);
      else if (op === ";" || op === "&&" || op === "||" || op === "&") flush(false);
      else if (op === "(" || op === ")") dynamic.push("subshell");
      else dynamic.push(`operator ${op}`);
    }
  }
  flush(false);

  // Recurse into `sh -c "<cmd>"` and friends (bounded depth).
  const out: Segment[] = [];
  for (const s of segments) {
    const [c, ...rest] = s.argv;
    if (c && /^(ba|z|da|k)?sh$/.test(basename(c)) && rest[0] === "-c" && rest[1]) {
      if (depth >= 3) dynamic.push("deeply nested shell -c");
      else { const inner = parseCommand(rest[1], depth + 1); out.push(...inner.segments); dynamic.push(...inner.dynamic); }
      out.push({ ...s, argv: [c, "-c"] }); // keep the wrapper visible
    } else out.push(s);
  }
  return { segments: out, dynamic: [...new Set(dynamic)] };
}

function finish(argv: string[], redirects: Segment["redirects"], piped: boolean): Segment {
  const wrappers: string[] = [];
  let a = [...argv];
  for (;;) {
    while (a[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(a[0])) { wrappers.push(`env:${a[0]!.split("=")[0]}`); a.shift(); }
    const h = a[0];
    if (h && WRAPPERS.has(basename(h))) {
      wrappers.push(basename(h)); a.shift();
      // skip wrapper flags (e.g. sudo -u root)
      while (a[0]?.startsWith("-")) a.shift();
      continue;
    }
    break;
  }
  return { argv: a, wrappers, redirects, pipedToNext: piped };
}

export const basename = (p: string) => p.split("/").pop() ?? p;

export function expandPath(p: string, cwd: string): string {
  const home = homedir();
  let q = p;
  if (q === "~") q = home; else if (q.startsWith("~/")) q = join(home, q.slice(2));
  return normalize(isAbsolute(q) ? q : join(cwd, q));
}

export function isInside(path: string, root: string): boolean {
  const r = relative(root, path);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
}

export const SENSITIVE_DIRS = [".ssh", ".aws", ".gnupg", ".config/gcloud", ".kube", ".docker", ".npmrc", ".netrc", ".git-credentials"];
export function sensitiveReason(abs: string): string | undefined {
  const home = homedir();
  if (abs === "/") return "the filesystem root";
  if (abs === home) return "your home directory";
  for (const d of SENSITIVE_DIRS) if (isInside(abs, join(home, d))) return `~/${d} (credentials)`;
  if (/^\/(etc|usr|bin|sbin|lib|var|boot|System|Library|Applications)(\/|$)/.test(abs)) return "a system directory";
  if (/(^|\/)\.env(\.[\w.-]+)?$/.test(abs)) return "an environment file that may contain secrets";
  if (/(^|\/)(id_rsa|id_ed25519|credentials|\.pem)$|\.pem$|\.p12$|\.key$/.test(abs)) return "a private key / credential file";
  return undefined;
}
void sep;
