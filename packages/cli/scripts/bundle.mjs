import { build } from "esbuild";
import { readFileSync as rf } from "node:fs";
const VERSION = JSON.parse(rf("package.json", "utf8")).version;
import { cpSync, rmSync, mkdirSync, chmodSync } from "node:fs";
rmSync("dist", { recursive: true, force: true }); mkdirSync("dist", { recursive: true });
await build({
  entryPoints: ["src/main.ts"], outfile: "dist/dryrun.mjs", bundle: true, platform: "node", format: "esm", target: "node22",
  external: ["@resvg/resvg-js", "pg-native"],
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  define: { "process.env.DRYRUN_VERSION": JSON.stringify(VERSION) },
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
  .replace(/Published on npm as \[`dry-run-agents`\][^\n]*\n\n/, "")
  .replace(/\]\((LICENSE|SECURITY\.md|CHANGELOG\.md)\)/g, `](${BLOB}$1)`)
  .replace(/\]\(docs\/DECISIONS\.md\)/g, `](${BLOB}docs/DECISIONS.md)`);
writeFileSync("README.md", readme);
copyFileSync("../../LICENSE", "LICENSE");
