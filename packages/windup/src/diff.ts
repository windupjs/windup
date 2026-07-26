import { runsForScenario } from "./ledger.js";
import type { RunMetrics } from "./types.js";

export interface RunDiff {
  scenario_id: string;
  enough: boolean; // false when there aren't two runs to compare
  a?: RunSnap;
  b?: RunSnap;
  deltas?: { total_ms: number; cost_usd: number; actions: number };
}
interface RunSnap {
  at: string;
  result: "passed" | "failed";
  cache: string;
  llm_calls: number;
  cost_usd: number;
  total_ms: number;
  actions: number;
  failure_kind?: string;
}

const snap = (m: RunMetrics): RunSnap => ({
  at: m.started_at,
  result: m.result,
  cache: m.cache,
  llm_calls: m.llm_calls,
  cost_usd: m.estimated_cost_usd,
  total_ms: m.duration_ms.total,
  actions: m.actions?.length ?? 0,
  ...(m.failure ? { failure_kind: m.failure.kind } : {}),
});

/** Compares a scenario's two most recent runs — a regression check (result/cost/time/plan-size drift). */
export async function buildDiff(scenarioId: string): Promise<RunDiff> {
  const runs = await runsForScenario(scenarioId);
  if (runs.length < 2) return { scenario_id: scenarioId, enough: false };
  const a = runs[runs.length - 2]; // older
  const b = runs[runs.length - 1]; // newer
  return {
    scenario_id: scenarioId,
    enough: true,
    a: snap(a),
    b: snap(b),
    deltas: {
      total_ms: b.duration_ms.total - a.duration_ms.total,
      cost_usd: Number((b.estimated_cost_usd - a.estimated_cost_usd).toFixed(6)),
      actions: (b.actions?.length ?? 0) - (a.actions?.length ?? 0),
    },
  };
}

const sign = (n: number, unit = ""): string => (n > 0 ? `+${n}${unit}` : `${n}${unit}`);

export function printDiff(d: RunDiff): void {
  console.log(`\n${d.scenario_id} — last two runs`);
  if (!d.enough || !d.a || !d.b || !d.deltas) {
    console.log("  (need at least two runs to compare — run it again)");
    return;
  }
  const { a, b, deltas } = d;
  console.log(`  older (${a.at}): ${a.result.toUpperCase()} · cache=${a.cache} · ${a.total_ms} ms · $${a.cost_usd} · ${a.actions} actions${a.failure_kind ? ` · [${a.failure_kind}]` : ""}`);
  console.log(`  newer (${b.at}): ${b.result.toUpperCase()} · cache=${b.cache} · ${b.total_ms} ms · $${b.cost_usd} · ${b.actions} actions${b.failure_kind ? ` · [${b.failure_kind}]` : ""}`);
  const flipped = a.result !== b.result ? `  ⚠ result changed ${a.result} → ${b.result}` : "  result unchanged";
  console.log(flipped);
  console.log(`  Δ time ${sign(deltas.total_ms, " ms")} · Δ cost ${sign(deltas.cost_usd)} · Δ actions ${sign(deltas.actions)}`);
}
