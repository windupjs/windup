import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { getContext } from "./context.js";
import { estimateCostUsd } from "./metrics.js";
import type { RunMetrics } from "./types.js";

/**
 * `windup costs` — AI usage report aggregated from the run ledger.
 *
 * Every run already persists its metrics to .windup/runs/<ts>-<scenario>.json
 * (tokens, LLM calls, model, cache outcome). This command reads that ledger;
 * nothing extra needs to be recorded. Costs are recomputed from tokens using
 * the current per-model price table, so old records stay accurate after
 * pricing updates.
 */
export interface CostsReport {
  runs: number;
  llm_calls: number;
  tokens: { input: number; output: number };
  est_cost_usd: number;
  free_replays: number;
  /** LLM-assist de scans (P4): gasto de IA fora de runs, mesmo ledger. */
  scans: { count: number; llm_calls: number; tokens: { input: number; output: number }; est_cost_usd: number };
  by_model: Record<string, { calls: number; tokens: { input: number; output: number }; est_cost_usd: number }>;
  by_scenario: Record<string, { runs: number; llm_calls: number; est_cost_usd: number }>;
  last_runs: Array<{
    at: string;
    scenario: string;
    result: string;
    cache: string;
    llm_calls: number;
    tokens: { input: number; output: number };
    est_cost_usd: number;
    model: string | null;
  }>;
}

export async function buildCostsReport(opts: { last?: number; days?: number } = {}): Promise<CostsReport> {
  const runsDir = getContext().paths.runsDir;
  let files: string[] = [];
  try {
    files = (await readdir(runsDir)).filter((f) => f.endsWith(".json") && !f.startsWith("bench-"));

  } catch {
    // no runs yet
  }

  const cutoff = opts.days ? Date.now() - opts.days * 86_400_000 : null;
  const runs: RunMetrics[] = [];
  const scans: Array<{ llm_calls: number; llm_model: string | null; tokens: { input: number; output: number } }> = [];
  for (const file of files) {
    try {
      const m = JSON.parse(await readFile(path.join(runsDir, file), "utf8")) as RunMetrics & { kind?: string };
      if (!m.started_at) continue;
      if (cutoff && Date.parse(m.started_at) < cutoff) continue;
      if (m.kind === "scan") {
        scans.push({ llm_calls: m.llm_calls ?? 0, llm_model: m.llm_model ?? null, tokens: m.tokens ?? { input: 0, output: 0 } });
        continue;
      }
      if (!m.scenario_id) continue;
      runs.push(m);
    } catch {
      // unreadable record — skip
    }
  }
  runs.sort((a, b) => a.started_at.localeCompare(b.started_at));

  const report: CostsReport = {
    runs: runs.length,
    llm_calls: 0,
    tokens: { input: 0, output: 0 },
    est_cost_usd: 0,
    free_replays: 0,
    scans: { count: 0, llm_calls: 0, tokens: { input: 0, output: 0 }, est_cost_usd: 0 },
    by_model: {},
    by_scenario: {},
    last_runs: [],
  };

  for (const m of runs) {
    const cost = estimateCostUsd(m.tokens, m.llm_model);
    report.llm_calls += m.llm_calls;
    report.tokens.input += m.tokens.input;
    report.tokens.output += m.tokens.output;
    report.est_cost_usd += cost;
    if (m.llm_calls === 0) report.free_replays += 1;

    if (m.llm_model) {
      const bm = (report.by_model[m.llm_model] ??= { calls: 0, tokens: { input: 0, output: 0 }, est_cost_usd: 0 });
      bm.calls += m.llm_calls;
      bm.tokens.input += m.tokens.input;
      bm.tokens.output += m.tokens.output;
      bm.est_cost_usd += cost;
    }

    const bs = (report.by_scenario[m.scenario_id] ??= { runs: 0, llm_calls: 0, est_cost_usd: 0 });
    bs.runs += 1;
    bs.llm_calls += m.llm_calls;
    bs.est_cost_usd += cost;
  }

  for (const s of scans) {
    const cost = estimateCostUsd(s.tokens, s.llm_model);
    report.scans.count += 1;
    report.scans.llm_calls += s.llm_calls;
    report.scans.tokens.input += s.tokens.input;
    report.scans.tokens.output += s.tokens.output;
    report.scans.est_cost_usd += cost;
    report.est_cost_usd += cost; // total geral inclui scans
    if (s.llm_model) {
      const bm = (report.by_model[s.llm_model] ??= { calls: 0, tokens: { input: 0, output: 0 }, est_cost_usd: 0 });
      bm.calls += s.llm_calls;
      bm.tokens.input += s.tokens.input;
      bm.tokens.output += s.tokens.output;
      bm.est_cost_usd += cost;
    }
  }

  report.last_runs = runs.slice(-(opts.last ?? 10)).reverse().map((m) => ({
    at: m.started_at,
    scenario: m.scenario_id,
    result: m.result,
    cache: m.cache,
    llm_calls: m.llm_calls,
    tokens: m.tokens,
    est_cost_usd: estimateCostUsd(m.tokens, m.llm_model),
    model: m.llm_model,
  }));

  round(report);
  return report;
}

function round(report: CostsReport): void {
  report.est_cost_usd = Number(report.est_cost_usd.toFixed(4));
  report.scans.est_cost_usd = Number(report.scans.est_cost_usd.toFixed(4));
  for (const bm of Object.values(report.by_model)) bm.est_cost_usd = Number(bm.est_cost_usd.toFixed(4));
  for (const bs of Object.values(report.by_scenario)) bs.est_cost_usd = Number(bs.est_cost_usd.toFixed(4));
}

const fmtTokens = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export function printCostsReport(report: CostsReport, runsDir: string): void {
  if (report.runs === 0 && report.scans.count === 0) {
    console.log("no runs recorded yet — the ledger lives in .windup/runs/");
    return;
  }

  console.log(`AI usage report  (ledger: ${runsDir})`);
  console.log("");
  console.log(
    `totals    runs=${report.runs}  llm_calls=${report.llm_calls}  ` +
      `tokens=${fmtTokens(report.tokens.input)} in / ${fmtTokens(report.tokens.output)} out  est_cost=$${report.est_cost_usd}`,
  );
  console.log(`replays   ${report.free_replays} run(s) with zero LLM calls — $0`);
  if (report.scans.count > 0) {
    console.log(
      `scans     ${report.scans.count} scan(s) with LLM-assist  llm_calls=${report.scans.llm_calls}  ` +
        `tokens=${fmtTokens(report.scans.tokens.input)}/${fmtTokens(report.scans.tokens.output)}  $${report.scans.est_cost_usd}`,
    );
  }

  if (Object.keys(report.by_model).length) {
    console.log("\nby model");
    for (const [model, s] of Object.entries(report.by_model).sort((a, b) => b[1].est_cost_usd - a[1].est_cost_usd)) {
      console.log(
        `  ${model.padEnd(26)} calls=${String(s.calls).padEnd(4)} tokens=${fmtTokens(s.tokens.input)}/${fmtTokens(s.tokens.output)}  $${s.est_cost_usd}`,
      );
    }
  }

  console.log("\nby scenario");
  for (const [scenario, s] of Object.entries(report.by_scenario).sort((a, b) => b[1].est_cost_usd - a[1].est_cost_usd)) {
    console.log(`  ${scenario.padEnd(26)} runs=${String(s.runs).padEnd(4)} llm_calls=${String(s.llm_calls).padEnd(4)} $${s.est_cost_usd}`);
  }

  console.log(`\nlast ${report.last_runs.length} run(s)`);
  for (const r of report.last_runs) {
    const at = r.at.slice(0, 16).replace("T", " ");
    const status = r.result === "passed" ? "PASS" : "FAIL";
    console.log(
      `  ${at}  ${status}  ${r.scenario.padEnd(26)} cache=${r.cache.padEnd(11)} llm=${r.llm_calls}  $${r.est_cost_usd}${r.model ? `  ${r.model}` : ""}`,
    );
  }
}
