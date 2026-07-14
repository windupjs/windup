import { describe, expect, it } from "vitest";
import { runPool } from "../src/runner.js";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("runPool (parallel run --all)", () => {
  it("preserves result order even when tasks finish out of order", async () => {
    const tasks = [
      async () => { await tick(30); return "a"; },
      async () => { await tick(5); return "b"; },
      async () => { await tick(15); return "c"; },
    ];
    expect(await runPool(tasks, 3)).toEqual(["a", "b", "c"]);
  });

  it("never runs more than `limit` tasks at once", async () => {
    let inFlight = 0;
    let peak = 0;
    const tasks = Array.from({ length: 10 }, () => async () => {
      inFlight++; peak = Math.max(peak, inFlight);
      await tick(10);
      inFlight--;
      return inFlight;
    });
    await runPool(tasks, 3);
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1); // actually parallelized
  });

  it("runs every task exactly once and returns them all", async () => {
    const seen = new Set<number>();
    const tasks = Array.from({ length: 7 }, (_, i) => async () => { seen.add(i); return i; });
    const out = await runPool(tasks, 2);
    expect(out).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(seen.size).toBe(7);
  });

  it("limit >= number of tasks and limit 1 both work", async () => {
    expect(await runPool([async () => 1, async () => 2], 10)).toEqual([1, 2]);
    let order: number[] = [];
    await runPool([
      async () => { await tick(10); order.push(1); },
      async () => { order.push(2); },
    ], 1);
    expect(order).toEqual([1, 2]); // limit 1 = strictly sequential
  });
});
