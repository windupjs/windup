import { describe, expect, it } from "vitest";
import { estimateCostUsd, PRICING } from "../src/metrics.js";

describe("estimateCostUsd", () => {
  it("computes the cost with the current gemini-2.5-flash prices", () => {
    // 6200 in + 480 out (doc 03 example) at 0.30/2.50 per 1M
    const cost = estimateCostUsd({ input: 6200, output: 480 });
    expect(cost).toBeCloseTo(6200e-6 * 0.3 + 480e-6 * 2.5, 6);
  });

  it("zero tokens = zero cost", () => {
    expect(estimateCostUsd({ input: 0, output: 0 })).toBe(0);
  });

  it("the pricing table has an effective date", () => {
    expect(PRICING.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("uses the model's price when known (flash-lite ≠ fallback)", () => {
    const lite = estimateCostUsd({ input: 1_000_000, output: 1_000_000 }, "gemini-3.1-flash-lite");
    expect(lite).toBeCloseTo(0.25 + 1.5, 6);
    const desconhecido = estimateCostUsd({ input: 1_000_000, output: 1_000_000 }, "modelo-desconhecido");
    expect(desconhecido).toBeCloseTo(0.3 + 2.5, 6);
  });

  it("a subscription provider costs $0 — never the fallback rate", () => {
    const tokens = { input: 1_000_000, output: 1_000_000 };
    // Same tokens, same unknown-to-the-table model: the PROVIDER decides.
    expect(estimateCostUsd(tokens, "claude-sonnet-4-6", "claude-code")).toBe(0);
    expect(estimateCostUsd(tokens, "claude-sonnet-4-6")).toBeCloseTo(0.3 + 2.5, 6);
  });

  it("a per-token provider is unaffected by the subscription rule", () => {
    const tokens = { input: 1_000_000, output: 1_000_000 };
    expect(estimateCostUsd(tokens, "gemini-3.1-flash-lite", "google")).toBeCloseTo(0.25 + 1.5, 6);
  });
});
