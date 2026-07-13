import { describe, expect, it } from "vitest";
import { buildSummaryPrompt, generateRunSummary } from "../src/summary.js";
import type { Browser } from "../src/browser.js";
import type { LlmClient } from "../src/llm.js";
import type { RunMetrics, Scenario } from "../src/types.js";

const SCENARIO: Scenario = { scenario_id: "precos", task: "Go to the pricing page and verify the plans on display." };

function metrics(over: Partial<RunMetrics> = {}): RunMetrics {
  return {
    scenario_id: "precos", started_at: "2026-07-13T10:00:00Z", cache: "hit", llm_calls: 0,
    llm_model: null, llm_provider: null, planning_mode: null, plan_semantic_retries: null,
    sig_mismatch: null, prompt_chars: null, tokens: { input: 0, output: 0 }, estimated_cost_usd: 0,
    duration_ms: { total: 900, planning: 0, execution: 700 },
    actions: [{ id: "a1", duration_ms: 6200, verify_ms: 100, status: "passed" }],
    result: "passed", failure: null,
    plan: {
      plan_version: "0.1", scenario_id: "precos", start_url: "/",
      actions: [{ id: "a1", type: "click", target: { selector: "a[href='/precos']", description: "Pricing link" }, expect: { url: "**/precos" } }],
    },
    ...over,
  };
}

const fakeBrowser = {
  url: async () => "http://localhost:3000/precos",
  snapshotTree: async () => 'heading "Plans"\ntext "Starter R$ 49/month"\ntext "Pro R$ 149/month"',
} as unknown as Browser;

describe("run --summary (post-run summary)", () => {
  it("prompt includes task, plan, outcome, anomalies and the final snapshot", () => {
    const prompt = buildSummaryPrompt(SCENARIO, metrics({ sig_mismatch: true, cache: "invalidated" }), "http://x/precos", 'text "Starter R$ 49"');
    expect(prompt).toContain("pricing page");
    expect(prompt).toContain("PASSED");
    expect(prompt).toContain("Pricing link");
    expect(prompt).toContain("re-planned from scratch");
    expect(prompt).toContain("sig_mismatch");
    expect(prompt).toContain("slow actions (>5s): a1");
    expect(prompt).toContain('Starter R$ 49');
    expect(prompt).toContain("LITERALLY");
  });

  it("a failure enters the prompt as the outcome", () => {
    const prompt = buildSummaryPrompt(
      SCENARIO,
      metrics({ result: "failed", failure: { kind: "verification", action_id: "a1", message: "not visible" } }),
      "", "",
    );
    expect(prompt).toContain("FAILED");
    expect(prompt).toContain("[verification]");
  });

  it("generates the summary with the client's tokens/cost and survives a dead browser", async () => {
    const client: LlmClient = {
      provider: "google", model: "gemini-3.1-flash-lite",
      generate: async () => ({ text: "The test passed; the plans on display are Starter R$ 49/month and Pro R$ 149/month.", tokens: { input: 2000, output: 60 }, truncated: false }),
    };
    const s = await generateRunSummary(SCENARIO, metrics(), fakeBrowser, client);
    expect(s.text).toContain("R$ 49");
    expect(s.est_cost_usd).toBeCloseTo(2000 * 0.25 / 1e6 + 60 * 1.5 / 1e6, 6);

    const dead = { url: async () => { throw new Error("closed"); }, snapshotTree: async () => { throw new Error("closed"); } } as unknown as Browser;
    const s2 = await generateRunSummary(SCENARIO, metrics(), dead, client);
    expect(s2.text.length).toBeGreaterThan(10);
  });
});
