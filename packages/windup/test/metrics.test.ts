import { describe, expect, it } from "vitest";
import { estimateCostUsd, PRICING } from "../src/metrics.js";

describe("estimateCostUsd", () => {
  it("calcula custo pelos preços vigentes do gemini-2.5-flash", () => {
    // 6200 in + 480 out (exemplo do doc 03) a 0.30/2.50 por 1M
    const cost = estimateCostUsd({ input: 6200, output: 480 });
    expect(cost).toBeCloseTo(6200e-6 * 0.3 + 480e-6 * 2.5, 6);
  });

  it("zero tokens = custo zero", () => {
    expect(estimateCostUsd({ input: 0, output: 0 })).toBe(0);
  });

  it("a tabela de preços tem data de vigência", () => {
    expect(PRICING.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("usa o preço do modelo quando conhecido (flash-lite ≠ fallback)", () => {
    const lite = estimateCostUsd({ input: 1_000_000, output: 1_000_000 }, "gemini-3.1-flash-lite");
    expect(lite).toBeCloseTo(0.25 + 1.5, 6);
    const desconhecido = estimateCostUsd({ input: 1_000_000, output: 1_000_000 }, "modelo-desconhecido");
    expect(desconhecido).toBeCloseTo(0.3 + 2.5, 6);
  });
});
