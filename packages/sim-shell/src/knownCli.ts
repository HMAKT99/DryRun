import type { Finding } from "@dryrun/core";

export interface KnownCli { effect: string; severity: Finding["severity"]; reversibility: Finding["reversibility"]; saferAlternative: string }

const has = (argv: string[], ...words: string[]) => words.some((w) => argv.includes(w));
const CLOUD_DESTRUCTIVE = /^(delete|destroy|terminate|remove|rm|rb|deregister|purge|drop|wipe|disable|reset)([-_a-z]*)$/i;
const SQL_DESTRUCTIVE = /\b(drop\s+(table|database|schema|index|view)|truncate|delete\s+from|alter\s+table\s+\S+\s+drop|flushall|flushdb|dropdatabase|\.drop\(|\.deletemany\(|\.remove\()/i;

/** Well-known CLIs whose destructive subcommands deserve a specific explanation instead of "unknown command". */
export function knownCli(cmd: string, argv: string[]): KnownCli | undefined {
  const args = argv.slice(1);
  const joined = args.join(" ");
  switch (cmd) {
    case "terraform": case "tofu":
      if (has(args, "destroy") || has(args, "-destroy")) return { effect: `${cmd} destroy deletes every resource in the state, including databases and volumes.`, severity: "critical", reversibility: "irreversible", saferAlternative: `${cmd} plan -destroy -out=tfplan && ${cmd} show -json tfplan > plan.json, then rehearse it with: dryrun tf plan.json` };
      if (has(args, "apply")) return { effect: `${cmd} apply changes real infrastructure and may destroy or replace resources.`, severity: "high", reversibility: "unknown", saferAlternative: `${cmd} plan -out=tfplan && ${cmd} show -json tfplan > plan.json, then rehearse it with: dryrun tf plan.json` };
      if (has(args, "state") && has(args, "rm")) return { effect: `${cmd} state rm makes Terraform forget resources (they become unmanaged and may be recreated or orphaned).`, severity: "high", reversibility: "recoverable", saferAlternative: `Back up the state first (${cmd} state pull > backup.tfstate).` };
      return undefined;
    case "kubectl": case "oc": case "helm":
      if (has(args, "delete", "uninstall", "drain", "replace", "scale") && (cmd !== "kubectl" || !has(args, "scale") || /--replicas[= ]0/.test(joined))) return { effect: `${cmd} ${args.find((a) => !a.startsWith("-")) ?? ""} removes or stops live cluster resources (namespaces, volumes and their data included).`, severity: "high", reversibility: "irreversible", saferAlternative: "Run with --dry-run=server (kubectl) or --dry-run (helm) first, and check which namespace/context is active." };
      return undefined;
    case "docker": case "podman":
      if ((has(args, "prune") || (has(args, "system") && has(args, "prune"))) || (has(args, "rm", "rmi") ) || (has(args, "volume", "network", "container", "image") && has(args, "rm", "prune")) || (has(args, "compose") && has(args, "down") && /(-v|--volumes)\b/.test(joined)) || (has(args, "kill")))
        return { effect: `${cmd} ${args.filter((a) => !a.startsWith("-")).slice(0, 2).join(" ")} deletes containers, images or volumes (volumes hold persistent data).`, severity: "high", reversibility: "irreversible", saferAlternative: `List what would be removed first (${cmd} ps -a, ${cmd} volume ls) and back up volumes you need.` };
      return undefined;
    case "aws":
      if (args.some((a) => CLOUD_DESTRUCTIVE.test(a) || /^(rm|rb)$/.test(a)) || /--recursive|--force/.test(joined) && has(args, "rm"))
        return { effect: "aws CLI call deletes or terminates cloud resources.", severity: "high", reversibility: "irreversible", saferAlternative: "Rehearse the API call with: dryrun api aws <service:Operation> --params '{...}' (resolves the target read-only)." };
      return undefined;
    case "gcloud": case "az": case "doctl": case "heroku": case "flyctl": case "fly": case "vercel": case "railway": case "netlify": case "supabase": case "pscale": case "wrangler": case "render": case "scw":
      if (args.some((a) => CLOUD_DESTRUCTIVE.test(a))) return { effect: `${cmd} ${args.filter((a) => !a.startsWith("-")).slice(0, 3).join(" ")} deletes provider resources, possibly including databases and volumes.`, severity: "high", reversibility: "irreversible", saferAlternative: `Rehearse it with: dryrun api ${cmd} <operation> (if a catalog exists), and confirm the project/environment first.` };
      return undefined;
    case "gh":
      if ((has(args, "repo") && has(args, "delete", "archive", "rename")) || (has(args, "release", "secret", "variable", "label", "ruleset") && has(args, "delete")) || (has(args, "api") && /(-X|--method)[ =]?(DELETE|PUT|PATCH|POST)/i.test(joined)))
        return { effect: "gh command deletes or changes GitHub resources.", severity: "high", reversibility: "unknown", saferAlternative: "Rehearse it with: dryrun saas github <operation> --params '{...}'." };
      return undefined;
    case "psql": case "mysql": case "mariadb": case "sqlite3": case "mongosh": case "mongo": case "redis-cli": case "clickhouse-client": case "cockroach": case "usql":
      if (SQL_DESTRUCTIVE.test(joined)) return { effect: `${cmd} runs a destructive statement directly against a live database.`, severity: "critical", reversibility: "irreversible", saferAlternative: "Rehearse the statement with: dryrun sql \"<statement>\" --db-env DRYRUN_DATABASE_URL" };
      return undefined;
    case "dropdb": case "dropuser": case "mysqladmin": case "pg_dropcluster":
      return { effect: `${cmd} permanently deletes a database or role.`, severity: "critical", reversibility: "irreversible", saferAlternative: "Take a pg_dump/backup and confirm the target first." };
    case "npm": case "pnpm": case "yarn":
      if (has(args, "unpublish", "deprecate", "owner", "token", "access") || (has(args, "dist-tag") && has(args, "rm"))) return { effect: `${cmd} changes the public registry state.`, severity: "high", reversibility: "irreversible", saferAlternative: "Check the package name/version with `npm view` first." };
      return undefined;
    default: return undefined;
  }
}
