import { build } from "esbuild";
await build({ entryPoints: ["src/templates.ts"], outfile: "dist-templates.mjs", bundle: true, platform: "node", format: "esm", logLevel: "error" });
