import { generateScenario, type AuthoringResult } from "./authoring.js";
import type { RunMetrics } from "./types.js";

/**
 * `windup new --validate`: generate → RUN → if it fails, feed the failure and
 * the fix suggestion back into authoring and try again (bounded). You get a
 * scenario that has already passed once, with a warm cache and the site map
 * enriched with the real pages of the flow — instead of a plausible-but-wrong
 * first draft you'd have to debug by hand.
 *
 * The loop is deliberately in authoring, not in `run`: `run` stays an
 * impartial judge (a wrong scenario is a FAIL, never silently "fixed"); it is
 * authoring that iterates, where getting it wrong is cheap.
 */
export interface ValidationAttempt {
  attempt: number;
  result: "passed" | "failed";
  failure: string | null;
  llm_calls: number;
  est_cost_usd: number;
}

export interface ValidatedAuthoringResult {
  result: AuthoringResult;
  validated: boolean;
  attempts: ValidationAttempt[];
}

/** Injected for testing; the real one loads the scenario and runs it with the LLM planner. */
export type ScenarioRunner = (scenarioId: string) => Promise<RunMetrics>;

async function defaultRunner(scenarioId: string): Promise<RunMetrics> {
  const { loadScenario } = await import("./scenario.js");
  const { runScenario } = await import("./runner.js");
  const { LlmPlanner } = await import("./planner.js");
  const scenario = await loadScenario(scenarioId);
  return runScenario(scenario, new LlmPlanner(), { useCache: true, suggest: true });
}

export async function generateValidatedScenario(
  instruction: string,
  opts: { id?: string; force?: boolean; dependsOn?: string[]; maxAttempts?: number } = {},
  deps: { generate?: typeof generateScenario; run?: ScenarioRunner } = {},
): Promise<ValidatedAuthoringResult> {
  const generate = deps.generate ?? generateScenario;
  const run = deps.run ?? defaultRunner;
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
  const attempts: ValidationAttempt[] = [];

  // First draft from the instruction; refinements reuse the same id (force).
  let result = await generateScenario0(generate, instruction, { id: opts.id, force: opts.force, dependsOn: opts.dependsOn });

  for (let i = 1; i <= maxAttempts; i++) {
    const metrics = await run(result.scenario.scenario_id);
    attempts.push({
      attempt: i,
      result: metrics.result,
      failure: metrics.failure ? `[${metrics.failure.kind}] ${metrics.failure.message}` : null,
      llm_calls: metrics.llm_calls,
      est_cost_usd: metrics.estimated_cost_usd,
    });
    if (metrics.result === "passed") return { result, validated: true, attempts };
    if (i === maxAttempts) break;

    // Refine from the failure + the LLM's own fix suggestion + the real page.
    const parts = [`The previous run failed: ${metrics.failure ? `[${metrics.failure.kind}] at ${metrics.failure.action_id ?? "?"}: ${metrics.failure.message}` : "unknown failure"}.`];
    if (metrics.suggestion?.text) parts.push(`Fix suggestion from analysis: ${metrics.suggestion.text}`);
    if (metrics.failure_snapshot) parts.push(`Real page when it failed:\n${metrics.failure_snapshot.slice(0, 2500)}`);
    result = await generate(instruction, {
      id: result.scenario.scenario_id,
      force: true,
      dependsOn: opts.dependsOn,
      refineFrom: parts.join("\n\n"),
    });
  }
  return { result, validated: false, attempts };
}

/** First generation preserves any explicit --force from the caller. */
function generateScenario0(generate: typeof generateScenario, instruction: string, opts: { id?: string; force?: boolean; dependsOn?: string[] }): Promise<AuthoringResult> {
  return generate(instruction, opts);
}
