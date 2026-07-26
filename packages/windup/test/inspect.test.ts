import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createContext, setContext } from "../src/context.js";
import { saveCached } from "../src/cache.js";
import { explainPlan } from "../src/explain.js";
import { buildWhy } from "../src/why.js";
import { buildDiff } from "../src/diff.js";
import { buildBadge, badgeSvg, badgeJson } from "../src/badge.js";
import type { Plan, Scenario } from "../src/types.js";

let ctx: ReturnType<typeof createContext>;

const ledgerRecord = (o: Record<string, unknown>): string =>
  JSON.stringify({ scenario_id: "checkout", started_at: "2026-07-20T10:00:00.000Z", cache: "hit", llm_calls: 0, llm_model: null, tokens: { input: 0, output: 0 }, estimated_cost_usd: 0, duration_ms: { total: 100, planning: 0, execution: 100 }, actions: [{ id: "a1" }], result: "passed", failure: null, ...o });

beforeAll(async () => {
  process.env.WINDUP_BASE_URL = "http://localhost:3000";
  const root = await mkdtemp(path.join(tmpdir(), "windup-inspect-"));
  ctx = createContext(root);
  setContext(ctx);
  await mkdir(ctx.paths.runsDir, { recursive: true });
  await mkdir(ctx.paths.scenariosDir, { recursive: true });

  const scenario: Scenario = { scenario_id: "checkout", start_url: "/", task: "log in and check out, verify the confirmation" };
  await writeFile(path.join(ctx.paths.scenariosDir, "checkout.json"), JSON.stringify(scenario));
  const plan: Plan = { plan_version: "0.1", scenario_id: "checkout", start_url: "/", task: scenario.task, actions: [
    { id: "a1", type: "goto", url: "/login", expect: {}, timeout_ms: 5000 },
    { id: "a2", type: "fill", target: { selector: "#otp", description: "one-time code" }, value_ref: "otp_code", expect: {}, timeout_ms: 5000 },
    { id: "a3", type: "click", target: { selector: "#place-order", description: "Place order" }, expect: { selector: "#confirmation" }, timeout_ms: 5000 },
  ]};
  await saveCached(scenario, plan);

  // two ledger runs (older slower+passed, newer faster+failed) for diff/why/badge
  await writeFile(path.join(ctx.paths.runsDir, "r1.json"), ledgerRecord({ started_at: "2026-07-20T10:00:00.000Z", duration_ms: { total: 200, planning: 0, execution: 200 } }));
  await writeFile(path.join(ctx.paths.runsDir, "r2.json"), ledgerRecord({ started_at: "2026-07-21T10:00:00.000Z", duration_ms: { total: 120, planning: 0, execution: 120 }, result: "failed", failure: { kind: "verification", action_id: "a3", message: "#confirmation not visible" }, failure_snapshot: "…" }));
});
afterAll(() => { delete process.env.WINDUP_BASE_URL; setContext(createContext()); });

describe("windup explain", () => {
  it("renders the cached plan as readable steps and never leaks a fill value", async () => {
    const e = await explainPlan("checkout");
    expect(e.planned).toBe(true);
    expect(e.steps.some((s) => s.includes("go to /login"))).toBe(true);
    expect(e.steps.some((s) => s.includes("fill one-time code with {otp_code}"))).toBe(true); // ref name, not a value
    expect(e.steps.some((s) => s.includes("#confirmation is visible"))).toBe(true);
  });
  it("reports not-planned for an unknown/uncached scenario", async () => {
    const scenario: Scenario = { scenario_id: "ghost", start_url: "/", task: "x" };
    await writeFile(path.join(ctx.paths.scenariosDir, "ghost.json"), JSON.stringify(scenario));
    expect((await explainPlan("ghost")).planned).toBe(false);
  });
});

describe("windup why", () => {
  it("summarizes cache readiness, history and the last failure", async () => {
    const w = await buildWhy("checkout");
    expect(w.cache.ready).toBe(true);
    expect(w.history.runs).toBe(2);
    expect(w.history.passed).toBe(1);
    expect(w.last?.result).toBe("failed");
    expect(w.last?.failure?.kind).toBe("verification");
    expect(w.last?.has_snapshot).toBe(true);
  });
});

describe("windup diff", () => {
  it("computes deltas and flags the result flip between the two latest runs", async () => {
    const d = await buildDiff("checkout");
    expect(d.enough).toBe(true);
    expect(d.a?.result).toBe("passed");
    expect(d.b?.result).toBe("failed");
    expect(d.deltas?.total_ms).toBe(-80); // 120 - 200
  });
  it("needs two runs", async () => {
    expect((await buildDiff("nonexistent")).enough).toBe(false);
  });
});

describe("windup badge", () => {
  it("computes suite status from each scenario's latest run", async () => {
    const b = await buildBadge();
    expect(b.total).toBe(1); // one scenario has runs (checkout); latest is failed
    expect(b.passed).toBe(0);
    expect(b.color).toBe("red");
    expect(badgeSvg(b)).toContain("<svg");
    expect(JSON.parse(badgeJson(b))).toMatchObject({ schemaVersion: 1, label: "windup" });
  });
});
