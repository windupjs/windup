import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildSuggestionPrompt, generateFixSuggestion } from "../src/suggest.js";
import type { Browser } from "../src/browser.js";
import type { LlmClient } from "../src/llm.js";
import type { RunMetrics, Scenario } from "../src/types.js";
import { createContext, setContext } from "../src/context.js";

const SCENARIO: Scenario = {
  scenario_id: "create-cost-center",
  task: "Log in, open Cost Centers and create one named Marketing, then verify it shows in the list.",
  hints: ["Cost centers are under /admin/settings/cost-centers"],
};

function failedMetrics(over: Partial<RunMetrics> = {}): RunMetrics {
  return {
    scenario_id: "create-cost-center", started_at: "2026-07-14T10:00:00Z", cache: "miss", llm_calls: 1,
    llm_model: "gemini-3.1-flash-lite", llm_provider: "google", planning_mode: "full",
    plan_semantic_retries: 0, sig_mismatch: null, prompt_chars: 1000,
    tokens: { input: 3000, output: 500 }, estimated_cost_usd: 0.002,
    duration_ms: { total: 20000, planning: 3000, execution: 15000 },
    actions: [
      { id: "a1", duration_ms: 200, verify_ms: 0, status: "passed" },
      { id: "a2", duration_ms: 15000, verify_ms: 0, status: "failed" },
    ],
    result: "failed",
    failure: { kind: "verification", action_id: "a2", message: "element button:has-text('Save') did not become visible within 15000ms" },
    plan: {
      plan_version: "0.1", scenario_id: "create-cost-center", start_url: "/",
      actions: [
        { id: "a1", type: "fill", target: { selector: "#name", description: "cost center name" }, value: "Marketing" },
        { id: "a2", type: "click", target: { selector: "button:has-text('Save')", description: "save button" }, expect: { selector: ".list" } },
      ],
    },
    failure_snapshot: 'dialog "New Cost Center"\n  textbox "Name" [value="Marketing"]\n  button "Create"',
    ...over,
  };
}

const fakeBrowser = {
  url: async () => "http://localhost:8082/admin/settings/cost-centers",
  snapshotTree: async () => 'dialog "New Cost Center"\n  button "Create"',
} as unknown as Browser;

describe("run --suggest (post-failure fix suggestion)", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "windup-suggest-"));
    setContext(createContext(root));
  });
  afterAll(() => setContext(createContext()));

  it("prompt includes task, the plan marking the failed step, the failure and the real final page", () => {
    const prompt = buildSuggestionPrompt(SCENARIO, failedMetrics(), "http://x/cost-centers", 'button "Create"', "");
    expect(prompt).toContain("senior QA engineer");
    expect(prompt).toContain(SCENARIO.task);
    expect(prompt).toContain("<<< FAILED HERE");
    expect(prompt).toContain("did not become visible");
    expect(prompt).toContain('button "Create"'); // real control on the page
    expect(prompt).toContain("SAME language as the scenario task");
  });

  it("marks the failed action and shows per-step status", () => {
    const prompt = buildSuggestionPrompt(SCENARIO, failedMetrics(), "", "", "");
    expect(prompt).toMatch(/a1 fill.*passed/);
    expect(prompt).toMatch(/a2 click.*failed.*<<< FAILED HERE/s);
  });

  it("includes site-map knowledge when provided", () => {
    const prompt = buildSuggestionPrompt(SCENARIO, failedMetrics(), "", "", "Known routes of the app:\n- /admin/settings/cost-centers");
    expect(prompt).toContain("Known routes and selectors");
    expect(prompt).toContain("/admin/settings/cost-centers");
  });

  it("generates the suggestion with the client's tokens/cost; uses failure_snapshot without touching the browser", async () => {
    let snapshotCalls = 0;
    const client: LlmClient = {
      provider: "google", model: "gemini-3.1-flash-lite",
      generate: async ({ prompt }) => {
        expect(prompt).toContain('button "Create"'); // came from failure_snapshot
        return { text: "The Save button does not exist; the real button is labeled 'Create'. Change the hint to use button:has-text('Create').", tokens: { input: 2500, output: 80 }, truncated: false };
      },
    };
    const browser = {
      url: async () => "http://x/cost-centers",
      snapshotTree: async () => { snapshotCalls++; return "should not be used"; },
    } as unknown as Browser;

    const s = await generateFixSuggestion(SCENARIO, failedMetrics(), browser, client);
    expect(s.text).toContain("Create");
    expect(s.est_cost_usd).toBeCloseTo(2500 * 0.25 / 1e6 + 80 * 1.5 / 1e6, 6);
    expect(snapshotCalls).toBe(0); // failure_snapshot already had it
  });

  it("falls back to a live snapshot when failure_snapshot is absent, and survives a dead browser", async () => {
    const client: LlmClient = {
      provider: "google", model: "gemini-3.1-flash-lite",
      generate: async () => ({ text: "fix it", tokens: { input: 1, output: 1 }, truncated: false }),
    };
    const s = await generateFixSuggestion(SCENARIO, failedMetrics({ failure_snapshot: undefined }), fakeBrowser, client);
    expect(s.text).toBe("fix it");

    const dead = { url: async () => { throw new Error("closed"); }, snapshotTree: async () => { throw new Error("closed"); } } as unknown as Browser;
    const s2 = await generateFixSuggestion(SCENARIO, failedMetrics({ failure_snapshot: undefined }), dead, client);
    expect(s2.text.length).toBeGreaterThan(0);
  });
});
