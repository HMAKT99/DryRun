import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Action, Finding, Simulator } from "@dryrun/core";
import { redact } from "@dryrun/core";

const SIM = "terraform";

/** Resource types that hold data. Extend via PR. `backupsInside`: automated backups are part of the resource and die with it. */
export const DATA_BEARING: Record<string, { kind: string; backupsInside?: boolean; sizeKey?: string; sizeUnit?: number }> = {
  aws_db_instance: { kind: "database", backupsInside: true, sizeKey: "allocated_storage", sizeUnit: 1e9 },
  aws_rds_cluster: { kind: "database cluster", backupsInside: true },
  aws_rds_cluster_instance: { kind: "database instance" },
  aws_ebs_volume: { kind: "disk volume", sizeKey: "size", sizeUnit: 1e9 },
  aws_efs_file_system: { kind: "file system" },
  aws_s3_bucket: { kind: "object storage bucket" },
  aws_dynamodb_table: { kind: "NoSQL table", backupsInside: true },
  aws_elasticache_replication_group: { kind: "cache/data store" },
  aws_opensearch_domain: { kind: "search cluster" },
  aws_kms_key: { kind: "encryption key (data encrypted with it becomes unreadable)" },
  google_sql_database_instance: { kind: "database", backupsInside: true },
  google_storage_bucket: { kind: "object storage bucket" },
  google_compute_disk: { kind: "disk volume", sizeKey: "size", sizeUnit: 1e9 },
  azurerm_mssql_database: { kind: "database" },
  azurerm_postgresql_flexible_server: { kind: "database", backupsInside: true },
  azurerm_storage_account: { kind: "storage account" },
  azurerm_managed_disk: { kind: "disk volume", sizeKey: "disk_size_gb", sizeUnit: 1e9 },
  digitalocean_database_cluster: { kind: "database", backupsInside: true },
  digitalocean_volume: { kind: "disk volume", sizeKey: "size", sizeUnit: 1e9 },
  kubernetes_persistent_volume_claim: { kind: "persistent volume" },
  kubernetes_namespace: { kind: "namespace (contains workloads and data)" },
  railway_volume: { kind: "disk volume" },
  random_password: { kind: "generated secret" },
  tls_private_key: { kind: "private key" },
};

interface RC { address: string; type: string; name?: string; provider_name?: string; change: { actions: string[]; before?: Record<string, unknown> | null; after?: Record<string, unknown> | null } }

function load(a: Action): { plan?: { resource_changes?: RC[] }; error?: string } {
  const raw = a.action;
  if (typeof raw === "object") return { plan: raw as never };
  const p = raw.trim();
  if (p.startsWith("{")) { try { return { plan: JSON.parse(p) }; } catch (e) { return { error: `invalid plan JSON: ${(e as Error).message}` }; } }
  const base = a.context?.cwd ?? process.cwd();
  let file = p.startsWith("/") ? p : join(base, p);
  try {
    if (existsSync(file) && statSync(file).isDirectory()) {
      const cand = ["plan.json", "tfplan.json", "plan.out.json"].map((n) => join(file, n)).find(existsSync);
      if (!cand) return { error: `no plan.json in ${p}. Run: terraform plan -out=tfplan && terraform show -json tfplan > plan.json (Dry Run never runs terraform itself)` };
      file = cand;
    }
    return { plan: JSON.parse(readFileSync(file, "utf8")) };
  } catch (e) { return { error: `cannot read plan: ${(e as Error).message}` }; }
}

const prodish = (s: unknown) => typeof s === "string" && /(^|[\s\-_.\/])(prod|production|live|prd)([\s\-_.\/]|$)/i.test(s);
const nonprod = (s: unknown) => typeof s === "string" && /(^|[\s\-_.\/])(dev|development|staging|stage|test|qa|sandbox)([\s\-_.\/]|$)/i.test(s);

function envOf(rc: RC): { level: "production" | "staging" | "unknown"; evidence: string[] } {
  const b = (rc.change.before ?? rc.change.after ?? {}) as Record<string, unknown>;
  const tags = { ...((b["tags"] as Record<string, unknown>) ?? {}), ...((b["labels"] as Record<string, unknown>) ?? {}) };
  const ev: string[] = []; let prod = false, non = false;
  for (const [k, v] of Object.entries(tags)) { if (/env|stage|tier/i.test(k)) { if (prodish(v)) { prod = true; ev.push(`tag ${k}=${String(v)}`); } else if (nonprod(v)) { non = true; ev.push(`tag ${k}=${String(v)}`); } } }
  for (const key of ["identifier", "name", "bucket", "db_name", "id"]) if (prodish(b[key])) { prod = true; ev.push(`${key}="${String(b[key])}"`); } else if (nonprod(b[key])) { non = true; ev.push(`${key}="${String(b[key])}"`); }
  if (prodish(rc.address)) { prod = true; ev.push(`resource address ${rc.address}`); }
  if (b["deletion_protection"] === true) ev.push("deletion_protection=true");
  return prod ? { level: "production", evidence: ev } : non ? { level: "staging", evidence: ev } : { level: "unknown", evidence: ev.length ? ev : ["no environment tag or name marker"] };
}

export function createTerraformSimulator(): Simulator {
  return {
    id: SIM,
    canHandle: (a) => a.type === "terraform",
    async analyze(a) {
      const { plan, error } = load(a);
      const mk = (over: Partial<Finding> & Pick<Finding, "effect">, d: string): Finding => ({ simulator: SIM, tier: 1, severity: "info", reversibility: "reversible", evidenceIds: [], evidence: [{ tier: 1, source: "terraform plan JSON", detail: d }], ...over });
      if (error || !plan) return [mk({ effect: "Terraform plan could not be read.", severity: "medium", reversibility: "unknown", unverified: [error ?? "no plan"] }, error ?? "no plan")];
      const rcs = plan.resource_changes;
      if (!Array.isArray(rcs)) return [mk({ effect: "Input does not look like `terraform show -json` output (no resource_changes).", severity: "medium", reversibility: "unknown", unverified: ["plan format not recognized"] }, "missing resource_changes")];
      const out: Finding[] = [];
      let creates = 0, updates = 0;
      for (const rc of rcs) {
        const acts = rc.change.actions;
        if (acts.length === 1 && (acts[0] === "no-op" || acts[0] === "read")) continue;
        const destroys = acts.includes("delete");
        const replace = destroys && acts.includes("create");
        const info = DATA_BEARING[rc.type];
        const env = envOf(rc);
        const before = (rc.change.before ?? {}) as Record<string, unknown>;
        if (!destroys) { if (acts.includes("create")) creates++; else updates++; if (info && acts.includes("update")) out.push(mk({ effect: `Updates data-bearing ${info.kind} ${rc.address} in place; in-place changes can still cause downtime or data movement.`, severity: "low", reversibility: "unknown", unverified: ["impact of in-place change not modeled"], env }, `${rc.address}: ${acts.join(",")}`)); continue; }
        if (!info) {
          out.push(mk({ effect: `${replace ? "Replaces (destroy + create)" : "Destroys"} ${rc.address} (${rc.type}).`, severity: "medium", reversibility: "unknown", env, unverified: [`${rc.type} not in the data-bearing table; data loss not assessed`] }, `${rc.address}: ${acts.join(",")}`));
          continue;
        }
        const size = info.sizeKey && typeof before[info.sizeKey] === "number" ? (before[info.sizeKey] as number) * (info.sizeUnit ?? 1) : undefined;
        const finalSnap = before["skip_final_snapshot"] === false || typeof before["final_snapshot_identifier"] === "string" || typeof before["final_snapshot_name"] === "string";
        const protectedNow = before["deletion_protection"] === true;
        const unv: string[] = [];
        if (info.backupsInside && !finalSnap) unv.push("automated backups live inside the resource and are deleted with it");
        if (!("skip_final_snapshot" in before) && rc.type === "aws_db_instance") unv.push("final-snapshot setting not visible in plan; assuming none");
        const recoverable = finalSnap;
        out.push(mk({
          effect: `${replace ? "REPLACES" : "DESTROYS"} ${info.kind} ${rc.address}${size ? ` (${(size / 1e9).toFixed(1)} GB provisioned)` : ""}${info.backupsInside ? finalSnap ? "; a final snapshot is configured" : "; its automated backups are stored in the same resource and are destroyed with it" : ""}.${protectedNow ? " deletion_protection is on, so the provider may refuse unless the plan also disables it." : ""}`,
          severity: recoverable ? "high" : "critical",
          reversibility: recoverable ? "recoverable" : "irreversible",
          recovery: recoverable ? "restore from the final snapshot" : undefined,
          blast: { bytes: size, files: undefined }, env,
          saferAlternative: replace ? "Use `lifecycle { prevent_destroy = true }` or `terraform state mv` / `moved` blocks to avoid recreation; snapshot first." : "Remove this resource from the plan (or set `lifecycle { prevent_destroy = true }`); take a snapshot/backup outside the resource first.",
          unverified: unv.length ? unv.filter((u) => !u.startsWith("automated")) : undefined,
        }, `${rc.address}: ${acts.join(",")}; ${redact(JSON.stringify({ tags: before["tags"], protected: protectedNow, finalSnap }))}`));
      }
      if (!out.length) {
        const noop = rcs.every((r) => r.change.actions.every((x) => x === "no-op"));
        out.push(mk({
          effect: noop ? "Plan makes no changes." : updates === 0 ? `Plan creates ${creates} resource(s) and destroys nothing.` : `Plan updates ${updates} and creates ${creates} resource(s) in place; nothing is destroyed.`,
          severity: noop ? "info" : "low", reversibility: noop ? "reversible" : "unknown", benign: noop,
          unverified: noop ? undefined : ["exposure, cost and in-place update effects of created/updated resources are not assessed"],
          env: { level: "unknown", evidence: ["plan does not identify the environment"] },
        }, `${rcs.length} resource_changes, none destructive`));
      }
      return out;
    },
  };
}
