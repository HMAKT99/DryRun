import { renderTerminal, type ConsequenceReport } from "@dryrun/core";

const tty = process.stdout.isTTY && !process.env["NO_COLOR"];
const c = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
export const red = c("31;1"), yellow = c("33;1"), green = c("32;1"), dim = c("2"), bold = c("1"), cyan = c("36");

export function colorReport(r: ConsequenceReport): string {
  const text = renderTerminal(r);
  const [first, ...rest] = text.split("\n");
  const paint = r.verdict.value === "block" ? red : r.verdict.value === "confirm" ? yellow : green;
  return [paint(first ?? ""), ...rest].join("\n");
}
export const exitCodeFor = (r: ConsequenceReport) => ({ safe: 0, confirm: 2, block: 3 })[r.verdict.value];
