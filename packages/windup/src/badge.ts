import { latestRunPerScenario } from "./ledger.js";

export interface Badge {
  passed: number;
  total: number;
  cost_usd: number;
  color: "green" | "orange" | "red" | "lightgrey";
  message: string;
}

/** Suite status from each scenario's latest ledger run — the input for an SVG/JSON status badge. */
export async function buildBadge(): Promise<Badge> {
  const latest = await latestRunPerScenario();
  const runs = [...latest.values()];
  const total = runs.length;
  const passed = runs.filter((r) => r.result === "passed").length;
  const cost = Number(runs.reduce((s, r) => s + (r.estimated_cost_usd ?? 0), 0).toFixed(4));
  const color = total === 0 ? "lightgrey" : passed === total ? "green" : passed >= total * 0.8 ? "orange" : "red";
  const costLabel = cost === 0 ? "$0" : `$${cost}`;
  const message = total === 0 ? "no runs" : `${passed}/${total} passing · ${costLabel}`;
  return { passed, total, cost_usd: cost, color, message };
}

/** Shields.io endpoint JSON (`{ schemaVersion, label, message, color }`). */
export function badgeJson(b: Badge): string {
  return JSON.stringify({ schemaVersion: 1, label: "windup", message: b.message, color: b.color }, null, 2);
}

const HEX: Record<Badge["color"], string> = { green: "#2f7d4f", orange: "#c07a1e", red: "#b5432e", lightgrey: "#9f9f9f" };

/** Self-contained SVG badge (no external fetch — safe to commit / embed). */
export function badgeSvg(b: Badge): string {
  const label = "windup";
  const msg = b.message;
  const lw = 7 + label.length * 6.5; // rough monospace-ish width
  const mw = 10 + msg.length * 6.5;
  const w = Math.ceil(lw + mw);
  const lx = lw / 2;
  const mx = lw + mw / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${label}: ${msg}">
  <title>${label}: ${msg}</title>
  <linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
  <clipPath id="r"><rect width="${w}" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${Math.ceil(lw)}" height="20" fill="#555"/>
    <rect x="${Math.ceil(lw)}" width="${Math.ceil(mw)}" height="20" fill="${HEX[b.color]}"/>
    <rect width="${w}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <text x="${lx}" y="15" fill="#010101" fill-opacity=".3">${label}</text>
    <text x="${lx}" y="14">${label}</text>
    <text x="${mx}" y="15" fill="#010101" fill-opacity=".3">${msg}</text>
    <text x="${mx}" y="14">${msg}</text>
  </g>
</svg>`;
}
