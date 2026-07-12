import { launchBrowser, type Browser } from "./browser.js";
import { getCached, invalidate, recordReplay, saveCached } from "./cache.js";
import { executePlan, type ExecutionResult } from "./executor.js";
import { estimateCostUsd, writeRunMetrics } from "./metrics.js";
import type { Plan, RunMetrics, Scenario } from "./types.js";

export interface PlanGeneration {
  plan: Plan;
  llm_calls: number;
  model: string;
  planning_mode: "full" | "incremental";
  tokens: { input: number; output: number };
  /** Retries semânticos usados (plano reprovado na validação); exclui re-chamadas transientes. */
  semantic_retries: number;
  /** Assinatura da página inicial capturada no snapshot do planejamento (E1). */
  start_sig?: string;
}

/** Única fronteira com o LLM (implementada em planner.ts; fake nos testes). */
export interface Planner {
  generate(scenario: Scenario, browser: Browser, failureContext?: string): Promise<PlanGeneration>;
}

export interface RunOptions {
  /** false = --no-cache: não lê nem grava cache (mede o caminho LLM isoladamente). */
  useCache: boolean;
}

export class PlanGenerationError extends Error {
  constructor(
    message: string,
    readonly tokens: { input: number; output: number },
    readonly llm_calls: number,
  ) {
    super(message);
  }
}

/**
 * Orquestra 1 execução: cache → (planejador) → executor/verificador → cache.save → métricas.
 * Grava runs/<timestamp>-<cenario>.json e devolve as métricas.
 */
export async function runScenario(
  scenario: Scenario,
  planner: Planner,
  opts: RunOptions,
): Promise<RunMetrics> {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();

  const metrics: RunMetrics = {
    scenario_id: scenario.scenario_id,
    started_at: startedAt,
    cache: "miss",
    llm_calls: 0,
    llm_model: null,
    planning_mode: null,
    plan_semantic_retries: null,
    sig_mismatch: null,
    tokens: { input: 0, output: 0 },
    estimated_cost_usd: 0,
    duration_ms: { total: 0, planning: 0, execution: 0 },
    actions: [],
    result: "failed",
    failure: null,
  };

  const browser = await launchBrowser();
  try {
    const cached = opts.useCache ? await getCached(scenario) : null;

    if (cached) {
      metrics.cache = "hit";
      metrics.plan = cached.plan;
      const execStart = Date.now();
      const result = await executePlan(browser, cached.plan);
      metrics.duration_ms.execution = Date.now() - execStart;
      metrics.actions = result.actions;

      // E1, política leniente: sig divergente é sinal, não bloqueio — o
      // replay segue; se a verificação falhar, a invalidação normal age.
      if (result.start_sig && cached.key.start_sig) {
        metrics.sig_mismatch = result.start_sig !== cached.key.start_sig;
        if (metrics.sig_mismatch) {
          console.warn(
            `[windup] aviso: assinatura da página inicial mudou (${cached.key.start_sig} → ${result.start_sig}) — replay segue (política leniente)`,
          );
        }
      }

      if (result.ok) {
        await recordReplay(cached);
        metrics.result = "passed";
        return metrics;
      }

      if (result.failure?.kind === "network") {
        // Falha de rede não diz nada sobre o plano: não invalida (doc 05).
        metrics.failure = result.failure;
        return metrics;
      }

      // Replay falhou por verificação: invalida → re-planeja o fluxo inteiro (doc 03).
      await invalidate(cached);
      metrics.cache = "invalidated";
      const failureContext = `O plano anterior falhou na ação ${result.failure?.action_id}: ${result.failure?.message}`;
      const replanned = await generateAndExecute(scenario, planner, browser, metrics, failureContext);
      if (replanned.ok && opts.useCache) await saveCached(scenario, replanned.plan!, replanned.start_sig);
      return metrics;
    }

    const generated = await generateAndExecute(scenario, planner, browser, metrics);
    if (generated.ok && opts.useCache) await saveCached(scenario, generated.plan!, generated.start_sig);
    return metrics;
  } finally {
    metrics.duration_ms.total = Date.now() - startedMs;
    metrics.estimated_cost_usd = estimateCostUsd(metrics.tokens);
    await browser.close();
    await writeRunMetrics(metrics);
  }
}

async function generateAndExecute(
  scenario: Scenario,
  planner: Planner,
  browser: Browser,
  metrics: RunMetrics,
  failureContext?: string,
): Promise<{ ok: boolean; plan?: Plan; start_sig?: string }> {
  const planningStart = Date.now();
  let generation: PlanGeneration;
  try {
    generation = await planner.generate(scenario, browser, failureContext);
  } catch (err) {
    metrics.duration_ms.planning += Date.now() - planningStart;
    if (err instanceof PlanGenerationError) {
      metrics.llm_calls += err.llm_calls;
      metrics.tokens.input += err.tokens.input;
      metrics.tokens.output += err.tokens.output;
    }
    metrics.failure = {
      kind: "plan_invalid",
      action_id: null,
      message: err instanceof Error ? err.message : String(err),
    };
    return { ok: false };
  }
  metrics.duration_ms.planning += Date.now() - planningStart;
  metrics.llm_calls += generation.llm_calls;
  metrics.llm_model = generation.model;
  metrics.planning_mode = generation.planning_mode;
  metrics.plan_semantic_retries = generation.semantic_retries;
  metrics.tokens.input += generation.tokens.input;
  metrics.tokens.output += generation.tokens.output;
  metrics.plan = generation.plan;

  const execStart = Date.now();
  const result: ExecutionResult = await executePlan(browser, generation.plan);
  metrics.duration_ms.execution += Date.now() - execStart;
  metrics.actions = result.actions;

  if (!result.ok) {
    // Plano recém-gerado falhou: aborta (FALHA_DE_PLANO no doc 03).
    metrics.failure = result.failure;
    return { ok: false };
  }

  metrics.result = "passed";
  return { ok: true, plan: generation.plan, start_sig: generation.start_sig ?? result.start_sig ?? undefined };
}
