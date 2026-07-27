import { readRuns, runsForScenario } from "./ledger.js";
import type { RunMetrics } from "./types.js";

export interface ScenarioTrend {
  scenario_id: string;
  runs: number;
  passed: number;
  pass_rate: number; // 0..1
  avg_ms: number;
  avg_cost_usd: number;
  /** Recent results oldest→newest (last N), for a pass/fail sparkline. */
  recent: Array<"pass" | "fail">;
}

export interface TrendsReport {
  scenario?: string;
  scenarios: ScenarioTrend[];
  /** Present only when a single scenario is requested: its runs over time (chronological). */
  timeline?: Array<{ at: string; result: "passed" | "failed"; cache: string; total_ms: number; cost_usd: number }>;
}

const RECENT = 12;

function summarize(id: string, runs: RunMetrics[]): ScenarioTrend {
  const passed = runs.filter((r) => r.result === "passed").length;
  const avg = (pick: (r: RunMetrics) => number) => (runs.length ? runs.reduce((s, r) => s + pick(r), 0) / runs.length : 0);
  return {
    scenario_id: id,
    runs: runs.length,
    passed,
    pass_rate: runs.length ? Number((passed / runs.length).toFixed(3)) : 0,
    avg_ms: Math.round(avg((r) => r.duration_ms.total)),
    avg_cost_usd: Number(avg((r) => r.estimated_cost_usd).toFixed(6)),
    recent: runs.slice(-RECENT).map((r) => (r.result === "passed" ? "pass" : "fail")),
  };
}

/** Historical pass-rate / cost / duration per scenario from the run ledger — no LLM. */
export async function buildTrends(opts: { scenario?: string; last?: number } = {}): Promise<TrendsReport> {
  if (opts.scenario) {
    let runs = await runsForScenario(opts.scenario);
    if (opts.last && opts.last > 0) runs = runs.slice(-opts.last);
    return {
      scenario: opts.scenario,
      scenarios: [summarize(opts.scenario, runs)],
      timeline: runs.map((r) => ({ at: r.started_at, result: r.result, cache: r.cache, total_ms: r.duration_ms.total, cost_usd: r.estimated_cost_usd })),
    };
  }
  const byId = new Map<string, RunMetrics[]>();
  for (const r of await readRuns()) {
    const arr = byId.get(r.scenario_id) ?? [];
    arr.push(r);
    byId.set(r.scenario_id, arr);
  }
  const scenarios = [...byId.entries()]
    .map(([id, runs]) => summarize(id, runs))
    // worst first: lowest pass rate, then most runs — problems surface at the top.
    .sort((a, b) => a.pass_rate - b.pass_rate || b.runs - a.runs);
  return { scenarios };
}

const spark = (recent: Array<"pass" | "fail">): string => recent.map((r) => (r === "pass" ? "✓" : "✗")).join("");

export function printTrends(t: TrendsReport): void {
  if (t.scenarios.length === 0 || t.scenarios[0].runs === 0) {
    console.log(t.scenario ? `no runs recorded for "${t.scenario}" yet.` : "no runs in the ledger yet — run a scenario first.");
    return;
  }
  if (t.timeline) {
    const s = t.scenarios[0];
    console.log(`\n${s.scenario_id} — ${s.passed}/${s.runs} passed (${Math.round(s.pass_rate * 100)}%) · avg ${s.avg_ms} ms · avg $${s.avg_cost_usd}`);
    console.log(`  recent: ${spark(s.recent)}`);
    for (const r of t.timeline.slice(-RECENT)) {
      console.log(`  ${r.result === "passed" ? "✓" : "✗"} ${r.at}  cache=${r.cache}  ${r.total_ms} ms  $${r.cost_usd}`);
    }
    return;
  }
  console.log(`\n${t.scenarios.length} scenario(s) — worst pass-rate first:`);
  const pad = Math.min(40, Math.max(...t.scenarios.map((s) => s.scenario_id.length)));
  for (const s of t.scenarios) {
    console.log(`  ${s.scenario_id.padEnd(pad)}  ${String(Math.round(s.pass_rate * 100)).padStart(3)}%  ${String(s.runs).padStart(3)} run(s)  avg ${String(s.avg_ms).padStart(6)} ms  $${s.avg_cost_usd}  ${spark(s.recent)}`);
  }
}
