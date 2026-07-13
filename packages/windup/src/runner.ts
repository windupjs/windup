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
  /** Model company/provider ("google", "openai") — goes into the ledger. */
  provider?: string;
  planning_mode: "full" | "incremental";
  tokens: { input: number; output: number };
  /** Semantic retries used (plan rejected by validation); excludes transient re-calls. */
  semantic_retries: number;
  /** Signature of the initial page captured in the planning snapshot (E1). */
  start_sig?: string;
  /** Planning prompt size in chars (required by the E2 criterion). */
  prompt_chars?: number;
}

/** The only boundary with the LLM (implemented in planner.ts; faked in tests). */
export interface Planner {
  generate(scenario: Scenario, browser: Browser, failureContext?: string, opts?: { skipGoto?: boolean }): Promise<PlanGeneration>;
}

/** Scenario loader by id (injectable in tests; the real one is loadScenario). */
export type ScenarioLoader = (id: string) => Promise<Scenario & { start_url: string }>;

const MAX_DEPENDENCY_DEPTH = 5;

/**
 * Resolves the depends_on chain in execution order (post-order, dedupe),
 * with cycle detection and a depth cap. Exported for testing.
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
  /** false = --no-cache: neither reads nor writes cache (measures the LLM path in isolation). */
  useCache: boolean;
  /** true = --summary: 1 extra LLM call at the end reporting the run in prose (opt-in; replays stay $0 by default). */
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
 * Orchestrates 1 run: cache → (planner) → executor/verifier → cache.save → metrics.
 * Writes runs/<timestamp>-<scenario>.json and returns the metrics.
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

  // Passive map collection (E2): always on — every run collects.
  // Using the map IN THE PROMPT is what's optional (--no-map, in the planner).
  const mapStore = await SiteMapStore.load(getContext().paths.mapFile);
  const collector: StepCollector = {
    onPage: (obs) => mapStore.upsertPage(obs),
    onTransition: (from, action, to) => mapStore.recordTransition(from, action, to),
  };

  const browser = await launchBrowser();
  try {
    // Dependencies (depends_on): each one runs IN THE SAME session, with its
    // own cache/replay and self-healing. Their final state is this
    // scenario's starting point.
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

      // E3: the cache stores the plan WITH { use } references (an updated
      // fragment propagates); expansion happens on every run.
      let expandedPlan;
      try {
        // The cached plan runs in the CURRENT environment: the start_url origin is
        // the one resolved now (today's port/host), the actions are the usual ones.
        expandedPlan = expandPlan({ ...cached.plan, start_url: scenario.start_url ?? cached.plan.start_url }, await loadFragments());
      } catch (err) {
        // Fragment removed/renamed: the cached plan became orphaned →
        // invalidate and re-plan, as in a verification failure.
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

      // E1, lenient policy: a diverging sig is a signal, not a blocker — the
      // replay proceeds; if verification fails, normal invalidation kicks in.
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
        // A network failure says nothing about the plan: do not invalidate (doc 05).
        metrics.failure = result.failure;
        return metrics;
      }

      // Replay failed on verification: invalidate → re-plan the whole flow (doc 03).
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
    if (metrics.result === "failed" && metrics.failure) {
      try {
        metrics.failure_snapshot = (await browser.snapshotTree()).slice(0, 6000);
      } catch {
        // the browser may have died; the snapshot is diagnostic, never blocking
      }
    }
    // TEST duration and cost close before the summary: prose is not execution.
    metrics.duration_ms.total = Date.now() - startedMs;
    metrics.estimated_cost_usd = estimateCostUsd(metrics.tokens, metrics.llm_model);
    if (opts.summary) {
      try {
        const { generateRunSummary } = await import("./summary.js");
        metrics.summary = await generateRunSummary(scenario, metrics, browser);
        metrics.estimated_cost_usd = Number((metrics.estimated_cost_usd + metrics.summary.est_cost_usd).toFixed(6));
      } catch (err) {
        // the summary is an accessory: it never crashes nor changes the run result
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
    // Freshly generated plan failed: abort (FALHA_DE_PLANO in doc 03).
    metrics.failure = result.failure;
    return { ok: false };
  }

  metrics.result = "passed";
  return { ok: true, plan: generation.plan, start_sig: generation.start_sig ?? result.start_sig ?? undefined };
}

/**
 * Runs ONE dependency in the current session: cache replay when available, with
 * the same self-healing as the normal flow (verification failed → invalidate →
 * re-plan → save into THE DEPENDENCY's cache). Costs/tokens add to the
 * dependent scenario's metrics; the dependency does not get its own ledger
 * record (it ran as setup, not as a test).
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
  // the dependency's partial trace does not belong to the main scenario —
  // including the result: without this reset, a successfully re-planned dependency
  // + a scenario failing afterwards became a false PASS (seen in dogfooding).
  metrics.failure = null;
  metrics.actions = [];
  metrics.result = "failed";
  if (generated.ok) {
    if (useCache) await saveCached(dep, generated.plan!, generated.start_sig);
    return { ok: true, cache, llm_calls: llmCalls };
  }
  return { ok: false, cache, llm_calls: llmCalls, failure };
}
