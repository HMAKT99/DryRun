import type { Action, Simulator, Finding, ReadOnlyContext } from "@dryrun/core";
import { defaultConfig, type Config } from "@dryrun/core";
import { normalize, mk } from "./common.js";
import { stripeTier1, stripeTier2 } from "./stripe.js";
import { emailAnalyze } from "./email.js";
import { slackTier1, slackTier2 } from "./slack.js";
import { githubTier1, githubTier2 } from "./github.js";

export * from "./common.js";
export { keyMode, MAX_LOOKUPS } from "./stripe.js";
export const SAAS_SERVICES = ["stripe", "email", "slack", "github"] as const;

export function createSaasSimulator(opts: { env?: NodeJS.ProcessEnv; config?: Config } = {}): Simulator {
  const env = opts.env ?? process.env;
  const cfg = opts.config ?? defaultConfig();
  return {
    id: "saas",
    canHandle: (a) => a.type === "saas",
    async analyze(a: Action): Promise<Finding[]> {
      const r = normalize(a);
      switch (r.service) {
        case "stripe": return stripeTier1(r, a, env);
        case "email": return emailAnalyze(r, a, cfg.thresholds.confirmRecipients);
        case "slack": return slackTier1(r);
        case "github": return githubTier1(r);
        default: return [mk({ effect: `SaaS service "${r.service}" is not supported (supported: ${SAAS_SERVICES.join(", ")}).`, severity: "medium", reversibility: "unknown", unverified: [`service ${r.service} unsupported`] }, "dispatch", r.service)];
      }
    },
    async inspect(a: Action, ctx: ReadOnlyContext): Promise<Finding[]> {
      const r = normalize(a);
      switch (r.service) {
        case "stripe": return stripeTier2(r, a, ctx, env);
        case "slack": return slackTier2(r, a, ctx, env, cfg.thresholds.blockPeople);
        case "github": return githubTier2(r, a, ctx, env);
        default: return [];
      }
    },
  };
}
