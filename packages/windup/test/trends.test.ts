import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildTrends } from "../src/trends.js";
import { quarantinedScenarioIds } from "../src/scenario.js";
import { createContext, setContext, getContext } from "../src/context.js";

let ctx: ReturnType<typeof createContext>;

const run = (id: string, at: string, result: "passed" | "failed", ms: number): string =>
  JSON.stringify({ scenario_id: id, started_at: at, cache: "hit", llm_calls: 0, llm_model: null, tokens: { input: 0, output: 0 }, estimated_cost_usd: 0, duration_ms: { total: ms, planning: 0, execution: ms }, actions: [], result, failure: result === "passed" ? null : { kind: "verification", action_id: "a1", message: "x" } });

beforeEach(async () => {
  const root = await mkdtemp(path.join(tmpdir(), "windup-trends-"));
  ctx = createContext(root, { scenariosDir: "e2e" });
  setContext(ctx);
  await mkdir(ctx.paths.runsDir, { recursive: true });
  await mkdir(ctx.paths.scenariosDir, { recursive: true });
  // login: 3 runs, 2 passed; checkout: 2 runs, both failed
  await writeFile(path.join(ctx.paths.runsDir, "1.json"), run("login", "2026-07-20T10:00:00.000Z", "passed", 100));
  await writeFile(path.join(ctx.paths.runsDir, "2.json"), run("login", "2026-07-21T10:00:00.000Z", "failed", 120));
  await writeFile(path.join(ctx.paths.runsDir, "3.json"), run("login", "2026-07-22T10:00:00.000Z", "passed", 110));
  await writeFile(path.join(ctx.paths.runsDir, "4.json"), run("checkout", "2026-07-20T10:00:00.000Z", "failed", 200));
  await writeFile(path.join(ctx.paths.runsDir, "5.json"), run("checkout", "2026-07-21T10:00:00.000Z", "failed", 210));
});
afterAll(() => setContext(createContext()));

describe("windup trends", () => {
  it("summarizes per scenario, worst pass-rate first", async () => {
    const t = await buildTrends();
    expect(t.scenarios.map((s) => s.scenario_id)).toEqual(["checkout", "login"]); // 0% before 67%
    const login = t.scenarios.find((s) => s.scenario_id === "login")!;
    expect(login.runs).toBe(3);
    expect(login.passed).toBe(2);
    expect(login.pass_rate).toBe(0.667);
    expect(login.avg_ms).toBe(110);
    expect(login.recent).toEqual(["pass", "fail", "pass"]); // oldest→newest
  });

  it("a single scenario returns its timeline chronologically", async () => {
    const t = await buildTrends({ scenario: "login" });
    expect(t.timeline).toHaveLength(3);
    expect(t.timeline!.map((r) => r.result)).toEqual(["passed", "failed", "passed"]);
    expect(t.timeline![0].at < t.timeline![2].at).toBe(true);
  });

  it("--last trims a scenario's timeline", async () => {
    const t = await buildTrends({ scenario: "login", last: 2 });
    expect(t.timeline).toHaveLength(2);
    expect(t.timeline!.map((r) => r.result)).toEqual(["failed", "passed"]); // the last two
  });
});

describe("scenario.quarantine", () => {
  it("quarantinedScenarioIds collects only quarantined scenarios", async () => {
    await writeFile(path.join(ctx.paths.scenariosDir, "flaky.json"), JSON.stringify({ scenario_id: "flaky", start_url: "/", task: "x", quarantine: true }));
    await writeFile(path.join(ctx.paths.scenariosDir, "solid.json"), JSON.stringify({ scenario_id: "solid", start_url: "/", task: "x" }));
    const q = await quarantinedScenarioIds();
    expect([...q]).toEqual(["flaky"]);
  });
});
