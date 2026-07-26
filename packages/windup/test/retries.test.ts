import { describe, expect, it, vi } from "vitest";
import { runWithRetries, runPool } from "../src/runner.js";
import type { FailureKind, RunMetrics, Scenario } from "../src/types.js";

const scenario = { scenario_id: "s", task: "t" } as Scenario;
const planner = {} as never;

const m = (result: "passed" | "failed", kind?: FailureKind): RunMetrics =>
  ({ scenario_id: "s", result, failure: result === "passed" ? null : { kind: kind!, action_id: null, message: "x" } } as RunMetrics);

/** A scripted runner: returns the next queued result each call, recording calls. */
const scripted = (...seq: RunMetrics[]) => {
  let i = 0;
  return vi.fn(async () => seq[Math.min(i++, seq.length - 1)]);
};

describe("runWithRetries (--retries)", () => {
  it("passes on the first try → one call, no attempts/flaky annotation", async () => {
    const run = scripted(m("passed"));
    const r = await runWithRetries(scenario, planner, {} as never, 2, undefined, run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(r.result).toBe("passed");
    expect(r.attempts).toBeUndefined();
    expect(r.flaky).toBeUndefined();
  });

  it("retries a flaky (network) failure then passes → flaky, attempts counted", async () => {
    const run = scripted(m("failed", "network"), m("failed", "network"), m("passed"));
    const onRetry = vi.fn();
    const r = await runWithRetries(scenario, planner, {} as never, 2, onRetry, run);
    expect(run).toHaveBeenCalledTimes(3);
    expect(r.result).toBe("passed");
    expect(r.attempts).toBe(3);
    expect(r.flaky).toBe(true);
    expect(onRetry).toHaveBeenCalledTimes(2); // announced before each of the 2 retries
  });

  it("never retries a forbidden block — a deliberate guard, not a flake", async () => {
    const run = scripted(m("failed", "forbidden"));
    const r = await runWithRetries(scenario, planner, {} as never, 3, undefined, run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(r.result).toBe("failed");
    expect(r.attempts).toBeUndefined(); // single attempt → no annotation
  });

  it("exhausts retries on a persistent failure → attempts counted, not flaky", async () => {
    const run = scripted(m("failed", "verification"), m("failed", "verification"), m("failed", "verification"));
    const r = await runWithRetries(scenario, planner, {} as never, 2, undefined, run);
    expect(run).toHaveBeenCalledTimes(3); // 1 + 2 retries
    expect(r.result).toBe("failed");
    expect(r.attempts).toBe(3);
    expect(r.flaky).toBeFalsy();
  });

  it("retries=0 runs exactly once even on a flaky failure", async () => {
    const run = scripted(m("failed", "network"), m("passed"));
    const r = await runWithRetries(scenario, planner, {} as never, 0, undefined, run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(r.result).toBe("failed");
  });
});

describe("runPool shouldStop (--max-wall budget halt)", () => {
  it("stops dispatching new tasks once shouldStop flips, keeping completed results", async () => {
    let done = 0;
    const tasks = Array.from({ length: 10 }, (_, i) => async () => { done++; return i; });
    // Stop after 3 have completed — the pool must not start the remaining 7.
    const out = await runPool(tasks, 1, () => done >= 3);
    expect(out).toEqual([0, 1, 2]);
    expect(done).toBe(3);
  });

  it("with shouldStop never true, runs everything", async () => {
    const tasks = Array.from({ length: 5 }, (_, i) => async () => i);
    expect(await runPool(tasks, 2, () => false)).toEqual([0, 1, 2, 3, 4]);
  });
});
