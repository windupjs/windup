import { launchBrowser, type Browser } from "./browser.js";
import { getCached, invalidate, recentStaleCount, recordReplay, saveCached } from "./cache.js";
import { loadScenario } from "./scenario.js";
import { getContext } from "./context.js";
import { executePlan, type ExecutionResult, type StepCollector } from "./executor.js";
import { expandPlan, loadFragments } from "./fragments.js";
import { instantiatePlan } from "./isomorph.js";
import { dropSnapshot, getSnapshot, saveSnapshot } from "./session-cache.js";
import { estimateCostUsd, writeRunMetrics } from "./metrics.js";
import { SiteMapStore } from "./sitemap.js";
import type { Plan, RunMetrics, Scenario } from "./types.js";
import { progress, streamEvent } from "./progress.js";
import { runHooks } from "./hooks.js";

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
  generate(scenario: Scenario, browser: Browser, failureContext?: string, opts?: { skipGoto?: boolean; preferredProvider?: string }): Promise<PlanGeneration>;
}

/** Scenario loader by id (injectable in tests; the real one is loadScenario). */
export type ScenarioLoader = (id: string) => Promise<Scenario & { start_url: string }>;

const MAX_DEPENDENCY_DEPTH = 5;

/**
 * Resolves the depends_on chain in execution order (post-order, dedupe),
 * with cycle detection and a depth cap. Exported for testing.
 */
/** Clear per-attempt state so a run can be retried (snapshot fast-path → full-chain fallback). */
function resetForFallback(m: RunMetrics): void {
  m.result = "failed";
  m.failure = null;
  m.actions = [];
  m.cache = "miss";
  m.plan = undefined;
  m.reused_session_from = null;
  m.sig_mismatch = null;
  m.duration_ms.execution = 0;
  m.duration_ms.dependencies = 0;
}

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
  /** true = --suggest: on a FAILED run, 1 extra LLM call proposes a concrete fix to the scenario (opt-in). */
  suggest?: boolean;
  /**
   * Shared site-map store for parallel runs: when provided, this run upserts
   * into it and does NOT save (the caller saves once after all runs). JS is
   * single-threaded, so concurrent synchronous upserts never race. When
   * absent, the run owns its own store and saves it in the finally.
   */
  sharedMap?: SiteMapStore;
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
  const mapStore = opts.sharedMap ?? (await SiteMapStore.load(getContext().paths.mapFile));
  const collector: StepCollector = {
    onPage: (obs) => mapStore.upsertPage(obs),
    onTransition: (from, action, to) => mapStore.recordTransition(from, action, to),
  };

  // Resolve the dependency chain and decide the fast path BEFORE launching, so a
  // cached replay whose dependency has a session snapshot can start the context
  // pre-authenticated and skip re-running the whole chain (feedback #4). The fast
  // path is only for REPLAYS (a first run plans anyway); a snapshot holds the
  // dependency's storageState + final URL.
  const skipGoto = (scenario as { continue_from_dependency?: boolean }).continue_from_dependency === true;
  const depChain = scenario.depends_on?.length ? await resolveDependencyChain(scenario, loadScenario) : [];
  const anchorId = depChain.length ? depChain[depChain.length - 1].scenario_id : null;
  const ownCached = opts.useCache ? await getCached(scenario) : null;
  const snapshot = anchorId && ownCached ? await getSnapshot(anchorId) : null;

  const launchStart = Date.now();
  let browser = await launchBrowser(snapshot ? { storageState: snapshot.storage_state } : {});
  metrics.duration_ms.setup = Date.now() - launchStart;

  // Runs the scenario's OWN plan (cached replay / isomorphic reuse / generate),
  // mutating metrics. `deferReplan` (snapshot attempt): a failed cached replay
  // does NOT invalidate/re-plan — it just returns failed so the caller can fall
  // back to a full-chain run (the failure was likely a stale restored session).
  const runOwnPlan = async (b: Browser, deferReplan: boolean): Promise<void> => {
    const cached = opts.useCache ? await getCached(scenario) : null;
    if (cached) {
      metrics.cache = "hit";
      metrics.plan = cached.plan;
      // E3: the cache stores the plan WITH { use } references; expansion runs every time.
      let expandedPlan;
      try {
        expandedPlan = expandPlan({ ...cached.plan, start_url: scenario.start_url ?? cached.plan.start_url }, await loadFragments());
      } catch (err) {
        await invalidate(cached);
        metrics.cache = "invalidated";
        const context = `The cached plan is no longer valid: ${err instanceof Error ? err.message : err}`;
        const replanned = await generateAndExecute(scenario, planner, b, metrics, collector, context, skipGoto, cached.plan.generated_by?.model);
        if (replanned.ok && opts.useCache) await saveCached(scenario, replanned.plan!, replanned.start_sig);
        return;
      }
      const execStart = Date.now();
      const result = await executePlan(b, expandedPlan, collector, { skipInitialGoto: skipGoto });
      metrics.duration_ms.execution = Date.now() - execStart;
      metrics.actions = result.actions;
      // E1, lenient policy: a diverging sig is a signal, not a blocker.
      if (result.start_sig && cached.key.start_sig) {
        metrics.sig_mismatch = result.start_sig !== cached.key.start_sig;
        if (metrics.sig_mismatch) {
          console.warn(`warning: start-page signature changed (${cached.key.start_sig} -> ${result.start_sig}) — replaying anyway (lenient mode)`);
        }
      }
      if (result.ok) {
        await recordReplay(cached);
        metrics.result = "passed";
        return;
      }
      if (deferReplan) {
        // Snapshot attempt failed — do NOT invalidate; let the caller rebuild state and retry.
        metrics.failure = result.failure ?? { kind: "verification", action_id: null, message: "restored-session replay failed" };
        metrics.result = "failed";
        return;
      }
      if (result.failure?.kind === "network") {
        // A network failure says nothing about the plan: do not invalidate (doc 05).
        metrics.failure = result.failure;
        return;
      }
      // Replay failed on verification: invalidate → re-plan the whole flow (doc 03).
      const churn = await recentStaleCount(scenario.scenario_id);
      await invalidate(cached);
      metrics.cache = "invalidated";
      progress(scenario.scenario_id, `verification failed at ${result.failure?.action_id ?? "?"} → self-heal re-planning`);
      streamEvent(scenario.scenario_id, "replan", { at: result.failure?.action_id ?? null, reason: "verification" });
      if (churn >= 2) {
        console.warn(`warning: "${scenario.scenario_id}" has re-planned ${churn + 1} times without stabilizing — the app may lack a stable selector for action ${result.failure?.action_id ?? "?"} (an accessibility gap) or have a race. Run with --suggest for a precise diagnosis, or pin a selector via hints.`);
      }
      const failureContext = await buildReplanContext(scenario, cached.plan, result.failure, metrics, b, opts.suggest === true);
      const replanned = await generateAndExecute(scenario, planner, b, metrics, collector, failureContext, skipGoto, cached.plan.generated_by?.model);
      if (replanned.ok && opts.useCache) await saveCached(scenario, replanned.plan!, replanned.start_sig);
      return;
    }
    // Cache miss: isomorphic reuse (#1) before spending an LLM call, else plan.
    if (scenario.like && opts.useCache) {
      const reused = await tryIsomorphicReuse(scenario, b, metrics, collector, skipGoto);
      if (reused) return;
    }
    const generated = await generateAndExecute(scenario, planner, b, metrics, collector, undefined, skipGoto);
    if (generated.ok && opts.useCache) await saveCached(scenario, generated.plan!, generated.start_sig);
  };

  // Runs the depends_on chain in `b`, capturing each dependency's exit snapshot
  // (storageState + URL) so a later dependent can restore it. false on failure.
  const runDepsChain = async (b: Browser): Promise<boolean> => {
    metrics.dependencies = [];
    for (const dep of depChain) {
      const depStart = Date.now();
      const outcome = await runDependency(dep, planner, b, metrics, collector, opts.useCache);
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
        return false;
      }
      if (opts.useCache) {
        try { await saveSnapshot(dep.scenario_id, await b.storageState(), b.url()); } catch { /* best-effort */ }
      }
    }
    metrics.duration_ms.dependencies = metrics.dependencies.reduce((s, d) => s + d.duration_ms, 0);
    return true;
  };

  try {
    // Setup hook runs OUTSIDE the plan/cache, before anything (fixtures, DB reset).
    if (scenario.setup) {
      const setup = await runHooks("setup", scenario.setup, scenario.scenario_id);
      if (!setup.ok) {
        metrics.failure = { kind: "setup", action_id: null, message: setup.error ?? "setup failed" };
        return metrics;
      }
    }

    if (snapshot) {
      // FAST PATH: restore the anchor dependency's session, skip the chain.
      const restoreStart = Date.now();
      if (skipGoto) await browser.goto(snapshot.url); // continue where the anchor ended
      metrics.dependencies = [{ scenario_id: anchorId!, cache: "hit", llm_calls: 0, result: "passed", duration_ms: Date.now() - restoreStart }];
      metrics.duration_ms.dependencies = metrics.dependencies[0].duration_ms;
      metrics.reused_session_from = anchorId;
      progress(scenario.scenario_id, `restored session from "${anchorId}" (skipped depends_on chain)`);
      await runOwnPlan(browser, /* deferReplan */ true);
      if (metrics.result === "failed") {
        // The restored session was insufficient (expired / needs in-memory state)
        // → drop it and fall back to a full-chain run in a fresh context.
        progress(scenario.scenario_id, `restored session did not verify → re-running the depends_on chain`);
        streamEvent(scenario.scenario_id, "replan", { at: null, reason: "session-snapshot-miss" });
        await dropSnapshot(anchorId!);
        await browser.close();
        resetForFallback(metrics);
        const relaunch = Date.now();
        browser = await launchBrowser();
        metrics.duration_ms.setup += Date.now() - relaunch;
        if (await runDepsChain(browser)) await runOwnPlan(browser, false);
      }
    } else if (depChain.length) {
      if (await runDepsChain(browser)) await runOwnPlan(browser, false);
    } else {
      await runOwnPlan(browser, false);
    }

    // Capture this scenario's own exit state so its dependents can restore it.
    if (metrics.result === "passed" && opts.useCache) {
      try { await saveSnapshot(scenario.scenario_id, await browser.storageState(), browser.url()); } catch { /* best-effort */ }
    }
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
    metrics.estimated_cost_usd = estimateCostUsd(metrics.tokens, metrics.llm_model, metrics.llm_provider);
    if (opts.suggest && metrics.result === "failed" && !metrics.suggestion) {
      try {
        const { generateFixSuggestion } = await import("./suggest.js");
        metrics.suggestion = await generateFixSuggestion(scenario, metrics, browser);
        metrics.estimated_cost_usd = Number((metrics.estimated_cost_usd + metrics.suggestion.est_cost_usd).toFixed(6));
      } catch (err) {
        console.warn(`warning: could not generate a fix suggestion: ${err instanceof Error ? err.message : err}`);
      }
    }
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
    // Teardown runs ALWAYS (pass or fail), outside the plan — cleanup for
    // non-idempotent scenarios. A failure is surfaced but never flips the result.
    if (scenario.teardown) {
      const teardown = await runHooks("teardown", scenario.teardown, scenario.scenario_id);
      if (!teardown.ok) console.warn(`warning: ${teardown.error}`);
    }
    if (!opts.sharedMap) await mapStore.save();
    await writeRunMetrics(metrics);
  }
}

/**
 * #1 — try to reuse another scenario's PROVEN cached plan for an isomorphic
 * scenario (no LLM): instantiate the source plan for this scenario's route/
 * values, execute + verify, and cache it as this scenario's own plan on
 * success. Returns false (→ fall back to LLM) when the source has no active
 * plan or the instantiated plan does not verify. Never invalidates anything and
 * never bypasses the verify gate.
 */
async function tryIsomorphicReuse(
  scenario: Scenario,
  browser: Browser,
  metrics: RunMetrics,
  collector?: StepCollector,
  skipGoto = false,
): Promise<boolean> {
  const like = scenario.like!;
  if (like.scenario === scenario.scenario_id) {
    console.warn(`warning: "${scenario.scenario_id}" declares like itself — ignoring`);
    return false;
  }
  let source: Scenario;
  try {
    source = await loadScenario(like.scenario);
  } catch {
    console.warn(`warning: "${scenario.scenario_id}" is like "${like.scenario}", which was not found — planning with the LLM`);
    return false;
  }
  const srcCached = await getCached(source);
  if (!srcCached) {
    progress(scenario.scenario_id, `like "${like.scenario}": no proven plan yet → planning with the LLM`);
    return false;
  }

  const startUrl = scenario.start_url ?? srcCached.plan.start_url;
  const { plan, unmatched } = instantiatePlan(srcCached.plan, { ...scenario, start_url: startUrl }, like.set);
  if (unmatched.length) {
    console.warn(`warning: "${scenario.scenario_id}" like "${like.scenario}": set value(s) not found in the source plan: ${unmatched.map((v) => JSON.stringify(v)).join(", ")}`);
  }
  progress(scenario.scenario_id, `reusing plan from "${like.scenario}" (isomorphic, no LLM)`);

  let expanded: Plan;
  try {
    expanded = expandPlan({ ...plan, start_url: startUrl }, await loadFragments());
  } catch {
    return false; // orphaned fragment in the source plan → let the LLM plan fresh
  }

  const execStart = Date.now();
  const result = await executePlan(browser, expanded, collector, { skipInitialGoto: skipGoto });
  metrics.duration_ms.execution = Date.now() - execStart;
  metrics.actions = result.actions;

  if (result.ok) {
    await saveCached(scenario, plan, result.start_sig ?? undefined);
    metrics.cache = "hit";
    metrics.reused_from = like.scenario;
    metrics.result = "passed";
    return true;
  }
  progress(scenario.scenario_id, `reused plan from "${like.scenario}" did not verify (at ${result.failure?.action_id ?? "?"}) → planning with the LLM`);
  streamEvent(scenario.scenario_id, "replan", { at: result.failure?.action_id ?? null, reason: "isomorphic-mismatch" });
  return false;
}

async function generateAndExecute(
  scenario: Scenario,
  planner: Planner,
  browser: Browser,
  metrics: RunMetrics,
  collector?: StepCollector,
  failureContext?: string,
  skipGoto = false,
  preferredProvider?: string,
): Promise<{ ok: boolean; plan?: Plan; start_sig?: string }> {
  const planningStart = Date.now();
  let generation: PlanGeneration;
  try {
    generation = await planner.generate(scenario, browser, failureContext, { skipGoto, preferredProvider });
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

/**
 * Runs `tasks` with at most `limit` in flight at once, preserving result order.
 * Small hand-rolled pool (no dependency). A task that rejects is not caught
 * here — callers wrap runScenario so it always resolves to metrics.
 */
export async function runPool<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, async () => {
    while (true) {
      const i = next++;
      if (i >= tasks.length) return;
      results[i] = await tasks[i]();
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Rich failure context for a self-heal re-plan (#10): the failed selector with
 * a "do not reuse" instruction, the scenario hints re-emphasized, and — when
 * --suggest is on — the same expert diagnosis the human gets, fed straight back
 * into the planner so it corrects rather than re-proposing the refuted selector.
 */
async function buildReplanContext(
  scenario: Scenario,
  failedPlan: Plan,
  failure: RunMetrics["failure"],
  metrics: RunMetrics,
  browser: Browser,
  useSuggest: boolean,
): Promise<string> {
  const parts = [`The previous plan failed at action ${failure?.action_id}: ${failure?.message}.`];
  const failed = failedPlan.actions.find((a) => a.id === failure?.action_id);
  if (failed?.target?.selector) {
    parts.push(
      `The selector \`${failed.target.selector}\` did NOT match or was not actionable — do NOT reuse it. Choose a structurally different selector (a different attribute, a text-based match like \`text=…\`, or one scoped to a container). If a hint states the element's real nature, trust it over a semantic guess.`,
    );
  }
  if (scenario.hints?.length) {
    parts.push(`Honor the scenario hints strictly:\n${scenario.hints.map((h) => `- ${h}`).join("\n")}`);
  }
  if (useSuggest) {
    try {
      const { generateFixSuggestion } = await import("./suggest.js");
      const suggestion = await generateFixSuggestion(scenario, metrics, browser);
      metrics.suggestion = suggestion; // surface it once; the finally won't regenerate
      metrics.estimated_cost_usd = Number((metrics.estimated_cost_usd + suggestion.est_cost_usd).toFixed(6));
      parts.push(`Expert diagnosis of this failure — apply it:\n${suggestion.text}`);
    } catch {
      // suggestion is best-effort; the mechanical context above still helps
    }
  }
  return parts.join("\n\n");
}
