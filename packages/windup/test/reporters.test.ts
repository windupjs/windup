import { describe, expect, it } from "vitest";
import { htmlReport, junitReport, jsonReport } from "../src/reporters.js";
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

describe("CI/CD reporters", () => {
  it("junit: success and failure with XML escaping", () => {
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

  it("json: aggregated summary + cases", () => {
    const out = JSON.parse(jsonReport([
      metric({ llm_calls: 1, estimated_cost_usd: 0.002 }),
      metric({ scenario_id: "b", result: "failed", failure: { kind: "network", action_id: null, message: "x" } }),
    ]));
    expect(out.summary).toEqual({ total: 2, passed: 1, failed: 1, llm_calls: 1, est_cost_usd: 0.002, duration_ms: 3000 });
    expect(out.cases[1].failure.kind).toBe("network");
  });

  it("html: self-contained document with summary, badges, escaped failure and action detail", () => {
    const html = htmlReport([
      metric({
        scenario_id: "login",
        llm_calls: 1,
        llm_model: "gemini-3.1-flash-lite",
        llm_provider: "google",
        estimated_cost_usd: 0.0019,
        summary: { text: "The observed prices were $29.99 and $9.99.", model: "m", provider: "google", tokens: { input: 1, output: 1 }, est_cost_usd: 0.0005 },
        actions: [
          { id: "a1", duration_ms: 120, verify_ms: 30, status: "passed" },
          { id: "a2", duration_ms: 90, verify_ms: 25, status: "passed" },
        ],
      }),
      metric({
        scenario_id: "checkout",
        result: "failed",
        failure: { kind: "verification", action_id: "a3", message: 'selector "<b>#pay</b>" not visible' },
      }),
    ]);
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("1/2 passed"); // <title>
    expect(html).toContain(">PASS<");
    expect(html).toContain(">FAIL<");
    expect(html).toContain("google/gemini-3.1-flash-lite");
    expect(html).toContain("2 action(s)");
    // debrief closed by default: <details> WITHOUT the open attribute
    expect(html).toContain('<details class="ai-summary"><summary>AI debrief</summary>');
    expect(html).not.toContain('<details class="ai-summary" open');
    expect(html).toContain("&lt;b&gt;#pay&lt;/b&gt;"); // failure message escaped
    expect(html).not.toContain("<b>#pay</b>");
    expect(html).not.toContain("<script"); // zero JS: opens in any CI artifact viewer
  });
});
