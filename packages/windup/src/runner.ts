import { launchBrowser, type Browser } from "./browser.js";
import { getCached, invalidate, recordReplay, saveCached } from "./cache.js";
import { loadScenario } from "./scenario.js";
import { getContext } from "./context.js";
import { executePlan, type ExecutionResult, type StepCollector } from "./executor.js";
import { expandPlan, loadFragments } from "./fragments.js";
import { estimateCostUsd, writeRunMetrics } from "./metrics.js";
import { SiteMapStore } from "./sitemap.js";
import type { Plan, RunMetrics, Scenario } from "./types.js";

export interface PlanGeneration {
  plan: Plan;
  llm_calls: number;
  model: string;
  /** Empresa/provider do modelo ("google", "openai") — vai para o ledger. */
  provider?: string;
  planning_mode: "full" | "incremental";
  tokens: { input: number; output: number };
  /** Retries semânticos usados (plano reprovado na validação); exclui re-chamadas transientes. */
  semantic_retries: number;
  /** Assinatura da página inicial capturada no snapshot do planejamento (E1). */
  start_sig?: string;
  /** Tamanho do prompt de planejamento em chars (exigência do critério E2). */
  prompt_chars?: number;
}

/** Única fronteira com o LLM (implementada em planner.ts; fake nos testes). */
export interface Planner {
  generate(scenario: Scenario, browser: Browser, failureContext?: string, opts?: { skipGoto?: boolean }): Promise<PlanGeneration>;
}

/** Carregador de cenários por id (injetável nos testes; o real é loadScenario). */
export type ScenarioLoader = (id: string) => Promise<Scenario & { start_url: string }>;

const MAX_DEPENDENCY_DEPTH = 5;

/**
 * Resolve a cadeia de depends_on em ordem de execução (pós-ordem, dedupe),
 * com detecção de ciclo e teto de profundidade. Exportada para teste.
 */
export async function resolveDependencyChain(scenario: Scenario, load: ScenarioLoader): Promise<Array<Scenario & { start_url: string }>> {
  const chain: Array<Scenario & { start_url: string }> = [];
  const seen = new Set<string>([scenario.scenario_id]);
  async function visit(ids: string[], depth: number, trail: string[]): Promise<void> {
    if (depth > MAX_DEPENDENCY_DEPTH) throw new Error(`dependency chain deeper than ${MAX_DEPENDENCY_DEPTH} (${trail.join(" -> ")})`);
    for (const id of ids) {
      if (trail.includes(id) || id === scenario.scenario_id) throw new Error(`dependency cycle: ${[...trail, id].join(" -> ")}`);
      if (seen.has(id)) continue;
      const dep = await load(id);
      await visit(dep.depends_on ?? [], depth + 1, [...trail, id]);
      seen.add(id);
      chain.push(dep);
    }
  }
  await visit(scenario.depends_on ?? [], 1, []);
  return chain;
}

export interface RunOptions {
  /** false = --no-cache: não lê nem grava cache (mede o caminho LLM isoladamente). */
  useCache: boolean;
  /** true = --summary: 1 chamada extra de LLM ao final relatando o run em prosa (opt-in; replays continuam $0 por padrão). */
  summary?: boolean;
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
    llm_provider: null,
    planning_mode: null,
    plan_semantic_retries: null,
    sig_mismatch: null,
    prompt_chars: null,
    tokens: { input: 0, output: 0 },
    estimated_cost_usd: 0,
    duration_ms: { total: 0, planning: 0, execution: 0 },
    actions: [],
    result: "failed",
    failure: null,
  };

  // Coleta passiva do mapa (E2): sempre ligada — toda execução é coleta.
  // O uso do mapa NO PROMPT é que é opcional (--no-map, no planejador).
  const mapStore = await SiteMapStore.load(getContext().paths.mapFile);
  const collector: StepCollector = {
    onPage: (obs) => mapStore.upsertPage(obs),
    onTransition: (from, action, to) => mapStore.recordTransition(from, action, to),
  };

  const browser = await launchBrowser();
  try {
    // Dependências (depends_on): cada uma roda NA MESMA sessão, com seu
    // próprio cache/replay e self-healing. O estado final delas é o ponto
    // de partida deste cenário.
    if (scenario.depends_on?.length) {
      metrics.dependencies = [];
      const chain = await resolveDependencyChain(scenario, loadScenario);
      for (const dep of chain) {
        const depStart = Date.now();
        const outcome = await runDependency(dep, planner, browser, metrics, collector, opts.useCache);
        metrics.dependencies.push({
          scenario_id: dep.scenario_id,
          cache: outcome.cache,
          llm_calls: outcome.llm_calls,
          result: outcome.ok ? "passed" : "failed",
          duration_ms: Date.now() - depStart,
        });
        if (!outcome.ok) {
          metrics.failure = {
            kind: "dependency",
            action_id: outcome.failure?.action_id ?? null,
            message: `dependency "${dep.scenario_id}" failed: ${outcome.failure?.message ?? "unknown"}`,
          };
          return metrics;
        }
      }
    }

    const skipGoto = (scenario as { continue_from_dependency?: boolean }).continue_from_dependency === true;
    const cached = opts.useCache ? await getCached(scenario) : null;

    if (cached) {
      metrics.cache = "hit";
      metrics.plan = cached.plan;

      // E3: o cache guarda o plano COM referências { use } (fragmento
      // atualizado propaga); a expansão acontece a cada execução.
      let expandedPlan;
      try {
        // O plano cacheado roda no ambiente ATUAL: a origem do start_url é a
        // resolvida agora (porta/host de hoje), as ações são as de sempre.
        expandedPlan = expandPlan({ ...cached.plan, start_url: scenario.start_url ?? cached.plan.start_url }, await loadFragments());
      } catch (err) {
        // Fragmento removido/renomeado: plano cacheado ficou órfão →
        // invalida e re-planeja, como numa falha de verificação.
        await invalidate(cached);
        metrics.cache = "invalidated";
        const context = `The cached plan is no longer valid: ${err instanceof Error ? err.message : err}`;
        const replanned = await generateAndExecute(scenario, planner, browser, metrics, collector, context, skipGoto);
        if (replanned.ok && opts.useCache) await saveCached(scenario, replanned.plan!, replanned.start_sig);
        return metrics;
      }

      const execStart = Date.now();
      const result = await executePlan(browser, expandedPlan, collector, { skipInitialGoto: skipGoto });
      metrics.duration_ms.execution = Date.now() - execStart;
      metrics.actions = result.actions;

      // E1, política leniente: sig divergente é sinal, não bloqueio — o
      // replay segue; se a verificação falhar, a invalidação normal age.
      if (result.start_sig && cached.key.start_sig) {
        metrics.sig_mismatch = result.start_sig !== cached.key.start_sig;
        if (metrics.sig_mismatch) {
          console.warn(
            `warning: start-page signature changed (${cached.key.start_sig} -> ${result.start_sig}) — replaying anyway (lenient mode)`,
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
      const failureContext = `The previous plan failed at action ${result.failure?.action_id}: ${result.failure?.message}`;
      const replanned = await generateAndExecute(scenario, planner, browser, metrics, collector, failureContext, skipGoto);
      if (replanned.ok && opts.useCache) await saveCached(scenario, replanned.plan!, replanned.start_sig);
      return metrics;
    }

    const generated = await generateAndExecute(scenario, planner, browser, metrics, collector, undefined, skipGoto);
    if (generated.ok && opts.useCache) await saveCached(scenario, generated.plan!, generated.start_sig);
    return metrics;
  } finally {
    // Duração e custo do TESTE fecham antes do resumo: prosa não é execução.
    metrics.duration_ms.total = Date.now() - startedMs;
    metrics.estimated_cost_usd = estimateCostUsd(metrics.tokens, metrics.llm_model);
    if (opts.summary) {
      try {
        const { generateRunSummary } = await import("./summary.js");
        metrics.summary = await generateRunSummary(scenario, metrics, browser);
        metrics.estimated_cost_usd = Number((metrics.estimated_cost_usd + metrics.summary.est_cost_usd).toFixed(6));
      } catch (err) {
        // resumo é acessório: nunca derruba nem altera o resultado do run
        console.warn(`warning: could not generate the run summary: ${err instanceof Error ? err.message : err}`);
      }
    }
    await browser.close();
    await mapStore.save();
    await writeRunMetrics(metrics);
  }
}

async function generateAndExecute(
  scenario: Scenario,
  planner: Planner,
  browser: Browser,
  metrics: RunMetrics,
  collector?: StepCollector,
  failureContext?: string,
  skipGoto = false,
): Promise<{ ok: boolean; plan?: Plan; start_sig?: string }> {
  const planningStart = Date.now();
  let generation: PlanGeneration;
  try {
    generation = await planner.generate(scenario, browser, failureContext, { skipGoto });
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
  metrics.llm_provider = generation.provider ?? null;
  metrics.planning_mode = generation.planning_mode;
  metrics.plan_semantic_retries = generation.semantic_retries;
  metrics.prompt_chars = generation.prompt_chars ?? null;
  metrics.tokens.input += generation.tokens.input;
  metrics.tokens.output += generation.tokens.output;
  metrics.plan = generation.plan;

  let expandedPlan;
  try {
    expandedPlan = expandPlan(generation.plan, await loadFragments());
  } catch (err) {
    metrics.failure = {
      kind: "plan_invalid",
      action_id: null,
      message: err instanceof Error ? err.message : String(err),
    };
    return { ok: false };
  }

  const execStart = Date.now();
  const result: ExecutionResult = await executePlan(browser, expandedPlan, collector, { skipInitialGoto: skipGoto });
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

/**
 * Executa UMA dependência na sessão atual: replay do cache quando há, com o
 * mesmo self-healing do fluxo normal (verificação falhou → invalida →
 * re-planeja → salva no cache DA DEPENDÊNCIA). Custos/tokens somam nas
 * métricas do cenário dependente; a dependência não gera registro próprio
 * no ledger (rodou como setup, não como teste).
 */
async function runDependency(
  dep: Scenario & { start_url: string },
  planner: Planner,
  browser: Browser,
  metrics: RunMetrics,
  collector: StepCollector,
  useCache: boolean,
): Promise<{ ok: boolean; cache: RunMetrics["cache"]; llm_calls: number; failure?: { action_id: string | null; message: string } }> {
  const { expandPlan, loadFragments } = await import("./fragments.js");
  const callsBefore = metrics.llm_calls;

  const cached = useCache ? await getCached(dep) : null;
  if (cached) {
    let plan: Plan;
    try {
      plan = expandPlan({ ...cached.plan, start_url: dep.start_url ?? cached.plan.start_url }, await loadFragments());
    } catch {
      await invalidate(cached);
      return replanDependency(dep, planner, browser, metrics, collector, useCache, "invalidated", callsBefore);
    }
    const result = await executePlan(browser, plan, collector);
    if (result.ok) {
      await recordReplay(cached);
      return { ok: true, cache: "hit", llm_calls: 0 };
    }
    if (result.failure?.kind === "network") {
      return { ok: false, cache: "hit", llm_calls: 0, failure: result.failure };
    }
    await invalidate(cached);
    const context = `The previous plan failed at action ${result.failure?.action_id}: ${result.failure?.message}`;
    return replanDependency(dep, planner, browser, metrics, collector, useCache, "invalidated", callsBefore, context);
  }
  return replanDependency(dep, planner, browser, metrics, collector, useCache, "miss", callsBefore);
}

async function replanDependency(
  dep: Scenario & { start_url: string },
  planner: Planner,
  browser: Browser,
  metrics: RunMetrics,
  collector: StepCollector,
  useCache: boolean,
  cache: RunMetrics["cache"],
  callsBefore: number,
  failureContext?: string,
): Promise<{ ok: boolean; cache: RunMetrics["cache"]; llm_calls: number; failure?: { action_id: string | null; message: string } }> {
  const generated = await generateAndExecute(dep, planner, browser, metrics, collector, failureContext);
  const llmCalls = metrics.llm_calls - callsBefore;
  const failure = metrics.failure ? { action_id: metrics.failure.action_id, message: metrics.failure.message } : undefined;
  // rastro parcial da dependência não pertence ao cenário principal
  metrics.failure = null;
  metrics.actions = [];
  if (generated.ok) {
    if (useCache) await saveCached(dep, generated.plan!, generated.start_sig);
    return { ok: true, cache, llm_calls: llmCalls };
  }
  return { ok: false, cache, llm_calls: llmCalls, failure };
}
