import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { cacheDir, clearCache } from "./cache.js";
import { runsDir } from "./metrics.js";
import { LlmPlanner } from "./planner.js";
import { runScenario } from "./runner.js";
import { loadScenario } from "./scenario.js";
import type { CacheEntry, RunMetrics } from "./types.js";

interface CriterionResult {
  id: string;
  description: string;
  passed: boolean;
  measured: string;
}

const avg = (xs: number[]): number => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);

/**
 * Measurement protocol from doc 06 (Phases A, B and C) + criteria C1–C5.
 * Each individual run also writes its normal runs/<ts>-<scenario>.json.
 */
export async function runBench(scenarioId: string, benchOpts: { useMap?: boolean } = {}): Promise<boolean> {
  const scenario = await loadScenario(scenarioId);
  const planner = new LlmPlanner({ useMap: benchOpts.useMap });

  // ── Phase A — Generation (Gemini viability) ─────────────────────────────
  console.log(`\n[bench] Phase A — 5 generations with --no-cache (${scenarioId})`);
  await clearCache();
  const phaseA: RunMetrics[] = [];
  for (let i = 1; i <= 5; i++) {
    const m = await runScenario(scenario, planner, { useCache: false });
    console.log(
      `[bench]   A${i}: ${m.result} llm_calls=${m.llm_calls} tokens=${m.tokens.input}/${m.tokens.output} prompt_chars=${m.prompt_chars ?? "-"} ` +
        `cost=US$${m.estimated_cost_usd} total=${m.duration_ms.total}ms` +
        (m.failure ? ` [${m.failure.kind}] ${m.failure.message.slice(0, 80)}` : ""),
    );
    phaseA.push(m);
  }

  // ── Phase B — Replay (determinism and savings) ──────────────────────────
  console.log(`\n[bench] Phase B — populate cache + 10 replays`);
  const seed = await runScenario(scenario, planner, { useCache: true });
  console.log(`[bench]   seed: ${seed.result} cache=${seed.cache} llm_calls=${seed.llm_calls}`);
  const phaseB: RunMetrics[] = [];
  if (seed.result === "passed") {
    for (let i = 1; i <= 10; i++) {
      const m = await runScenario(scenario, planner, { useCache: true });
      console.log(`[bench]   B${i}: ${m.result} cache=${m.cache} llm_calls=${m.llm_calls} total=${m.duration_ms.total}ms`);
      phaseB.push(m);
    }
  } else {
    console.log("[bench]   seed failed — Phase B aborted");
  }

  // ── Phase C — Failure and re-planning ───────────────────────────────────
  console.log(`\n[bench] Phase C — broken selector in the cache → re-planning`);
  let phaseC: { broken: RunMetrics; replayAfter: RunMetrics } | null = null;
  const cacheFile = path.join(cacheDir(), `${scenarioId}.json`);
  try {
    const entry = JSON.parse(await readFile(cacheFile, "utf8")) as CacheEntry;
    // Post-E3 a plan may be just { use } + verifications: break the first
    // action with a target (click/fill/wait_for), not only click.
    const clickAction = entry.plan.actions.find((a) => (a.type === "click" || a.type === "fill" || a.type === "wait_for") && a.target);
    if (!clickAction) throw new Error("no breakable action (with target) in the cached plan");
    clickAction.target!.selector = `${clickAction.target!.selector}-x`;
    await writeFile(cacheFile, JSON.stringify(entry, null, 2));
    console.log(`[bench]   broken selector: ${clickAction.target!.selector} (action ${clickAction.id})`);

    const broken = await runScenario(scenario, planner, { useCache: true });
    console.log(
      `[bench]   post-break run: ${broken.result} cache=${broken.cache} llm_calls=${broken.llm_calls}` +
        (broken.failure ? ` [${broken.failure.kind}]` : ""),
    );
    const replayAfter = await runScenario(scenario, planner, { useCache: true });
    console.log(`[bench]   next replay: ${replayAfter.result} cache=${replayAfter.cache} llm_calls=${replayAfter.llm_calls}`);
    phaseC = { broken, replayAfter };
  } catch (err) {
    console.log(`[bench]   Phase C aborted: ${err instanceof Error ? err.message : err}`);
  }

  // ── Criteria C1–C5 (doc 06) ─────────────────────────────────────────────
  // C1's "≤1 retry" refers to semantic retries (plan rejected); re-calls due to
  // transient API failures (MAX_TOKENS degeneration) do not count against the criterion.
  const aPassed = phaseA.filter((m) => m.result === "passed" && (m.plan_semantic_retries ?? 0) <= 1);
  const bPassed = phaseB.filter((m) => m.result === "passed" && m.llm_calls === 0 && m.cache === "hit");
  const genAvgMs = avg(phaseA.filter((m) => m.result === "passed").map((m) => m.duration_ms.total));
  const replayAvgMs = avg(bPassed.map((m) => m.duration_ms.total));
  const genCosts = phaseA.map((m) => m.estimated_cost_usd);
  const replayCost = phaseB.reduce((a, m) => a + m.estimated_cost_usd, 0);
  const speedup = replayAvgMs > 0 ? genAvgMs / replayAvgMs : 0;

  const criteria: CriterionResult[] = [
    {
      id: "C1",
      description: "Valid plans on the 1st generation (≤1 retry + complete execution) ≥ 4/5",
      passed: aPassed.length >= 4,
      measured: `${aPassed.length}/5`,
    },
    {
      id: "C2",
      description: "LLM-free replay: 10/10 successes with llm_calls=0",
      passed: bPassed.length === 10,
      measured: `${bPassed.length}/10`,
    },
    {
      id: "C3",
      description: "Replay ≥ 5x faster than execution with planning",
      passed: speedup >= 5,
      measured: `${speedup.toFixed(1)}x (generation ${genAvgMs}ms vs replay ${replayAvgMs}ms)`,
    },
    {
      id: "C4",
      description: "Replay LLM cost = US$ 0 (per-generation cost documented)",
      passed: phaseB.length > 0 && replayCost === 0,
      measured: `replay US$${replayCost} | average generation US$${(genCosts.reduce((a, b) => a + b, 0) / (genCosts.length || 1)).toFixed(6)}`,
    },
    {
      id: "C5",
      description: "Failure detected by postcondition + re-plan ok + next replay llm_calls=0",
      passed:
        !!phaseC &&
        phaseC.broken.cache === "invalidated" &&
        phaseC.broken.result === "passed" &&
        phaseC.broken.llm_calls > 0 &&
        phaseC.replayAfter.result === "passed" &&
        phaseC.replayAfter.llm_calls === 0,
      measured: phaseC
        ? `post-break: ${phaseC.broken.result}/cache=${phaseC.broken.cache}/llm=${phaseC.broken.llm_calls}; replay: ${phaseC.replayAfter.result}/llm=${phaseC.replayAfter.llm_calls}`
        : "not executed",
    },
  ];

  console.log(`\n[bench] ══ Result ${scenarioId} ══`);
  for (const c of criteria) {
    console.log(`[bench] ${c.passed ? "✅" : "❌"} ${c.id} — ${c.description}`);
    console.log(`[bench]      measured: ${c.measured}`);
  }

  const summary = {
    scenario_id: scenarioId,
    finished_at: new Date().toISOString(),
    criteria,
    phaseA,
    phaseB,
    phaseC,
  };
  const summaryFile = path.join(runsDir(), `bench-${scenarioId}-${Date.now()}.json`);
  await writeFile(summaryFile, JSON.stringify(summary, null, 2));
  console.log(`[bench] summary written to ${summaryFile}`);

  return criteria.every((c) => c.passed);
}
