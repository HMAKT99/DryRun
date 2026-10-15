import { build } from "esbuild";
import { cpSync, rmSync, mkdirSync, chmodSync } from "node:fs";
rmSync("dist", { recursive: true, force: true }); mkdirSync("dist", { recursive: true });
await build({
  entryPoints: ["src/main.ts"], outfile: "dist/dryrun.mjs", bundle: true, platform: "node", format: "esm", target: "node22",
  external: ["@resvg/resvg-js", "pg-native"],
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: "info",
});
cpSync("../sim-cloud/catalog", "dist/catalog", { recursive: true });
chmodSync("dist/dryrun.mjs", 0o755);

// Package docs: npm renders README from the tarball, so rewrite repo-relative links to absolute GitHub URLs.
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
const RAW = "https://raw.githubusercontent.com/HMAKT99/DryRun/main/", BLOB = "https://github.com/HMAKT99/DryRun/blob/main/";
const readme = readFileSync("../../README.md", "utf8")
  .replace(/\]\((docs\/assets\/[^)]+)\)/g, `](${RAW}$1)`)
  .replace(/\]\(((?:docs\/|CONTRIBUTING)[^)]+)\)/g, `](${BLOB}$1)`)
  .replace(/`dry-run-agents` is not yet published to npm\.[^\n]*\n\n/, "");
writeFileSync("README.md", readme);
copyFileSync("../../LICENSE", "LICENSE");
