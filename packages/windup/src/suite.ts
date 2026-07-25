import type { RunMetrics } from "./types.js";

/**
 * Suite-level aggregation (feedback #3: at 145 scenarios / 17 modules you need
 * the forest, not the trees). Groups by module, and — when --repeat ran a
 * scenario N times — computes a flake score (passed X/N; flaky = some-but-not-all).
 */
export interface ModuleStat {
  module: string;
  total: number;
  passed: number;
  failed: number;
  pass_rate: number;
}

export interface FlakyScenario {
  scenario_id: string;
  module: string;
  passed: number;
  total: number;
}

export interface SuiteSummary {
  total: number;
  passed: number;
  failed: number;
  pass_rate: number;
  cache_hits: number;
  cache_hit_rate: number;
  replans: number;
  llm_calls: number;
  est_cost_usd: number;
  duration_ms: number;
  by_module: ModuleStat[];
  flaky: FlakyScenario[];
}

const moduleOf = (m: RunMetrics): string => m.module ?? "(root)";
const rate = (n: number, d: number): number => (d ? Number((n / d).toFixed(3)) : 0);

export function buildSuiteSummary(results: RunMetrics[]): SuiteSummary {
  const passed = results.filter((m) => m.result === "passed").length;
  const cacheHits = results.filter((m) => m.cache === "hit").length;

  const modules = new Map<string, ModuleStat>();
  for (const m of results) {
    const mod = moduleOf(m);
    const stat = modules.get(mod) ?? { module: mod, total: 0, passed: 0, failed: 0, pass_rate: 0 };
    stat.total += 1;
    if (m.result === "passed") stat.passed += 1;
    else stat.failed += 1;
    modules.set(mod, stat);
  }
  const by_module = [...modules.values()]
    .map((s) => ({ ...s, pass_rate: rate(s.passed, s.total) }))
    .sort((a, b) => a.module.localeCompare(b.module));

  // Flake: group by scenario_id; flaky = passed a proper subset of its runs.
  const byId = new Map<string, { passed: number; total: number; module: string }>();
  for (const m of results) {
    const e = byId.get(m.scenario_id) ?? { passed: 0, total: 0, module: moduleOf(m) };
    e.total += 1;
    if (m.result === "passed") e.passed += 1;
    byId.set(m.scenario_id, e);
  }
  const flaky = [...byId.entries()]
    .filter(([, e]) => e.total > 1 && e.passed > 0 && e.passed < e.total)
    .map(([scenario_id, e]) => ({ scenario_id, module: e.module, passed: e.passed, total: e.total }))
    .sort((a, b) => a.passed / a.total - b.passed / b.total);

  return {
    total: results.length,
    passed,
    failed: results.length - passed,
    pass_rate: rate(passed, results.length),
    cache_hits: cacheHits,
    cache_hit_rate: rate(cacheHits, results.length),
    replans: results.filter((m) => m.cache === "invalidated").length,
    llm_calls: results.reduce((n, m) => n + m.llm_calls, 0),
    est_cost_usd: Number(results.reduce((n, m) => n + m.estimated_cost_usd, 0).toFixed(4)),
    duration_ms: results.reduce((n, m) => n + m.duration_ms.total, 0),
    by_module,
    flaky,
  };
}

/** Human-readable suite summary block for the terminal. */
export function printSuiteSummary(s: SuiteSummary): void {
  console.log("");
  console.log(
    `suite: ${s.passed}/${s.total} passed (${Math.round(s.pass_rate * 100)}%)  ·  ` +
      `cache-hit ${Math.round(s.cache_hit_rate * 100)}%  ·  re-plans ${s.replans}  ·  ` +
      `llm_calls ${s.llm_calls}  ·  $${s.est_cost_usd}  ·  ${(s.duration_ms / 1000).toFixed(1)}s`,
  );
  if (s.by_module.length > 1) {
    console.log("by module:");
    for (const m of s.by_module) {
      const bar = m.failed === 0 ? "✓" : `${m.failed} failed`;
      console.log(`  ${m.module.padEnd(24)} ${m.passed}/${m.total}  ${bar}`);
    }
  }
  if (s.flaky.length) {
    console.log("flaky (passed some, not all — from --repeat):");
    for (const f of s.flaky) console.log(`  ${f.scenario_id.padEnd(24)} ${f.passed}/${f.total}`);
  }
}
