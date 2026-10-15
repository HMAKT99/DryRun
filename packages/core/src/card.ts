import type { ConsequenceReport } from "./types.js";

const COLORS = { block: { bg: "#2a0f12", fg: "#ff6369", pill: "#e5484d", label: "BLOCKED" }, confirm: { bg: "#2b1d06", fg: "#ffc53d", pill: "#f5a524", label: "CONFIRM FIRST" }, safe: { bg: "#0c2418", fg: "#3dd68c", pill: "#30a46c", label: "SAFE" } } as const;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function wrap(text: string, max: number, maxLines: number): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = []; let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > max) { if (cur) lines.push(cur); cur = w.length > max ? w.slice(0, max - 1) + "…" : w; } else cur = (cur + " " + w).trim();
    if (lines.length === maxLines) break;
  }
  if (lines.length < maxLines && cur) lines.push(cur);
  const used = lines.join(" ").length;
  if (lines.length === maxLines && used < text.replace(/\s+/g, " ").trim().length) lines[maxLines - 1] = lines[maxLines - 1]!.replace(/.{0,1}$/, "…");
  return lines;
}

const SEV = { critical: 5, high: 4, medium: 3, low: 2, info: 1 } as const;
export function headline(r: ConsequenceReport): string {
  // Highest severity wins; on ties the LATER effect wins (Tier 2/3 findings are more specific than Tier 1).
  let top: ConsequenceReport["effects"][number] | undefined;
  for (const e of r.effects) if (!top || SEV[e.severity] >= SEV[top.severity]) top = e;
  return top?.text ?? r.verdict.reason;
}

function stats(r: ConsequenceReport): string[] {
  const b = r.blast_radius; const out = [`env: ${r.environment.level}`, `undo: ${r.reversibility}`];
  if (b.bytes) out.push(`${b.bytes >= 1e9 ? (b.bytes / 1e9).toFixed(1) + " GB" : (b.bytes / 1e6).toFixed(1) + " MB"}`);
  if (b.rows !== undefined) out.push(`${b.rows.toLocaleString("en-US")} rows`);
  if (b.files !== undefined) out.push(`${b.files} files`);
  if (b.money) out.push(`${b.money.currency} ${b.money.amount.toLocaleString("en-US", { maximumFractionDigits: 0 })}`);
  if (b.people !== undefined) out.push(`${b.people.toLocaleString("en-US")} people`);
  return out.slice(0, 5);
}

/** 1200x630 shareable card. Contains only already-redacted report fields. */
export function renderCardSvg(r: ConsequenceReport): string {
  const c = COLORS[r.verdict.value];
  const action = wrap(r.action.summary, 62, 2);
  const head = wrap(headline(r), 46, 4);
  const st = stats(r);
  let x = 60;
  const chips = st.map((s) => { const w = s.length * 14 + 36; const g = `<g transform="translate(${x},498)"><rect width="${w}" height="44" rx="22" fill="#ffffff14" stroke="#ffffff26"/><text x="${w / 2}" y="29" text-anchor="middle" font-size="22" fill="#e6e6e6" font-family="Menlo,Consolas,'DejaVu Sans Mono',monospace">${esc(s)}</text></g>`; x += w + 12; return g; }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<rect width="1200" height="630" fill="${c.bg}"/>
<rect x="0" y="0" width="14" height="630" fill="${c.pill}"/>
<text x="60" y="78" font-size="26" fill="#ffffff99" font-family="Helvetica,Arial,'DejaVu Sans',sans-serif" letter-spacing="3">DRY RUN</text>
<g transform="translate(790,38)"><rect width="350" height="62" rx="31" fill="${c.pill}"/><text x="175" y="42" text-anchor="middle" font-size="30" font-weight="700" fill="#fff" font-family="Helvetica,Arial,'DejaVu Sans',sans-serif" letter-spacing="2">${c.label}</text></g>
<text font-size="24" fill="#ffffffb3" font-family="Menlo,Consolas,'DejaVu Sans Mono',monospace">${action.map((l, i) => `<tspan x="60" y="${150 + i * 32}">${i === 0 ? "$ " : "  "}${esc(l)}</tspan>`).join("")}</text>
<text font-size="46" font-weight="700" fill="${c.fg}" font-family="Helvetica,Arial,'DejaVu Sans',sans-serif">${head.map((l, i) => `<tspan x="60" y="${262 + i * 58}">${esc(l)}</tspan>`).join("")}</text>
${chips}
<text x="60" y="598" font-size="22" fill="#ffffff80" font-family="Helvetica,Arial,'DejaVu Sans',sans-serif">Rehearsed before it ran. Nothing was changed.</text>
<text x="1140" y="598" text-anchor="end" font-size="22" fill="#ffffff80" font-family="Helvetica,Arial,'DejaVu Sans',sans-serif">dry-run-agents</text>
</svg>`;
}
