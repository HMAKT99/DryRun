import type { Action, Finding, ReadOnlyContext } from "@dryrun/core";
import { creds, evOf, getJson, mk, reuseNotice, type Req } from "./common.js";

export function githubTier1(r: Req): Finding[] {
  const op = r.operation;
  const t = `${String(r.params["owner"] ?? "?")}/${String(r.params["repo"] ?? "?")}`;
  if (/repo.*delete|delete.*repo/i.test(op)) return [mk({ effect: `Deletes repository ${t} with its issues, PRs, wiki and releases.`, severity: "critical", reversibility: "recoverable", recovery: "GitHub can restore some deleted repositories for ~90 days (not guaranteed; not for every fork network)", unverified: ["restorability cannot be verified", "pending: repository not yet inspected"] }, "operation classification", op)];
  if (/visibility|make.*public|private.*false/i.test(op) || (/update|patch/i.test(op) && r.params["private"] === false)) return [mk({ effect: `Changes visibility of ${t}${r.params["private"] === false || /public/i.test(op) ? " to PUBLIC: all source and git history become world-readable" : ""}.`, severity: "critical", reversibility: "irreversible", recovery: undefined, unverified: ["pending: repository not yet inspected"], saferAlternative: "Scan history for secrets first, and confirm with the owner." }, "operation classification", op)];
  if (/branch.*delete|delete.*branch/i.test(op)) return [mk({ effect: `Deletes branch ${String(r.params["branch"] ?? "?")} of ${t}.`, severity: "high", reversibility: "recoverable", recovery: "git push origin <sha>:refs/heads/<branch> if the tip sha is recorded", unverified: ["pending: unmerged commits not yet counted"] }, "operation classification", op)];
  if (/protection.*(delete|remove)|(delete|remove).*protection/i.test(op)) return [mk({ effect: `Removes branch protection on ${String(r.params["branch"] ?? "?")} of ${t}: force pushes and deletions become possible.`, severity: "high", reversibility: "recoverable", recovery: "re-apply the protection rules (rules not recorded)", unverified: ["pending: current rules not yet captured"] }, "operation classification", op)];
  if (/^(get|list)/i.test(op)) return [mk({ effect: "Read-only GitHub call.", benign: true }, "operation classification", op)];
  return [mk({ effect: `GitHub operation "${op}" is not classified.`, severity: "medium", reversibility: "unknown", unverified: [`github ${op} not classified`] }, "operation classification", op)];
}

export async function githubTier2(r: Req, a: Action, ctx: ReadOnlyContext, env: NodeJS.ProcessEnv): Promise<Finding[]> {
  const c = creds(a, "github", env, { base: "https://api.github.com", header: (t) => ({ authorization: `Bearer ${t}`, accept: "application/vnd.github+json" }) });
  const out = [...reuseNotice(c, "GitHub")];
  const o = encodeURIComponent(String(r.params["owner"] ?? "")), p = encodeURIComponent(String(r.params["repo"] ?? ""));
  if (!r.params["owner"] || !r.params["repo"]) return [...out, mk({ effect: "owner/repo not supplied.", severity: "medium", unverified: ["target repository unknown"] }, "input", "missing owner/repo", 2)];
  const repoUrl = `${c.base}/repos/${o}/${p}`;
  const repo = await getJson(ctx, repoUrl, c.headers());
  if (repo.status !== 200) return [...out, mk({ effect: `Could not look up ${o}/${p}.`, severity: "medium", reversibility: "unknown", unverified: [`repo lookup failed: HTTP ${repo.status}`] }, evOf(repoUrl), `HTTP ${repo.status}`, 2, true)];
  const R = repo.body;
  const prs = await getJson(ctx, `${repoUrl}/pulls?state=open&per_page=100`, c.headers());
  const nPR = Array.isArray(prs.body) ? prs.body.length : 0;
  const prText = nPR >= 100 ? "100+" : String(nPR);
  const popular = (R.stargazers_count ?? 0) + (R.forks_count ?? 0) >= 10 || nPR > 0 || R.fork === false && R.owner?.type === "Organization";
  const envInfo = popular ? { level: "production" as const, evidence: [`${R.stargazers_count} stars, ${R.forks_count} forks, ${prText} open PR(s)${R.owner?.type === "Organization" ? `, owned by organization ${R.owner.login}` : ""}`] } : { level: "unknown" as const, evidence: [`${R.stargazers_count} stars, ${R.forks_count} forks, ${prText} open PR(s)`] };
  const size = Number(R.size ?? 0) * 1024;
  const facts = `${R.full_name}: ${R.private ? "private" : "public"}, ${R.stargazers_count} stars, ${R.forks_count} forks, ${prText} open PR(s), ${R.open_issues_count} open issues+PRs, ${(size / 1e6).toFixed(1)} MB, default branch ${R.default_branch}`;
  if (/repo.*delete|delete.*repo/i.test(r.operation)) {
    out.push(mk({ effect: `Deleting ${facts}. ${R.forks_count ? `${R.forks_count} fork(s) would lose their upstream. ` : ""}${nPR ? `${prText} open pull request(s) would be destroyed. ` : ""}`, severity: "critical", reversibility: "recoverable", recovery: "GitHub may restore within ~90 days; not guaranteed", blast: { bytes: size, people: (R.forks_count ?? 0) }, env: envInfo, unverified: ["restorability cannot be verified"], saferAlternative: "Archive the repository instead (reversible), or transfer it." }, evOf(repoUrl), facts, 2, true));
  } else if (/visibility|public|private/i.test(r.operation) || r.params["private"] !== undefined) {
    const toPublic = r.params["private"] === false || /public/i.test(r.operation);
    out.push(mk({ effect: toPublic && R.private ? `Making ${facts} PUBLIC exposes ${(size / 1e6).toFixed(1)} MB of source and complete git history to everyone; it cannot be un-published (forks/caches persist).` : `Visibility change on ${facts}.`, severity: toPublic && R.private ? "critical" : "medium", reversibility: toPublic && R.private ? "irreversible" : "reversible", blast: toPublic && R.private ? { bytes: size } : undefined, env: toPublic && R.private ? { level: "unknown", evidence: ["private repository becoming public"] } : envInfo, saferAlternative: "Scan history for secrets (e.g. gitleaks) and get owner approval; consider publishing a clean copy instead." }, evOf(repoUrl), facts, 2, true));
  } else if (/branch|protection/i.test(r.operation)) {
    const b = encodeURIComponent(String(r.params["branch"] ?? R.default_branch));
    const br = await getJson(ctx, `${repoUrl}/branches/${b}`, c.headers());
    const isDefault = String(r.params["branch"] ?? "") === R.default_branch;
    let ahead: number | undefined;
    if (!isDefault) { const cmp = await getJson(ctx, `${repoUrl}/compare/${encodeURIComponent(R.default_branch)}...${b}`, c.headers()); if (cmp.status === 200) ahead = Number(cmp.body.ahead_by); }
    const prot = br.body?.protected === true;
    out.push(mk({
      effect: `${/protection/i.test(r.operation) ? "Removing protection from" : "Deleting"} branch ${decodeURIComponent(b)} of ${facts}. ${isDefault ? "This is the DEFAULT branch. " : ""}${prot ? "The branch is protected. " : ""}${ahead !== undefined ? `${ahead} commit(s) exist only on this branch. ` : ""}${nPR ? `${prText} open PR(s) in the repo. ` : ""}`,
      severity: isDefault || (ahead ?? 0) > 0 ? "high" : "medium", reversibility: "recoverable", recovery: `git push origin ${br.body?.commit?.sha?.slice(0, 8) ?? "<sha>"}:refs/heads/${decodeURIComponent(b)}`,
      blast: { people: nPR }, env: isDefault || prot ? { level: "production", evidence: [isDefault ? "default branch" : "protected branch"] } : envInfo,
      unverified: ahead === undefined && !isDefault ? ["unmerged commit count not determined"] : undefined,
    }, evOf(`${repoUrl}/branches/${b}`), `protected=${prot} ahead=${ahead ?? "?"}`, 2, true));
  }
  return out;
}
