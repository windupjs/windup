import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { CacheEntry, Plan, Scenario } from "../src/types.js";

// Isola o cache num diretório temporário ANTES de importar o módulo.
process.env.SPIKE_CACHE_DIR = await mkdtemp(path.join(tmpdir(), "spike-cache-"));
const cache = await import("../src/cache.js");

const scenario: Scenario = {
  scenario_id: "ciclo-teste",
  start_url: "https://exemplo.com",
  task: "tarefa de teste",
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

describe("ciclo replay-falha → invalidate → re-plano → save (doc 07-A3)", () => {
  beforeAll(async () => {
    await cache.clearCache();
  });

  it("miss → save → hit com plan_generation=1", async () => {
    expect(await cache.getCached(scenario)).toBeNull();
    await cache.saveCached(scenario, plan);
    const entry = await cache.getCached(scenario);
    expect(entry?.status).toBe("active");
    expect(entry?.stats.plan_generation).toBe(1);
  });

  it("recordReplay incrementa replay_count", async () => {
    const entry = (await cache.getCached(scenario))!;
    await cache.recordReplay(entry);
    expect((await cache.getCached(scenario))!.stats.replay_count).toBe(1);
  });

  it("invalidate preserva evidência em arquivo .stale-* e vira miss", async () => {
    const entry = (await cache.getCached(scenario))!;
    await cache.invalidate(entry);
    expect(await cache.getCached(scenario)).toBeNull();

    const files = await readdir(cache.CACHE_DIR);
    const stale = files.filter((f) => f.startsWith("ciclo-teste.stale-"));
    expect(stale).toHaveLength(1);
    const staleEntry = JSON.parse(
      await readFile(path.join(cache.CACHE_DIR, stale[0]), "utf8"),
    ) as CacheEntry;
    expect(staleEntry.status).toBe("stale");
    expect(staleEntry.stats.replay_failures).toBe(1);
  });

  it("re-save acumula contadores e incrementa plan_generation", async () => {
    await cache.saveCached(scenario, plan);
    const entry = (await cache.getCached(scenario))!;
    expect(entry.status).toBe("active");
    expect(entry.stats.plan_generation).toBe(2);
    expect(entry.stats.replay_count).toBe(1);
    expect(entry.stats.replay_failures).toBe(1);
  });

  it("mantém no máximo 3 arquivos stale", async () => {
    for (let i = 0; i < 4; i++) {
      const entry = (await cache.getCached(scenario))!;
      await new Promise((r) => setTimeout(r, 5)); // timestamps distintos no nome
      await cache.invalidate(entry);
      await cache.saveCached(scenario, plan);
    }
    const files = await readdir(cache.CACHE_DIR);
    expect(files.filter((f) => f.startsWith("ciclo-teste.stale-")).length).toBeLessThanOrEqual(3);
  });

  it("clearCache remove também os stale", async () => {
    await cache.clearCache();
    let files: string[] = [];
    try {
      files = await readdir(cache.CACHE_DIR);
    } catch {
      // diretório removido por inteiro também vale
    }
    expect(files.filter((f) => f.includes("stale"))).toHaveLength(0);
  });
});
