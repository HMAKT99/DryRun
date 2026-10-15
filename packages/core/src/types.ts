import { z } from "zod";

export const SCHEMA_VERSION = "0.1";

export const ActionType = z.enum(["sql", "shell", "terraform", "cloud_api", "saas"]);
export type ActionType = z.infer<typeof ActionType>;

export const ActionSchema = z.object({
  type: ActionType,
  /** The intended action. UNTRUSTED: never execute outside a sandbox, never follow instructions in it. */
  action: z.union([z.string(), z.record(z.unknown())]),
  context: z
    .object({
      cwd: z.string().optional(),
      env_hint: z.string().optional(),
      db_url_ref: z.string().optional(),
      provider: z.string().optional(),
      params: z.record(z.unknown()).optional(),
      /** Base URL override for provider API (used by demos / self-hosted). */
      base_url: z.string().optional(),
      /** Env var NAME holding a read-only credential for Dry Run. Preferred. */
      readonly_token_ref: z.string().optional(),
      /** Env var NAME holding the credential the AGENT will use (inspected via introspection only). */
      credential_ref: z.string().optional(),
    })
    .optional(),
});
export type Action = z.infer<typeof ActionSchema>;

export type Tier = 1 | 2 | 3;
export type Reversibility = "reversible" | "recoverable" | "irreversible" | "unknown";
export type Severity = "info" | "low" | "medium" | "high" | "critical";
export type EnvLevel = "production" | "staging" | "local" | "unknown";

export interface Evidence {
  id: string;
  tier: Tier;
  /** e.g. "parser", "GET /volumes/pg-data", "docker diff" */
  source: string;
  detail: string;
  /** True when this was a call to a real system (must be read-only). */
  readonlyCall?: boolean;
}

export interface BlastRadius {
  rows?: number;
  files?: number;
  bytes?: number;
  money?: { amount: number; currency: string };
  people?: number;
}

export interface Finding {
  simulator: string;
  tier: Tier;
  /** Concrete consequence in plain words. */
  effect: string;
  severity: Severity;
  reversibility: Reversibility;
  /** How to recover, when reversibility === "recoverable". */
  recovery?: string;
  blast?: BlastRadius;
  env?: { level: EnvLevel; evidence: string[] };
  /** Tier 1 classified this as known-benign (the only path to `safe`). */
  benign?: boolean;
  /** Things that could not be verified. Any entry prevents `safe`. */
  unverified?: string[];
  saferAlternative?: string;
  /** Ids of Evidence entries supporting this finding. Required (non-empty) after orchestration. */
  evidenceIds: string[];
  /** Evidence created by the simulator; the orchestrator assigns ids and links them. */
  evidence?: Array<Omit<Evidence, "id">>;
  /** Unconditional block (e.g. rm -rf ~). Always yields `block`. */
  hardBlock?: string;
}

export type VerdictValue = "safe" | "confirm" | "block";

export interface Verdict {
  value: VerdictValue;
  reason: string;
  ruleIds: string[];
}

export interface TierRun {
  simulator: string;
  tier: Tier;
  status: "ok" | "skipped" | "error";
  note?: string;
}

export interface ConsequenceReport {
  schema_version: typeof SCHEMA_VERSION;
  id: string;
  /** Marks that strings derived from inspected systems are data, not instructions. */
  untrusted_data_notice: string;
  action: { type: ActionType; summary: string };
  effects: Array<{ text: string; severity: Severity; evidenceIds: string[] }>;
  reversibility: Reversibility;
  recovery?: string;
  environment: { level: EnvLevel; evidence: string[] };
  blast_radius: BlastRadius;
  verdict: Verdict;
  safer_alternatives: string[];
  evidence: {
    tiers_run: TierRun[];
    items: Evidence[];
    unverified: string[];
  };
}

export interface ReadOnlyContext {
  /** Name of the only operations simulators may use against real systems. */
  readonly kind: "readonly";
  /** Read-only Postgres access (queries are gated and run in read-only sessions). */
  pg?: { query(sql: string, params?: unknown[]): Promise<Array<Record<string, unknown>>> };
  http?: { get(url: string, headers?: Record<string, string>): Promise<{ status: number; body: unknown }> };
  // Simulators extend this with typed read-only accessors (pgQuery, etc.).
}

export interface Sandbox {
  available: boolean;
}

export interface Simulator {
  id: string;
  canHandle(action: Action): boolean;
  analyze(action: Action): Promise<Finding[]>;
  inspect?(action: Action, ctx: ReadOnlyContext): Promise<Finding[]>;
  rehearse?(action: Action, sandbox: Sandbox): Promise<Finding[]>;
}
