import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, lstatSync, readFileSync, rmSync, existsSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { Sandbox } from "./types.js";

export const SANDBOX_IMAGE = process.env.DRYRUN_SANDBOX_IMAGE ?? "alpine/git:latest";

export function dockerAvailable(): boolean {
  const r = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 8000 });
  return r.status === 0;
}

export function imagePresent(image: string = SANDBOX_IMAGE): boolean {
  return spawnSync("docker", ["image", "inspect", image], { timeout: 8000 }).status === 0;
}

export interface DockerSandbox extends Sandbox {
  /** Copies `srcDir` (symlinks preserved, not followed) into a throwaway dir, within limits. */
  copyProject(srcDir: string, limits?: { maxBytes?: number; maxFiles?: number }): SandboxCopy | { error: string };
}
export interface SandboxCopy {
  dir: string;
  before: Manifest;
  /** Runs `sh -c command` in an isolated container against the copy. */
  run(command: string, opts?: { timeoutMs?: number }): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>;
  after(): Manifest;
  cleanup(): void;
}

export type Manifest = Map<string, { size: number; hash: string; mode: number; link?: string }>;

export function manifest(root: string): Manifest {
  const m: Manifest = new Map();
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = lstatSync(p);
      const rel = relative(root, p);
      if (st.isSymbolicLink()) { m.set(rel, { size: 0, hash: "symlink", mode: st.mode }); continue; }
      if (st.isDirectory()) { m.set(rel + "/", { size: 0, hash: "dir", mode: st.mode }); walk(p); continue; }
      if (st.isFile()) m.set(rel, { size: st.size, hash: createHash("sha256").update(readFileSync(p)).digest("hex"), mode: st.mode });
    }
  };
  walk(root);
  return m;
}

export interface Diff {
  deleted: Array<{ path: string; size: number }>;
  modified: Array<{ path: string; size: number }>;
  created: Array<{ path: string; size: number }>;
}
export function diffManifests(before: Manifest, after: Manifest): Diff {
  const d: Diff = { deleted: [], modified: [], created: [] };
  for (const [p, b] of before) {
    const a = after.get(p);
    if (p.endsWith("/")) { if (!a) d.deleted.push({ path: p, size: 0 }); continue; }
    if (!a) d.deleted.push({ path: p, size: b.size });
    else if (a.hash !== b.hash || a.mode !== b.mode) d.modified.push({ path: p, size: a.size });
  }
  for (const [p, a] of after) if (!before.has(p) && !p.endsWith("/")) d.created.push({ path: p, size: a.size });
  return d;
}

/** Walks the tree but stops as soon as a limit is exceeded, so a huge directory (e.g. $HOME) cannot hang the check. */
function measure(dir: string, maxBytes: number, maxFiles: number): { bytes: number; files: number; exceeded?: string } {
  let bytes = 0, files = 0; let exceeded: string | undefined;
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      if (exceeded) return;
      const p = join(d, n); const st = lstatSync(p);
      if (st.isDirectory()) walk(p); else { files++; bytes += st.size; }
      if (bytes > maxBytes) exceeded = `project is over ${maxBytes} bytes`;
      else if (files > maxFiles) exceeded = `project has over ${maxFiles} files`;
    }
  };
  try { walk(dir); } catch (e) { exceeded = `cannot read project: ${(e as Error).message.slice(0, 80)}`; }
  return { bytes, files, exceeded };
}

export function createDockerSandbox(): DockerSandbox {
  const daemon = dockerAvailable();
  const image = daemon && imagePresent();
  const available = daemon && image;
  const reason = available ? undefined : !daemon ? "Docker daemon is not reachable (start Docker, or install it; Windows: use WSL2)" : `sandbox image ${SANDBOX_IMAGE} is not pulled (run: docker pull ${SANDBOX_IMAGE})`;
  return {
    available, reason,
    copyProject(srcDir, limits = {}) {
      const m = measure(srcDir, limits.maxBytes ?? 200e6, limits.maxFiles ?? 50_000);
      if (m.exceeded) return { error: `${m.exceeded} (copy limit); Tier 3 skipped` };
      const dir = mkdtempSync(join(tmpdir(), "dryrun-"));
      cpSync(srcDir, dir, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
      const before = manifest(dir);
      const name = "dryrun-" + randomBytes(6).toString("hex");
      return {
        dir,
        before,
        run: (command, opts = {}) =>
          new Promise((resolve) => {
            const uid = process.getuid?.() ?? 1000, gid = process.getgid?.() ?? 1000;
            const args = [
              "run", "--rm", "--name", name,
              "--network", "none", "--cpus", "1", "--memory", "512m", "--memory-swap", "512m", "--pids-limit", "256",
              "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", `${uid}:${gid}`,
              "--read-only", "--tmpfs", "/tmp:rw,size=64m", "-e", "HOME=/tmp", "-e", "GIT_CONFIG_NOSYSTEM=1",
              "-v", `${dir}:/work:rw`, "-w", "/work",
              "--entrypoint", "sh", SANDBOX_IMAGE, "-c", command,
            ];
            const p = spawn("docker", args);
            let stdout = "", stderr = "", timedOut = false;
            p.stdout.on("data", (b) => { if (stdout.length < 20_000) stdout += b; });
            p.stderr.on("data", (b) => { if (stderr.length < 20_000) stderr += b; });
            const timer = setTimeout(() => { timedOut = true; spawnSync("docker", ["kill", name]); }, opts.timeoutMs ?? 20_000);
            p.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
            p.on("error", () => { clearTimeout(timer); resolve({ code: null, stdout, stderr: stderr + "docker failed to start", timedOut }); });
          }),
        after: () => manifest(dir),
        cleanup: () => { spawnSync("docker", ["rm", "-f", name]); if (existsSync(dir)) rmSync(dir, { recursive: true, force: true }); },
      };
    },
  };
}
