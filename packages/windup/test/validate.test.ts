import { describe, expect, it, vi } from "vitest";
import { generateValidatedScenario } from "../src/validate.js";
import type { AuthoringResult } from "../src/authoring.js";
import type { RunMetrics, Scenario } from "../src/types.js";

function authoring(id: string, task: string): AuthoringResult {
  return {
    file: `/tmp/${id}.json`,
    scenario: { scenario_id: id, start_url: "/", task } as Scenario & { start_url: string },
    llm_calls: 1, tokens: { input: 1, output: 1 }, model: "m", provider: "google", est_cost_usd: 0.001,
  };
}

function runResult(over: Partial<RunMetrics>): RunMetrics {
  return {
    scenario_id: "s", started_at: "2026-07-14T10:00:00Z", cache: "miss", llm_calls: 1,
    llm_model: "m", llm_provider: "google", planning_mode: "full", plan_semantic_retries: 0,
    sig_mismatch: null, prompt_chars: 1, tokens: { input: 1, output: 1 }, estimated_cost_usd: 0.002,
    duration_ms: { total: 1, planning: 1, execution: 1 }, actions: [], result: "passed", failure: null,
    ...over,
  };
}

describe("windup new --validate (generate → run → refine loop)", () => {
  it("passes on the first attempt: one generation, no refinement", async () => {
    const generate = vi.fn(async () => authoring("create-invoice", "task v1"));
    const run = vi.fn(async () => runResult({ result: "passed" }));
    const out = await generateValidatedScenario("create an invoice", {}, { generate, run });

    expect(out.validated).toBe(true);
    expect(out.attempts).toHaveLength(1);
    expect(generate).toHaveBeenCalledTimes(1); // no refinement needed
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("fails then passes: refines from the failure + suggestion, feeds it back into authoring", async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce(authoring("create-invoice", "task v1"))
      .mockResolvedValueOnce(authoring("create-invoice", "task v2 (fixed)"));
    const run = vi.fn()
      .mockResolvedValueOnce(runResult({
        result: "failed",
        failure: { kind: "verification", action_id: "a3", message: "button 'Save' not visible" },
        suggestion: { text: "the real button is 'Create'", model: "m", provider: "google", tokens: { input: 1, output: 1 }, est_cost_usd: 0.0005 },
        failure_snapshot: 'button "Create"',
      }))
      .mockResolvedValueOnce(runResult({ result: "passed" }));

    const out = await generateValidatedScenario("create an invoice", {}, { generate, run });
    expect(out.validated).toBe(true);
    expect(out.attempts.map((a) => a.result)).toEqual(["failed", "passed"]);

    // second generation call carried the failure + suggestion + real page as refineFrom
    const refineCall = generate.mock.calls[1];
    expect(refineCall[1].force).toBe(true);
    expect(refineCall[1].id).toBe("create-invoice");
    expect(refineCall[1].refineFrom).toContain("button 'Save' not visible");
    expect(refineCall[1].refineFrom).toContain("the real button is 'Create'");
    expect(refineCall[1].refineFrom).toContain('button "Create"');
  });

  it("exhausts attempts: stops at maxAttempts, validated=false, keeps the last draft", async () => {
    const generate = vi.fn(async () => authoring("hard", "still wrong"));
    const run = vi.fn(async () => runResult({ result: "failed", failure: { kind: "verification", action_id: "a1", message: "nope" } }));
    const out = await generateValidatedScenario("hard flow", { maxAttempts: 2 }, { generate, run });

    expect(out.validated).toBe(false);
    expect(out.attempts).toHaveLength(2);
    expect(run).toHaveBeenCalledTimes(2);
    expect(generate).toHaveBeenCalledTimes(2); // initial + 1 refinement (no refine after the last attempt)
  });
});
