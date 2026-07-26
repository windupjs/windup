import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { githubAnnotate, githubStepSummary, inGithubActions } from "../src/github.js";
import { buildSuiteSummary } from "../src/suite.js";
import type { RunMetrics } from "../src/types.js";

const m = (over: Partial<RunMetrics>): RunMetrics => ({
  scenario_id: "s", started_at: "2026-07-26T00:00:00Z", cache: "hit", llm_calls: 0,
  llm_model: null, llm_provider: null, planning_mode: null, plan_semantic_retries: null, sig_mismatch: null,
  prompt_chars: null, tokens: { input: 0, output: 0 }, estimated_cost_usd: 0,
  duration_ms: { total: 1000, planning: 0, execution: 1000 }, actions: [], result: "passed", failure: null, ...over,
});

afterEach(() => { delete process.env.GITHUB_STEP_SUMMARY; delete process.env.GITHUB_ACTIONS; vi.restoreAllMocks(); });

describe("GitHub Actions reporter", () => {
  it("inGithubActions reflects the env", () => {
    expect(inGithubActions()).toBe(false);
    process.env.GITHUB_ACTIONS = "true";
    expect(inGithubActions()).toBe(true);
  });

  it("annotates only failures, with escaped newlines", () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((s?: unknown) => { lines.push(String(s)); });
    githubAnnotate([
      m({ scenario_id: "ok" }),
      m({ scenario_id: "checkout", result: "failed", failure: { kind: "verification", action_id: "a3", message: "selector not visible\nsecond line" } }),
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("::error title=windup: checkout::");
    expect(lines[0]).toContain("[verification] action=a3");
    expect(lines[0]).toContain("%0A"); // newline escaped
    expect(lines[0]).not.toContain("\n");
  });

  it("appends a Markdown suite summary to $GITHUB_STEP_SUMMARY", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "windup-gh-"));
    const file = path.join(dir, "summary.md");
    process.env.GITHUB_STEP_SUMMARY = file;
    const results = [m({ scenario_id: "a" }), m({ scenario_id: "b", result: "failed", failure: { kind: "network", action_id: null, message: "x" } })];
    await githubStepSummary(buildSuiteSummary(results, { wall_ms: 5000, concurrency: 2 }), results);
    const md = await readFile(file, "utf8");
    expect(md).toContain("## Windup — 1/2 passed (50%)");
    expect(md).toContain("wall 5.0s");
    expect(md).toContain("| a | ✅ |");
    expect(md).toContain("| b | ❌ |");
  });

  it("is a no-op when GITHUB_STEP_SUMMARY is unset", async () => {
    await expect(githubStepSummary(buildSuiteSummary([m({})]), [m({})])).resolves.toBeUndefined();
  });
});
