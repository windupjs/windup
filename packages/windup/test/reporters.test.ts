import { describe, expect, it } from "vitest";
import { junitReport, jsonReport } from "../src/reporters.js";
import type { RunMetrics } from "../src/types.js";

function metric(over: Partial<RunMetrics>): RunMetrics {
  return {
    scenario_id: "s", started_at: "2026-07-13T10:00:00Z", cache: "hit", llm_calls: 0,
    llm_model: null, planning_mode: null, plan_semantic_retries: null, sig_mismatch: null,
    prompt_chars: null, tokens: { input: 0, output: 0 }, estimated_cost_usd: 0,
    duration_ms: { total: 1500, planning: 0, execution: 900 }, actions: [], result: "passed", failure: null,
    ...over,
  };
}

describe("reporters CI/CD", () => {
  it("junit: sucesso e falha com escaping XML", () => {
    const xml = junitReport([
      metric({ scenario_id: "login" }),
      metric({
        scenario_id: "checkout <fluxo & pagamento>",
        result: "failed",
        failure: { kind: "verification", action_id: "a3", message: 'selector "#pay" not visible' },
      }),
    ]);
    expect(xml).toContain('tests="2" failures="1"');
    expect(xml).toContain('<testcase classname="windup" name="login" time="1.500"/>');
    expect(xml).toContain("checkout &lt;fluxo &amp; pagamento&gt;");
    expect(xml).toContain('type="verification"');
    expect(xml).toContain("&quot;#pay&quot;");
    expect(xml).not.toContain('name="checkout <');
  });

  it("json: summary agregado + casos", () => {
    const out = JSON.parse(jsonReport([
      metric({ llm_calls: 1, estimated_cost_usd: 0.002 }),
      metric({ scenario_id: "b", result: "failed", failure: { kind: "network", action_id: null, message: "x" } }),
    ]));
    expect(out.summary).toEqual({ total: 2, passed: 1, failed: 1, llm_calls: 1, est_cost_usd: 0.002, duration_ms: 3000 });
    expect(out.cases[1].failure.kind).toBe("network");
  });
});
