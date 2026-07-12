#!/usr/bin/env node
import "dotenv/config";
import { Command } from "commander";
import { clearCache } from "./cache.js";
import { GeminiPlanner } from "./planner.js";
import { runScenario } from "./runner.js";
import { loadScenario } from "./scenario.js";
import { runBench } from "./bench.js";
import type { RunMetrics } from "./types.js";

const program = new Command();

program.name("windup").description("Windup — testes E2E em linguagem natural: a LLM planeja uma vez, o replay roda sozinho");

function printRun(metrics: RunMetrics, file: string | null = null): void {
  const status = metrics.result === "passed" ? "PASSOU" : "FALHOU";
  console.log(
    `[windup] ${metrics.scenario_id}: ${status} | cache=${metrics.cache} llm_calls=${metrics.llm_calls} ` +
      `total=${metrics.duration_ms.total}ms (plan=${metrics.duration_ms.planning}ms exec=${metrics.duration_ms.execution}ms) ` +
      `custo=US$${metrics.estimated_cost_usd}`,
  );
  if (metrics.failure) {
    console.log(`[windup]   falha: [${metrics.failure.kind}] ação=${metrics.failure.action_id ?? "-"} ${metrics.failure.message}`);
  }
}

program
  .command("run <cenario>")
  .description("Executa um cenário (usa cache se existir, senão planeja via Gemini)")
  .option("--no-cache", "ignora e não grava cache (mede o caminho LLM isoladamente)")
  .option("--repeat <n>", "executa N vezes em sequência", "1")
  .action(async (cenario: string, opts: { cache: boolean; repeat: string }) => {
    const scenario = await loadScenario(cenario);
    const planner = new GeminiPlanner();
    const repeat = Number.parseInt(opts.repeat, 10);
    let failures = 0;
    for (let i = 1; i <= repeat; i++) {
      if (repeat > 1) console.log(`[windup] execução ${i}/${repeat}`);
      const metrics = await runScenario(scenario, planner, { useCache: opts.cache });
      printRun(metrics);
      if (metrics.result !== "passed") failures += 1;
    }
    if (repeat > 1) console.log(`[windup] ${repeat - failures}/${repeat} execuções passaram`);
    process.exitCode = failures === 0 ? 0 : 1;
  });

program
  .command("bench <cenario>")
  .description("Roda o protocolo completo de validação (doc 06) e imprime o comparativo C1–C5")
  .action(async (cenario: string) => {
    const ok = await runBench(cenario);
    process.exitCode = ok ? 0 : 1;
  });

const cache = program.command("cache").description("Gerencia o cache de trajetórias");
cache
  .command("clear")
  .description("Apaga o cache de trajetórias")
  .action(async () => {
    await clearCache();
    console.log("[windup] cache de trajetórias apagado");
  });

program.parseAsync(process.argv);
