// Generates the GitHub social preview (1280x640). Upload it in: repo Settings -> General -> Social preview.
import { Resvg } from "@resvg/resvg-js";
import { writeFileSync } from "node:fs";
const sans = "Helvetica,Arial,'DejaVu Sans',sans-serif", mono = "Menlo,Consolas,'DejaVu Sans Mono',monospace";
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="640" viewBox="0 0 1280 640">
<rect width="1280" height="640" fill="#14090b"/><rect width="16" height="640" fill="#e5484d"/>
<text x="80" y="170" font-size="104" font-weight="700" fill="#ffffff" font-family="${sans}">Dry Run</text>
<text x="80" y="245" font-size="42" fill="#ffffffcc" font-family="${sans}">Rehearse anything before your agent does it.</text>
<g transform="translate(80,300)"><rect width="1120" height="190" rx="18" fill="#2a0f12" stroke="#e5484d55"/>
<text x="36" y="58" font-size="26" fill="#ffffff99" font-family="${mono}">$ DELETE /v1/volumes/vol_pg_prod</text>
<text x="36" y="112" font-size="38" font-weight="700" fill="#ff6369" font-family="${sans}">Deletes pg-data (40.2 GB) in production.</text>
<text x="36" y="158" font-size="30" fill="#ff8d90" font-family="${sans}">All 3 backups are on the same volume. Irreversible.</text>
<g transform="translate(870,24)"><rect width="220" height="52" rx="26" fill="#e5484d"/><text x="110" y="35" text-anchor="middle" font-size="26" font-weight="700" fill="#fff" font-family="${sans}" letter-spacing="2">BLOCKED</text></g></g>
<text x="80" y="570" font-size="30" fill="#ffffffaa" font-family="${sans}">MCP server for coding agents</text>
<text x="1200" y="570" text-anchor="end" font-size="28" fill="#ffffff80" font-family="${mono}">npx dry-run-agents</text>
</svg>`;
writeFileSync("docs/assets/social-preview.png", new Resvg(svg, { font: { loadSystemFonts: true, defaultFontFamily: "Helvetica" } }).render().asPng());
