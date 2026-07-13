/**
 * API programática do Windup — a CLI é uma casca fina sobre isto.
 * Completada no P1 (M2) com loadConfig/defineConfig; o núcleo já é público.
 */
export { runScenario, type Planner, type RunOptions, type PlanGeneration } from "./runner.js";
export { LlmPlanner, GeminiPlanner } from "./planner.js";
export { createLlmClient, resolveLlm, PROVIDER_DEFAULTS, type LlmClient, type ProviderName } from "./llm.js";
export { generateScenario, type AuthoringResult, type AuthoredScenario } from "./authoring.js";
export { loadScenario } from "./scenario.js";
export { clearCache } from "./cache.js";
export { runBench } from "./bench.js";
export { shutdownBrowserEngine } from "./browser.js";
export { createContext, createContextFromConfig, getContext, setContext, type WindupContext, type WindupPaths } from "./context.js";
export { defineConfig, loadWindupConfig, type WindupConfig, type LoadedConfig } from "./config.js";
export { computeSignature, type RawElement } from "./signature.js";
export type { Scenario, Plan, Action, RunMetrics, CacheEntry, FailureKind } from "./types.js";

import { createContextFromConfig, setContext } from "./context.js";
import { LlmPlanner } from "./planner.js";
import { runScenario, type RunOptions } from "./runner.js";
import { loadScenario } from "./scenario.js";
import type { RunMetrics } from "./types.js";

/**
 * Executa um cenário pelo id (arquivo em scenariosDir) — atalho da API para
 * integração com runners (vitest/jest). Resolve o windup.config.* a partir
 * de opts.cwd (default: process.cwd()).
 */
export async function run(scenarioId: string, opts: Partial<RunOptions> & { cwd?: string } = {}): Promise<RunMetrics> {
  setContext(await createContextFromConfig(opts.cwd));
  const scenario = await loadScenario(scenarioId);
  return runScenario(scenario, new LlmPlanner(), { useCache: opts.useCache ?? true });
}
