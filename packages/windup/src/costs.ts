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
  /** LLM-assist for scans (P4): AI spend outside runs, same ledger. */
  scans: { count: number; llm_calls: number; tokens: { input: number; output: number }; est_cost_usd: number };
  /** Scenarios generated via `windup new` (assisted authoring) — same ledger. */
  authoring: { count: number; llm_calls: number; tokens: { input: number; output: number }; est_cost_usd: number };
  /** Per company (google, openai...) — whoever alternates between LLMs sees each one's spend. */
  by_provider: Record<string, { calls: number; tokens: { input: number; output: number }; est_cost_usd: number }>;
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
    provider: string | null;
  }>;
}

/**
 * Records predating multi-provider have no llm_provider — infer it from the
 * model name (names are unique across companies), so old history shows up in
 * the per-provider breakdown without rewriting the ledger.
 */
export function inferProvider(model: string | null, recorded?: string | null): string | null {
  if (recorded) return recorded;
  if (!model) return null;
  if (/^gemini/.test(model)) return "google";
  if (/^(gpt-|o\d)/.test(model)) return "openai";
  // Claude models only ever reach Windup through the claude-code wrapper —
  // revisit if a direct Anthropic provider is ever added (the two would share
  // model names but NOT prices: subscription vs per token).
  if (/^claude-/.test(model)) return "claude-code";
  return "unknown";
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
  type ToolRecord = { llm_calls: number; llm_model: string | null; llm_provider: string | null; tokens: { input: number; output: number } };
  const scans: ToolRecord[] = [];
  const authorings: ToolRecord[] = [];
  for (const file of files) {
    try {
      const m = JSON.parse(await readFile(path.join(runsDir, file), "utf8")) as RunMetrics & { kind?: string };
      if (!m.started_at) continue;
      if (cutoff && Date.parse(m.started_at) < cutoff) continue;
      if (m.kind === "scan" || m.kind === "authoring") {
        (m.kind === "scan" ? scans : authorings).push({
          llm_calls: m.llm_calls ?? 0,
          llm_model: m.llm_model ?? null,
          llm_provider: inferProvider(m.llm_model ?? null, m.llm_provider),
          tokens: m.tokens ?? { input: 0, output: 0 },
        });
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
    authoring: { count: 0, llm_calls: 0, tokens: { input: 0, output: 0 }, est_cost_usd: 0 },
    by_provider: {},
    by_model: {},
    by_scenario: {},
    last_runs: [],
  };

  const accumulate = (
    bucket: Record<string, { calls: number; tokens: { input: number; output: number }; est_cost_usd: number }>,
    key: string,
    calls: number,
    tokens: { input: number; output: number },
    cost: number,
  ) => {
    const b = (bucket[key] ??= { calls: 0, tokens: { input: 0, output: 0 }, est_cost_usd: 0 });
    b.calls += calls;
    b.tokens.input += tokens.input;
    b.tokens.output += tokens.output;
    b.est_cost_usd += cost;
  };

  for (const m of runs) {
    const provider = inferProvider(m.llm_model, m.llm_provider);
    const cost = estimateCostUsd(m.tokens, m.llm_model, provider);
    report.llm_calls += m.llm_calls;
    report.tokens.input += m.tokens.input;
    report.tokens.output += m.tokens.output;
    report.est_cost_usd += cost;
    if (m.llm_calls === 0) report.free_replays += 1;

    if (m.llm_model) {
      if (provider) accumulate(report.by_provider, provider, m.llm_calls, m.tokens, cost);
      accumulate(report.by_model, m.llm_model, m.llm_calls, m.tokens, cost);
    }

    const bs = (report.by_scenario[m.scenario_id] ??= { runs: 0, llm_calls: 0, est_cost_usd: 0 });
    bs.runs += 1;
    bs.llm_calls += m.llm_calls;
    bs.est_cost_usd += cost;
  }

  for (const [bucket, records] of [[report.scans, scans], [report.authoring, authorings]] as const) {
    for (const s of records) {
      const cost = estimateCostUsd(s.tokens, s.llm_model, s.llm_provider);
      bucket.count += 1;
      bucket.llm_calls += s.llm_calls;
      bucket.tokens.input += s.tokens.input;
      bucket.tokens.output += s.tokens.output;
      bucket.est_cost_usd += cost;
      report.est_cost_usd += cost; // grand total includes scans and authoring
      if (s.llm_model) {
        if (s.llm_provider) accumulate(report.by_provider, s.llm_provider, s.llm_calls, s.tokens, cost);
        accumulate(report.by_model, s.llm_model, s.llm_calls, s.tokens, cost);
      }
    }
  }

  report.last_runs = runs.slice(-(opts.last ?? 10)).reverse().map((m) => ({
    at: m.started_at,
    scenario: m.scenario_id,
    result: m.result,
    cache: m.cache,
    llm_calls: m.llm_calls,
    tokens: m.tokens,
    est_cost_usd: estimateCostUsd(m.tokens, m.llm_model, inferProvider(m.llm_model, m.llm_provider)),
    model: m.llm_model,
    provider: inferProvider(m.llm_model, m.llm_provider),
  }));

  round(report);
  return report;
}

function round(report: CostsReport): void {
  report.est_cost_usd = Number(report.est_cost_usd.toFixed(4));
  report.scans.est_cost_usd = Number(report.scans.est_cost_usd.toFixed(4));
  report.authoring.est_cost_usd = Number(report.authoring.est_cost_usd.toFixed(4));
  for (const bp of Object.values(report.by_provider)) bp.est_cost_usd = Number(bp.est_cost_usd.toFixed(4));
  for (const bm of Object.values(report.by_model)) bm.est_cost_usd = Number(bm.est_cost_usd.toFixed(4));
  for (const bs of Object.values(report.by_scenario)) bs.est_cost_usd = Number(bs.est_cost_usd.toFixed(4));
}

const fmtTokens = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export function printCostsReport(report: CostsReport, runsDir: string): void {
  if (report.runs === 0 && report.scans.count === 0 && report.authoring.count === 0) {
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

  if (report.authoring.count > 0) {
    console.log(
      `authoring ${report.authoring.count} scenario(s) generated  llm_calls=${report.authoring.llm_calls}  ` +
        `tokens=${fmtTokens(report.authoring.tokens.input)}/${fmtTokens(report.authoring.tokens.output)}  $${report.authoring.est_cost_usd}`,
    );
  }

  if (Object.keys(report.by_provider).length > 1) {
    console.log("\nby provider");
    for (const [provider, s] of Object.entries(report.by_provider).sort((a, b) => b[1].est_cost_usd - a[1].est_cost_usd)) {
      console.log(
        `  ${provider.padEnd(26)} calls=${String(s.calls).padEnd(4)} tokens=${fmtTokens(s.tokens.input)}/${fmtTokens(s.tokens.output)}  $${s.est_cost_usd}`,
      );
    }
  }

  if (Object.keys(report.by_model).length) {
    console.log("\nby model");
    for (const [model, s] of Object.entries(report.by_model).sort((a, b) => b[1].est_cost_usd - a[1].est_cost_usd)) {
      const provider = inferProvider(model);
      const label = provider && provider !== "unknown" ? `${provider}/${model}` : model;
      console.log(
        `  ${label.padEnd(33)} calls=${String(s.calls).padEnd(4)} tokens=${fmtTokens(s.tokens.input)}/${fmtTokens(s.tokens.output)}  $${s.est_cost_usd}`,
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
    const llmLabel = r.model ? `  ${r.provider && r.provider !== "unknown" ? `${r.provider}/` : ""}${r.model}` : "";
    console.log(
      `  ${at}  ${status}  ${r.scenario.padEnd(26)} cache=${r.cache.padEnd(11)} llm=${r.llm_calls}  $${r.est_cost_usd}${llmLabel}`,
    );
  }
}
