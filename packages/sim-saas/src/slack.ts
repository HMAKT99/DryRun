import type { Action, Finding, ReadOnlyContext } from "@dryrun/core";
import { creds, evOf, getJson, mk, reuseNotice, type Req } from "./common.js";

const MENTION = /<!(channel|here|everyone)>|(^|\s)@(channel|here|everyone)\b/i;

export function slackTier1(r: Req): Finding[] {
  if (/^chat\.(delete|update)/i.test(r.operation)) return [mk({ effect: `Slack ${r.operation} alters or removes an existing message.`, severity: "low", reversibility: "unknown", unverified: ["original message not inspected"] }, "operation classification", r.operation)];
  if (/postMessage|post_message|send/i.test(r.operation)) {
    const text = String(r.params["text"] ?? "");
    const mention = MENTION.exec(text)?.[0]?.trim();
    return [mk({ effect: `Posts a message to Slack channel ${String(r.params["channel"] ?? "?")}${mention ? ` mentioning ${mention}` : ""}. Notifications cannot be recalled.`, severity: "medium", reversibility: "recoverable", recovery: "chat.delete removes the message but not the notifications already delivered", unverified: ["pending: channel audience not yet looked up"] }, "operation classification", `slack ${r.operation}${mention ? ` (${mention})` : ""}`)];
  }
  if (/archive|delete|kick|remove/i.test(r.operation)) return [mk({ effect: `Slack ${r.operation} changes or removes channel/user state.`, severity: "high", reversibility: "unknown", unverified: ["pending: target not yet looked up"] }, "operation classification", r.operation)];
  return [mk({ effect: `Slack operation "${r.operation}" is not classified.`, severity: "medium", reversibility: "unknown", unverified: [`slack ${r.operation} not classified`] }, "operation classification", r.operation)];
}

export async function slackTier2(r: Req, a: Action, ctx: ReadOnlyContext, env: NodeJS.ProcessEnv, blockPeople: number): Promise<Finding[]> {
  const c = creds(a, "slack", env, { base: "https://slack.com/api" });
  const out = [...reuseNotice(c, "Slack")];
  const channel = String(r.params["channel"] ?? "");
  if (!channel) return [...out, mk({ effect: "No channel supplied.", severity: "medium", unverified: ["channel unknown"] }, "input", "channel missing", 2)];
  const url = `${c.base}/conversations.info?channel=${encodeURIComponent(channel)}&include_num_members=true`;
  const x = await getJson(ctx, url, c.headers());
  const ch = x.body?.channel;
  if (x.status !== 200 || !x.body?.ok || !ch) return [...out, mk({ effect: `Could not look up channel ${channel}.`, severity: "medium", reversibility: "unknown", unverified: [`channel lookup failed: ${x.body?.error ?? `HTTP ${x.status}`}`] }, evOf(url), String(x.body?.error ?? x.status), 2, true)];
  const members = Number(ch.num_members ?? 0);
  const external = Boolean(ch.is_ext_shared || ch.is_shared || ch.is_org_shared);
  const text = String(r.params["text"] ?? "");
  const mention = MENTION.exec(text)?.[0]?.trim();
  const notified = mention ? members : 1;
  const big = mention && notified >= 50;
  out.push(mk({
    effect: `Channel #${ch.name} has ${members} member(s)${ch.is_private ? " (private)" : ""}${external ? ", is SHARED WITH EXTERNAL organizations" : ""}. ${mention ? `The message mentions ${mention}, notifying about ${members} people. ` : ""}Notifications cannot be recalled.`,
    severity: external || (mention && big) ? "high" : "medium",
    reversibility: mention && big ? "irreversible" : "recoverable", recovery: mention && big ? undefined : "chat.delete removes the message (people may have already seen it)",
    blast: { people: mention ? members : external ? members : 1 },
    env: external ? { level: "production", evidence: ["channel is shared with external organizations"] } : { level: "unknown", evidence: ["internal channel; no environment concept"] },
    saferAlternative: mention ? "Remove the @channel/@here mention, or post to a smaller channel first." : external ? "Post to an internal channel and have a human forward it." : undefined,
  }, evOf(url), `members=${members} external=${external} private=${Boolean(ch.is_private)}`, 2, true));
  void blockPeople;
  return out;
}
