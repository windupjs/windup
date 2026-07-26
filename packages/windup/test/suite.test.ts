import { describe, expect, it } from "vitest";
import { buildSuiteSummary } from "../src/suite.js";
import type { RunMetrics } from "../src/types.js";

const m = (over: Partial<RunMetrics>): RunMetrics => ({
  scenario_id: "s", module: "(root)", started_at: "2026-07-25T00:00:00Z", cache: "hit", llm_calls: 0,
  llm_model: null, llm_provider: null, planning_mode: null, plan_semantic_retries: null, sig_mismatch: null,
  prompt_chars: null, tokens: { input: 0, output: 0 }, estimated_cost_usd: 0,
  duration_ms: { total: 1000, planning: 0, execution: 1000 }, actions: [], result: "passed", failure: null, ...over,
});

describe("suite summary (feedback #3)", () => {
  it("groups pass/fail by module + cache-hit rate + re-plans", () => {
    const s = buildSuiteSummary([
      m({ scenario_id: "a", module: "contacts", cache: "hit" }),
      m({ scenario_id: "b", module: "contacts", cache: "invalidated", result: "failed", failure: { kind: "verification", action_id: "a1", message: "x" } }),
      m({ scenario_id: "c", module: "shop", cache: "hit" }),
    ]);
    expect(s.total).toBe(3);
    expect(s.passed).toBe(2);
    expect(s.cache_hit_rate).toBeCloseTo(2 / 3, 2);
    expect(s.replans).toBe(1);
    const contacts = s.by_module.find((x) => x.module === "contacts")!;
    expect(contacts).toMatchObject({ total: 2, passed: 1, failed: 1 });
    expect(s.by_module.map((x) => x.module)).toEqual(["contacts", "shop"]); // sorted
  });

  it("flake score aggregates --repeat (passed some, not all)", () => {
    const s = buildSuiteSummary([
      m({ scenario_id: "flako", result: "passed" }),
      m({ scenario_id: "flako", result: "failed", failure: { kind: "verification", action_id: "a1", message: "x" } }),
      m({ scenario_id: "flako", result: "passed" }),
      m({ scenario_id: "solid", result: "passed" }),
      m({ scenario_id: "solid", result: "passed" }),
    ]);
    expect(s.flaky).toHaveLength(1);
    expect(s.flaky[0]).toMatchObject({ scenario_id: "flako", passed: 2, total: 3 });
  });

  it("flake root-cause hint reflects the failing runs' signals", () => {
    const sig = buildSuiteSummary([
      m({ scenario_id: "race", result: "passed" }),
      m({ scenario_id: "race", result: "failed", sig_mismatch: true, failure: { kind: "verification", action_id: "a2", message: "x" } }),
    ]);
    expect(sig.flaky[0].hint).toMatch(/hydration|signature/i);

    const net = buildSuiteSummary([
      m({ scenario_id: "net", result: "passed" }),
      m({ scenario_id: "net", result: "failed", failure: { kind: "network", action_id: null, message: "x" } }),
    ]);
    expect(net.flaky[0].hint).toMatch(/network/i);

    const step = buildSuiteSummary([
      m({ scenario_id: "step", result: "passed" }),
      m({ scenario_id: "step", result: "failed", failure: { kind: "verification", action_id: "a3", message: "x" } }),
    ]);
    expect(step.flaky[0].hint).toMatch(/action a3/);
  });
});
