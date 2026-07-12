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

// Todos os comandos (menos init) resolvem windup.config.* e montam o contexto.
program.hook("preAction", async (_this, actionCommand) => {
  if (actionCommand.name() === "init") return;
  const { createContextFromConfig, setContext } = await import("./context.js");
  setContext(await createContextFromConfig());
});

program
  .command("init")
  .description("Cria windup.config.ts, .windup/ e um cenário de exemplo")
  .action(async () => {
    const { runInit } = await import("./init.js");
    await runInit();
  });

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
  .option("--no-map", "não usa o mapa do site no prompt do planejador (A/B do E2)")
  .option("--repeat <n>", "executa N vezes em sequência", "1")
  .action(async (cenario: string, opts: { cache: boolean; map: boolean; repeat: string }) => {
    const scenario = await loadScenario(cenario);
    const planner = new GeminiPlanner({ useMap: opts.map });
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
  .option("--no-map", "não usa o mapa do site no prompt do planejador (A/B do E2)")
  .action(async (cenario: string, opts: { map: boolean }) => {
    const ok = await runBench(cenario, { useMap: opts.map });
    process.exitCode = ok ? 0 : 1;
  });

program
  .command("scan")
  .description("Indexação estática do projeto (rotas por convenção + elementos) → mapa do site")
  .option("--update", "re-indexa só o que mudou desde o último scan (git diff)")
  .action(async (opts: { update?: boolean }) => {
    const { runScan } = await import("./scan/scan.js");
    const summary = await runScan({ update: opts.update });
    console.log(
      `[windup] scan: framework=${summary.framework ?? "?"} rotas=${summary.routes} elementos=${summary.elements} → ${summary.mapFile}`,
    );
  });

program
  .command("sig <url>")
  .description("Calcula a assinatura estrutural de uma página (E1) — ferramenta de diagnóstico")
  .option("--repeat <n>", "recalcula N vezes com re-navegação (teste de estabilidade)", "1")
  .action(async (url: string, opts: { repeat: string }) => {
    const { launchBrowser } = await import("./browser.js");
    const browser = await launchBrowser();
    try {
      const repeat = Number.parseInt(opts.repeat, 10);
      const sigs: string[] = [];
      for (let i = 1; i <= repeat; i++) {
        await browser.goto(url);
        const deadline = Date.now() + 10_000;
        while ((await browser.interactiveElementsRaw()).length === 0 && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 100));
        }
        const sig = await browser.pageSignature();
        sigs.push(sig);
        console.log(`[windup] ${i}/${repeat} ${sig}`);
      }
      const stable = new Set(sigs).size === 1;
      if (repeat > 1) console.log(`[windup] estabilidade: ${stable ? "ESTÁVEL" : "INSTÁVEL"} (${new Set(sigs).size} sig(s) distinta(s))`);
      process.exitCode = stable ? 0 : 1;
    } finally {
      await browser.close();
    }
  });

program
  .command("status")
  .description("Estado do índice: páginas por origem, staleness, cenários cacheados, fragmentos")
  .action(async () => {
    const { getContext } = await import("./context.js");
    const { SiteMapStore } = await import("./sitemap.js");
    const { loadFragments } = await import("./fragments.js");
    const { readdir } = await import("node:fs/promises");
    const ctx = getContext();

    const store = await SiteMapStore.load(ctx.paths.mapFile);
    const bySource = store.countBySource();
    console.log(`[windup] mapa do site: ${store.pageCount} página(s)${store.lastScanSha ? ` | último scan: ${store.lastScanSha.slice(0, 8)}` : " | nunca escaneado"}`);
    for (const [source, count] of Object.entries(bySource)) console.log(`[windup]   ${source}: ${count}`);

    let cached: string[] = [];
    try {
      cached = (await readdir(ctx.paths.cacheDir)).filter((f) => f.endsWith(".json") && !f.includes(".stale-"));
    } catch {
      // sem cache ainda
    }
    console.log(`[windup] cenários cacheados: ${cached.length}${cached.length ? ` (${cached.map((f) => f.replace(".json", "")).join(", ")})` : ""}`);

    const fragments = await loadFragments();
    console.log(`[windup] fragmentos: ${fragments.length}${fragments.length ? ` (${fragments.map((f) => f.fragment_id).join(", ")})` : ""}`);
  });

const fragment = program.command("fragment").description("Gerencia fragmentos de trajetória (blocos reutilizáveis)");
fragment
  .command("extract <cenario> <range>")
  .description("Promove um trecho de plano cacheado a fragmento (ex.: windup fragment extract login a1..a3 --id login-padrao --description 'Login padrão')")
  .requiredOption("--id <id>", "id do fragmento (kebab-case)")
  .requiredOption("--description <desc>", "descrição humana (vai ao prompt do planejador)")
  .action(async (cenario: string, range: string, opts: { id: string; description: string }) => {
    const { extractFragment } = await import("./fragments.js");
    const file = await extractFragment(cenario, range, opts);
    console.log(`[windup] fragmento criado: ${file} (commite-o — é conhecimento curado do projeto)`);
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
