import { readdir } from "node:fs/promises";
import { afterAll, describe, it } from "vitest";
import { shutdownBrowserEngine } from "../browser.js";
import { createContextFromConfig, getContext, setContext } from "../context.js";
import { GeminiPlanner } from "../planner.js";
import { runScenario } from "../runner.js";
import { loadScenario } from "../scenario.js";
import type { RunMetrics } from "../types.js";

/**
 * Vitest adapter (SPEC-002, P5): windup scenarios as native runner tests.
 *
 * ```ts
 * // e2e/windup.test.ts
 * import { windupSuite } from "windupjs/vitest";
 * await windupSuite();               // one it() per scenario JSON
 * ```
 *
 * Also works with jest under ESM (same globals contract). The engine is
 * shared across the suite (E5 pool) and shut down in afterAll.
 */
export interface WindupSuiteOptions {
  /** Project root for windup.config resolution (default: process.cwd()). */
  cwd?: string;
  /** Per-scenario timeout in ms (default 120000 — first run may plan via LLM). */
  timeoutMs?: number;
  /** Keep only matching scenario ids. */
  filter?: (id: string) => boolean;
  /** Suite name (default "windup"). */
  name?: string;
}

export async function windupSuite(opts: WindupSuiteOptions = {}): Promise<void> {
  setContext(await createContextFromConfig(opts.cwd));
  const dir = getContext().paths.scenariosDir;
  let ids: string[] = [];
  try {
    ids = (await readdir(dir))
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""))
      .filter(opts.filter ?? (() => true))
      .sort();
  } catch {
    // no scenarios dir → empty suite below explains itself
  }

  describe(opts.name ?? "windup", () => {
    afterAll(async () => {
      await shutdownBrowserEngine();
    });

    if (ids.length === 0) {
      it("no scenarios found", () => {
        throw new Error(`no scenario JSON files in ${dir} — write one and re-run`);
      });
      return;
    }

    for (const id of ids) {
      it(id, { timeout: opts.timeoutMs ?? 120_000 }, async () => {
        await runOne(id, opts.cwd);
      });
    }
  });
}

/** Single scenario as a test body: `it("checkout", () => windupTest("checkout"))`. */
export async function windupTest(id: string, opts: { cwd?: string } = {}): Promise<RunMetrics> {
  setContext(await createContextFromConfig(opts.cwd));
  return runOne(id, opts.cwd);
}

async function runOne(id: string, cwd?: string): Promise<RunMetrics> {
  setContext(await createContextFromConfig(cwd));
  const scenario = await loadScenario(id);
  const metrics = await runScenario(scenario, new GeminiPlanner(), { useCache: true });
  if (metrics.result !== "passed") {
    const f = metrics.failure;
    const detail = f ? ` at action ${f.action_id ?? "-"} [${f.kind}]: ${f.message}` : "";
    throw new Error(
      `windup scenario "${id}" failed${detail}\n` +
        `  cache=${metrics.cache} llm_calls=${metrics.llm_calls} duration=${metrics.duration_ms.total}ms cost=$${metrics.estimated_cost_usd}`,
    );
  }
  return metrics;
}
