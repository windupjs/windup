import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { CacheEntry, Plan, Scenario } from "../src/types.js";

// Isolate the cache in a temp directory BEFORE importing the module.
process.env.WINDUP_CACHE_DIR = await mkdtemp(path.join(tmpdir(), "windup-cache-"));
const cache = await import("../src/cache.js");

const scenario: Scenario = {
  scenario_id: "ciclo-teste",
  start_url: "https://exemplo.com",
  task: "test task",
};

const plan: Plan = {
  plan_version: "0.1",
  scenario_id: "ciclo-teste",
  start_url: "https://exemplo.com",
  actions: [
    {
      id: "a1",
      type: "click",
      target: { selector: "#x", description: "x" },
      expect: { selector: "#ok" },
    },
  ],
};

describe("replay-failure → invalidate → re-plan → save cycle (doc 07-A3)", () => {
  beforeAll(async () => {
    await cache.clearCache();
  });

  it("miss → save → hit with plan_generation=1", async () => {
    expect(await cache.getCached(scenario)).toBeNull();
    await cache.saveCached(scenario, plan);
    const entry = await cache.getCached(scenario);
    expect(entry?.status).toBe("active");
    expect(entry?.stats.plan_generation).toBe(1);
  });

  it("recordReplay increments replay_count", async () => {
    const entry = (await cache.getCached(scenario))!;
    await cache.recordReplay(entry);
    expect((await cache.getCached(scenario))!.stats.replay_count).toBe(1);
  });

  it("invalidate preserves evidence in a .stale-* file and becomes a miss", async () => {
    const entry = (await cache.getCached(scenario))!;
    await cache.invalidate(entry);
    expect(await cache.getCached(scenario)).toBeNull();

    const files = await readdir(cache.cacheDir());
    const stale = files.filter((f) => f.startsWith("ciclo-teste.stale-"));
    expect(stale).toHaveLength(1);
    const staleEntry = JSON.parse(
      await readFile(path.join(cache.cacheDir(), stale[0]), "utf8"),
    ) as CacheEntry;
    expect(staleEntry.status).toBe("stale");
    expect(staleEntry.stats.replay_failures).toBe(1);
  });

  it("re-save accumulates counters and increments plan_generation", async () => {
    await cache.saveCached(scenario, plan);
    const entry = (await cache.getCached(scenario))!;
    expect(entry.status).toBe("active");
    expect(entry.stats.plan_generation).toBe(2);
    expect(entry.stats.replay_count).toBe(1);
    expect(entry.stats.replay_failures).toBe(1);
  });

  it("keeps at most 3 stale files", async () => {
    for (let i = 0; i < 4; i++) {
      const entry = (await cache.getCached(scenario))!;
      await new Promise((r) => setTimeout(r, 5)); // distinct timestamps in the name
      await cache.invalidate(entry);
      await cache.saveCached(scenario, plan);
    }
    const files = await readdir(cache.cacheDir());
    expect(files.filter((f) => f.startsWith("ciclo-teste.stale-")).length).toBeLessThanOrEqual(3);
  });

  it("clearCache also removes the stale files", async () => {
    await cache.clearCache();
    let files: string[] = [];
    try {
      files = await readdir(cache.cacheDir());
    } catch {
      // the whole directory being removed also counts
    }
    expect(files.filter((f) => f.includes("stale"))).toHaveLength(0);
  });
});

describe("edited task invalidates the hit (miss)", () => {
  it("same id/start_url but different task → miss", async () => {
    const { saveCached, getCached } = await import("../src/cache.js");
    const scenario = { scenario_id: "edicao-task", start_url: "https://x.test/a", task: "original task" };
    const plan = { plan_version: "0.1" as const, scenario_id: "edicao-task", task: "original task", start_url: "https://x.test/a", actions: [] };
    await saveCached(scenario, plan);
    expect(await getCached(scenario)).not.toBeNull();
    expect(await getCached({ ...scenario, task: "REWRITTEN task" })).toBeNull();
  });
});
