import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { CACHE_DIR, clearCache } from "./cache.js";
import { RUNS_DIR } from "./metrics.js";
import { GeminiPlanner } from "./planner.js";
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
 * Protocolo de medição do doc 06 (Fases A, B e C) + critérios C1–C5.
 * Cada execução individual também grava seu runs/<ts>-<cenario>.json normal.
 */
export async function runBench(scenarioId: string): Promise<boolean> {
  const scenario = await loadScenario(scenarioId);
  const planner = new GeminiPlanner();

  // ── Fase A — Geração (viabilidade do Gemini) ────────────────────────────
  console.log(`\n[bench] Fase A — 5 gerações com --no-cache (${scenarioId})`);
  await clearCache();
  const phaseA: RunMetrics[] = [];
  for (let i = 1; i <= 5; i++) {
    const m = await runScenario(scenario, planner, { useCache: false });
    console.log(
      `[bench]   A${i}: ${m.result} llm_calls=${m.llm_calls} tokens=${m.tokens.input}/${m.tokens.output} ` +
        `custo=US$${m.estimated_cost_usd} total=${m.duration_ms.total}ms` +
        (m.failure ? ` [${m.failure.kind}] ${m.failure.message.slice(0, 80)}` : ""),
    );
    phaseA.push(m);
  }

  // ── Fase B — Replay (determinismo e economia) ───────────────────────────
  console.log(`\n[bench] Fase B — popula cache + 10 replays`);
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
    console.log("[bench]   seed falhou — Fase B abortada");
  }

  // ── Fase C — Falha e re-planejamento ────────────────────────────────────
  console.log(`\n[bench] Fase C — seletor quebrado no cache → re-planejamento`);
  let phaseC: { broken: RunMetrics; replayAfter: RunMetrics } | null = null;
  const cacheFile = path.join(CACHE_DIR, `${scenarioId}.json`);
  try {
    const entry = JSON.parse(await readFile(cacheFile, "utf8")) as CacheEntry;
    const clickAction = entry.plan.actions.find((a) => a.type === "click" && a.target);
    if (!clickAction) throw new Error("nenhuma ação click no plano cacheado para quebrar");
    clickAction.target!.selector = `${clickAction.target!.selector}-x`;
    await writeFile(cacheFile, JSON.stringify(entry, null, 2));
    console.log(`[bench]   seletor quebrado: ${clickAction.target!.selector} (ação ${clickAction.id})`);

    const broken = await runScenario(scenario, planner, { useCache: true });
    console.log(
      `[bench]   run pós-quebra: ${broken.result} cache=${broken.cache} llm_calls=${broken.llm_calls}` +
        (broken.failure ? ` [${broken.failure.kind}]` : ""),
    );
    const replayAfter = await runScenario(scenario, planner, { useCache: true });
    console.log(`[bench]   replay seguinte: ${replayAfter.result} cache=${replayAfter.cache} llm_calls=${replayAfter.llm_calls}`);
    phaseC = { broken, replayAfter };
  } catch (err) {
    console.log(`[bench]   Fase C abortada: ${err instanceof Error ? err.message : err}`);
  }

  // ── Critérios C1–C5 (doc 06) ────────────────────────────────────────────
  const aPassed = phaseA.filter((m) => m.result === "passed" && m.llm_calls <= 2);
  const bPassed = phaseB.filter((m) => m.result === "passed" && m.llm_calls === 0 && m.cache === "hit");
  const genAvgMs = avg(phaseA.filter((m) => m.result === "passed").map((m) => m.duration_ms.total));
  const replayAvgMs = avg(bPassed.map((m) => m.duration_ms.total));
  const genCosts = phaseA.map((m) => m.estimated_cost_usd);
  const replayCost = phaseB.reduce((a, m) => a + m.estimated_cost_usd, 0);
  const speedup = replayAvgMs > 0 ? genAvgMs / replayAvgMs : 0;

  const criteria: CriterionResult[] = [
    {
      id: "C1",
      description: "Planos válidos na 1ª geração (≤1 retry + execução completa) ≥ 4/5",
      passed: aPassed.length >= 4,
      measured: `${aPassed.length}/5`,
    },
    {
      id: "C2",
      description: "Replay sem LLM: 10/10 sucessos com llm_calls=0",
      passed: bPassed.length === 10,
      measured: `${bPassed.length}/10`,
    },
    {
      id: "C3",
      description: "Replay ≥ 5x mais rápido que execução com planejamento",
      passed: speedup >= 5,
      measured: `${speedup.toFixed(1)}x (geração ${genAvgMs}ms vs replay ${replayAvgMs}ms)`,
    },
    {
      id: "C4",
      description: "Custo de LLM do replay = US$ 0 (custo por geração documentado)",
      passed: phaseB.length > 0 && replayCost === 0,
      measured: `replay US$${replayCost} | geração média US$${(genCosts.reduce((a, b) => a + b, 0) / (genCosts.length || 1)).toFixed(6)}`,
    },
    {
      id: "C5",
      description: "Falha detectada por pós-condição + re-plano ok + replay seguinte llm_calls=0",
      passed:
        !!phaseC &&
        phaseC.broken.cache === "invalidated" &&
        phaseC.broken.result === "passed" &&
        phaseC.broken.llm_calls > 0 &&
        phaseC.replayAfter.result === "passed" &&
        phaseC.replayAfter.llm_calls === 0,
      measured: phaseC
        ? `pós-quebra: ${phaseC.broken.result}/cache=${phaseC.broken.cache}/llm=${phaseC.broken.llm_calls}; replay: ${phaseC.replayAfter.result}/llm=${phaseC.replayAfter.llm_calls}`
        : "não executada",
    },
  ];

  console.log(`\n[bench] ══ Resultado ${scenarioId} ══`);
  for (const c of criteria) {
    console.log(`[bench] ${c.passed ? "✅" : "❌"} ${c.id} — ${c.description}`);
    console.log(`[bench]      medido: ${c.measured}`);
  }

  const summary = {
    scenario_id: scenarioId,
    finished_at: new Date().toISOString(),
    criteria,
    phaseA,
    phaseB,
    phaseC,
  };
  const summaryFile = path.join(RUNS_DIR, `bench-${scenarioId}-${Date.now()}.json`);
  await writeFile(summaryFile, JSON.stringify(summary, null, 2));
  console.log(`[bench] resumo gravado em ${summaryFile}`);

  return criteria.every((c) => c.passed);
}
