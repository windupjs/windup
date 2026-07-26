import { getCached, recentStaleCount } from "./cache.js";
import { runsForScenario } from "./ledger.js";
import { loadScenario } from "./scenario.js";
import { resolveDependencyChain } from "./runner.js";
import type { RunMetrics } from "./types.js";

export interface WhyReport {
  scenario_id: string;
  task: string;
  cache: { ready: boolean; replay_count?: number; replay_failures?: number; plan_generation?: number };
  churn: number;
  depends_on: string[];
  history: { runs: number; passed: number; avg_cost_usd: number; avg_total_ms: number };
  last?: {
    at: string;
    result: "passed" | "failed";
    cache: string;
    llm_calls: number;
    cost_usd: number;
    total_ms: number;
    flaky?: boolean;
    attempts?: number;
    failure?: { kind: string; action_id: string | null; message: string };
    has_snapshot: boolean;
  };
}

/** Everything the ledger + cache already know about one scenario, in one place. No LLM, no browser. */
export async function buildWhy(scenarioId: string): Promise<WhyReport> {
  const scenario = await loadScenario(scenarioId);
  const cached = await getCached(scenario);
  const churn = await recentStaleCount(scenarioId);
  const depChain = scenario.depends_on?.length ? await resolveDependencyChain(scenario, loadScenario) : [];
  const runs = await runsForScenario(scenarioId);
  const passed = runs.filter((r) => r.result === "passed").length;
  const avg = (pick: (r: RunMetrics) => number): number => (runs.length ? runs.reduce((s, r) => s + pick(r), 0) / runs.length : 0);
  const last = runs[runs.length - 1];

  return {
    scenario_id: scenarioId,
    task: scenario.task,
    cache: cached
      ? { ready: true, replay_count: cached.stats.replay_count, replay_failures: cached.stats.replay_failures, plan_generation: cached.stats.plan_generation }
      : { ready: false },
    churn,
    depends_on: depChain.map((d) => d.scenario_id),
    history: { runs: runs.length, passed, avg_cost_usd: Number(avg((r) => r.estimated_cost_usd).toFixed(6)), avg_total_ms: Math.round(avg((r) => r.duration_ms.total)) },
    last: last
      ? {
          at: last.started_at,
          result: last.result,
          cache: last.cache,
          llm_calls: last.llm_calls,
          cost_usd: last.estimated_cost_usd,
          total_ms: last.duration_ms.total,
          ...(last.flaky ? { flaky: true, attempts: last.attempts } : {}),
          ...(last.failure ? { failure: last.failure } : {}),
          has_snapshot: Boolean(last.failure_snapshot),
        }
      : undefined,
  };
}

export function printWhy(w: WhyReport): void {
  console.log(`\n${w.scenario_id} — ${w.task}`);
  console.log(
    w.cache.ready
      ? `  cache:    ready to replay ($0) — replays ${w.cache.replay_count} (${w.cache.replay_failures} failed), plan gen #${w.cache.plan_generation}`
      : `  cache:    no compatible plan — the next run will PLAN (1 LLM call)`,
  );
  if (w.churn > 0) console.log(`  churn:    ${w.churn} recent re-plan(s) — the app may lack a stable selector or have a race (run --suggest for a diagnosis)`);
  if (w.depends_on.length) console.log(`  depends:  ${w.depends_on.join(" → ")}`);
  if (w.history.runs > 0) {
    console.log(`  history:  ${w.history.passed}/${w.history.runs} passed · avg $${w.history.avg_cost_usd} · avg ${w.history.avg_total_ms} ms`);
  } else {
    console.log(`  history:  never run`);
  }
  if (w.last) {
    const l = w.last;
    const flake = l.flaky ? ` (flaky — passed on attempt ${l.attempts})` : "";
    console.log(`  last:     ${l.result.toUpperCase()}${flake} at ${l.at} — cache=${l.cache}, llm=${l.llm_calls}, $${l.cost_usd}, ${l.total_ms} ms`);
    if (l.failure) console.log(`            ↳ [${l.failure.kind}] ${l.failure.action_id ?? "-"}: ${l.failure.message}`);
    if (l.has_snapshot) console.log(`            ↳ a failure snapshot is stored in the run ledger`);
  }
}
