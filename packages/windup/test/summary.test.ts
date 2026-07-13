import { describe, expect, it } from "vitest";
import { buildSummaryPrompt, generateRunSummary } from "../src/summary.js";
import type { Browser } from "../src/browser.js";
import type { LlmClient } from "../src/llm.js";
import type { RunMetrics, Scenario } from "../src/types.js";

const SCENARIO: Scenario = { scenario_id: "precos", task: "Acessar a página de preços e verificar os planos exibidos." };

function metrics(over: Partial<RunMetrics> = {}): RunMetrics {
  return {
    scenario_id: "precos", started_at: "2026-07-13T10:00:00Z", cache: "hit", llm_calls: 0,
    llm_model: null, llm_provider: null, planning_mode: null, plan_semantic_retries: null,
    sig_mismatch: null, prompt_chars: null, tokens: { input: 0, output: 0 }, estimated_cost_usd: 0,
    duration_ms: { total: 900, planning: 0, execution: 700 },
    actions: [{ id: "a1", duration_ms: 6200, verify_ms: 100, status: "passed" }],
    result: "passed", failure: null,
    plan: {
      plan_version: "0.1", scenario_id: "precos", start_url: "/",
      actions: [{ id: "a1", type: "click", target: { selector: "a[href='/precos']", description: "link Preços" }, expect: { url: "**/precos" } }],
    },
    ...over,
  };
}

const fakeBrowser = {
  url: async () => "http://localhost:3000/precos",
  snapshotTree: async () => 'heading "Planos"\ntext "Starter R$ 49/mês"\ntext "Pro R$ 149/mês"',
} as unknown as Browser;

describe("run --summary (resumo pós-execução)", () => {
  it("prompt inclui tarefa, plano, desfecho, anomalias e o snapshot final", () => {
    const prompt = buildSummaryPrompt(SCENARIO, metrics({ sig_mismatch: true, cache: "invalidated" }), "http://x/precos", 'text "Starter R$ 49"');
    expect(prompt).toContain("página de preços");
    expect(prompt).toContain("PASSOU");
    expect(prompt).toContain("link Preços");
    expect(prompt).toContain("re-planejado do zero");
    expect(prompt).toContain("sig_mismatch");
    expect(prompt).toContain("ações lentas (>5s): a1");
    expect(prompt).toContain('Starter R$ 49');
    expect(prompt).toContain("LITERALMENTE");
  });

  it("falha entra no prompt como desfecho", () => {
    const prompt = buildSummaryPrompt(
      SCENARIO,
      metrics({ result: "failed", failure: { kind: "verification", action_id: "a1", message: "not visible" } }),
      "", "",
    );
    expect(prompt).toContain("FALHOU");
    expect(prompt).toContain("[verification]");
  });

  it("gera o resumo com tokens/custo do client e sobrevive a browser morto", async () => {
    const client: LlmClient = {
      provider: "google", model: "gemini-3.1-flash-lite",
      generate: async () => ({ text: "O teste passou; os planos exibidos são Starter R$ 49/mês e Pro R$ 149/mês.", tokens: { input: 2000, output: 60 }, truncated: false }),
    };
    const s = await generateRunSummary(SCENARIO, metrics(), fakeBrowser, client);
    expect(s.text).toContain("R$ 49");
    expect(s.est_cost_usd).toBeCloseTo(2000 * 0.25 / 1e6 + 60 * 1.5 / 1e6, 6);

    const dead = { url: async () => { throw new Error("closed"); }, snapshotTree: async () => { throw new Error("closed"); } } as unknown as Browser;
    const s2 = await generateRunSummary(SCENARIO, metrics(), dead, client);
    expect(s2.text.length).toBeGreaterThan(10);
  });
});
