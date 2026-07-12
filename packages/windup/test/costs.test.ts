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
    await writeFile(path.join(runsDir, "bench-x.json"), '{"nao":"conta"}');
    await writeFile(path.join(runsDir, "quebrado.json"), "{corrompido");
  });

  it("agrega totais, replays gratuitos e quebra por modelo/cenário", async () => {
    const r = await buildCostsReport();
    expect(r.runs).toBe(3);
    expect(r.llm_calls).toBe(5);
    expect(r.free_replays).toBe(1);
    // custo recomputado com a tabela por modelo:
    // lite: 4000*0.25/1M + 1000*1.5/1M = 0.0025 · flash: 9000*0.3/1M + 24000*2.5/1M = 0.0627
    expect(r.est_cost_usd).toBeCloseTo(0.0025 + 0.0627, 4);
    expect(r.by_model["gemini-3.1-flash-lite"].est_cost_usd).toBeCloseTo(0.0025, 4);
    expect(r.by_model["gemini-2.5-flash"].est_cost_usd).toBeCloseTo(0.0627, 4);
    expect(r.by_scenario.s1.runs).toBe(2);
    expect(r.by_scenario.s2.llm_calls).toBe(4);
  });

  it("ordena os últimos runs do mais recente para o mais antigo e respeita --last", async () => {
    const r = await buildCostsReport({ last: 2 });
    expect(r.last_runs).toHaveLength(2);
    expect(r.last_runs[0].cache).toBe("hit");
    expect(r.last_runs[0].est_cost_usd).toBe(0);
  });

  it("--days filtra por janela de tempo", async () => {
    // c.json é de 2026-07-10; com days=1 a partir de "agora" (>= 12/07) ele sai
    const r = await buildCostsReport({ days: 1 });
    expect(r.by_scenario.s2).toBeUndefined();
  });
});
