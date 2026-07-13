import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildCostsReport } from "../src/costs.js";
import { createContext, setContext } from "../src/context.js";

function run(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    scenario_id: "s1",
    started_at: "2026-07-12T10:00:00.000Z",
    cache: "miss",
    llm_calls: 1,
    llm_model: "gemini-3.1-flash-lite",
    tokens: { input: 4000, output: 1000 },
    estimated_cost_usd: 0,
    duration_ms: { total: 1, planning: 1, execution: 1 },
    actions: [],
    result: "passed",
    failure: null,
    ...overrides,
  });
}

describe("windup costs (buildCostsReport)", () => {
  let runsDir: string;

  beforeAll(async () => {
    const root = await mkdtemp(path.join(tmpdir(), "windup-costs-"));
    const ctx = createContext(root);
    runsDir = ctx.paths.runsDir;
    await mkdir(runsDir, { recursive: true });
    setContext(ctx);

    await writeFile(path.join(runsDir, "a.json"), run({}));
    await writeFile(path.join(runsDir, "b.json"), run({ started_at: "2026-07-12T11:00:00.000Z", cache: "hit", llm_calls: 0, llm_model: null, tokens: { input: 0, output: 0 } }));
    await writeFile(path.join(runsDir, "c.json"), run({ started_at: "2026-07-10T09:00:00.000Z", scenario_id: "s2", llm_model: "gemini-2.5-flash", llm_calls: 4, tokens: { input: 9000, output: 24000 } }));
    // run with another provider (multi-provider): llm_provider recorded
    await writeFile(
      path.join(runsDir, "d.json"),
      run({ started_at: "2026-07-12T12:00:00.000Z", scenario_id: "s3", llm_model: "gpt-5-mini", llm_provider: "openai", llm_calls: 2, tokens: { input: 8000, output: 2000 } }),
    );
    await writeFile(path.join(runsDir, "bench-x.json"), '{"does":"not-count"}');
    await writeFile(path.join(runsDir, "quebrado.json"), "{corrompido");
  });

  it("aggregates totals, free replays and the breakdown by model/scenario", async () => {
    const r = await buildCostsReport();
    expect(r.runs).toBe(4);
    expect(r.llm_calls).toBe(7);
    expect(r.free_replays).toBe(1);
    // cost recomputed with the per-model table:
    // lite: 4000*0.25/1M + 1000*1.5/1M = 0.0025 · flash: 9000*0.3/1M + 24000*2.5/1M = 0.0627
    // gpt-5-mini: 8000*0.25/1M + 2000*2/1M = 0.006
    expect(r.est_cost_usd).toBeCloseTo(0.0025 + 0.0627 + 0.006, 4);
    expect(r.by_model["gemini-3.1-flash-lite"].est_cost_usd).toBeCloseTo(0.0025, 4);
    expect(r.by_model["gemini-2.5-flash"].est_cost_usd).toBeCloseTo(0.0627, 4);
    expect(r.by_scenario.s1.runs).toBe(2);
    expect(r.by_scenario.s2.llm_calls).toBe(4);
  });

  it("breakdown by provider — old records without llm_provider are inferred from the model", async () => {
    const r = await buildCostsReport();
    // gemini-* (no llm_provider recorded) → google; gpt-5-mini recorded as openai
    expect(r.by_provider.google.calls).toBe(5);
    expect(r.by_provider.google.est_cost_usd).toBeCloseTo(0.0025 + 0.0627, 4);
    expect(r.by_provider.openai.calls).toBe(2);
    expect(r.by_provider.openai.est_cost_usd).toBeCloseTo(0.006, 4);
  });

  it("orders the last runs from newest to oldest and respects --last", async () => {
    const r = await buildCostsReport({ last: 2 });
    expect(r.last_runs).toHaveLength(2);
    expect(r.last_runs[0].scenario).toBe("s3");
    expect(r.last_runs[0].provider).toBe("openai");
    expect(r.last_runs[1].cache).toBe("hit");
    expect(r.last_runs[1].est_cost_usd).toBe(0);
  });

  it("--days filters by time window", async () => {
    // c.json is from 2026-07-10; with days=1 counted from "now" (>= 07/12) it drops out
    const r = await buildCostsReport({ days: 1 });
    expect(r.by_scenario.s2).toBeUndefined();
  });
});
