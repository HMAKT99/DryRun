import { writeFileSync } from "node:fs";
import { Resvg } from "@resvg/resvg-js";
import { renderCardSvg, type ConsequenceReport } from "@dryrun/core";

/** Writes the shareable report card. `.svg` writes vector; anything else writes PNG. */
export function writeCard(report: ConsequenceReport, path: string): void {
  const svg = renderCardSvg(report);
  if (path.endsWith(".svg")) { writeFileSync(path, svg); return; }
  const png = new Resvg(svg, { font: { loadSystemFonts: true, defaultFontFamily: "Helvetica" }, fitTo: { mode: "width", value: 1200 } }).render().asPng();
  writeFileSync(path, png);
}
