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
