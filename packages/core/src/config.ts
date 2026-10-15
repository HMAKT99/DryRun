import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export const ConfigSchema = z.object({
  thresholds: z
    .object({
      /** Rows affected at/above which an irreversible action is blocked. */
      blockRows: z.number().default(1000),
      blockBytes: z.number().default(1_000_000_000),
      blockMoney: z.number().default(10_000),
      /** People notified/affected at/above which an irreversible action is blocked. */
      blockPeople: z.number().default(1000),
      /** Anything above these requires confirmation even if reversible. */
      confirmRows: z.number().default(1),
      confirmFiles: z.number().default(10),
      confirmMoney: z.number().default(1),
      confirmRecipients: z.number().default(50),
    })
    .default({}),
  /** Block irreversible+data-bearing actions whose environment is unknown. */
  blockUnknownEnvIrreversible: z.boolean().default(true),
});
export type Config = z.infer<typeof ConfigSchema>;

export function defaultConfig(): Config {
  return ConfigSchema.parse({});
}

export function loadConfig(dir: string = process.cwd()): Config {
  const p = join(dir, "dryrun.config.json");
  if (!existsSync(p)) return defaultConfig();
  // Invalid config must fail loudly: silently falling back could loosen thresholds.
  return ConfigSchema.parse(JSON.parse(readFileSync(p, "utf8")));
}
