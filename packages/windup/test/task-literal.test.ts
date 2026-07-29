import { describe, expect, it } from "vitest";
import { assertTaskLiteral, taskLiteral } from "../src/planner.js";
import { trivialExpect } from "../src/schema.js";
import type { Plan } from "../src/types.js";

describe("taskLiteral — the text a task asks to verify", () => {
  it("pulls the quoted literal (the real reported task)", () => {
    expect(
      taskLiteral("Confirm the text 'Estacionamentos Populares' is visible on the home page and at least one price in 'R$' format appears."),
    ).toBe("Estacionamentos Populares"); // longest wins over the short 'R$'
  });
  it("handles double and curly quotes", () => {
    expect(taskLiteral('verify "Order confirmed" appears')).toBe("Order confirmed");
    expect(taskLiteral("verify “Bem-vindo de volta” appears")).toBe("Bem-vindo de volta");
  });
  it("ignores quotes that are selectors, URLs or flags", () => {
    expect(taskLiteral("click '#submit-button' then continue")).toBeNull();
    expect(taskLiteral("go to 'https://app.test/orders'")).toBeNull();
    expect(taskLiteral("pass '--headed' to the runner")).toBeNull();
  });
  it("ignores too-short quotes and unquoted tasks", () => {
    expect(taskLiteral("verify 'ok' appears")).toBeNull();
    expect(taskLiteral("verify the dashboard loads")).toBeNull();
  });
});

const planWith = (finalExpect: unknown): Plan => ({
  plan_version: "0.1", scenario_id: "home", start_url: "https://app.test/",
  actions: [
    { id: "a1", type: "click", target: { selector: "#go", description: "go" }, timeout_ms: 5000 },
    { id: "a2", type: "wait_for", target: { selector: "h2", description: "heading" }, expect: finalExpect, timeout_ms: 5000 },
  ],
} as never);

describe("assertTaskLiteral — deterministic repair, no LLM call", () => {
  it("rewrites a vacuous final check into a text assertion on the task's literal", () => {
    const out = assertTaskLiteral(planWith({ selector: "body" }), "Estacionamentos Populares");
    const last = out.actions[out.actions.length - 1];
    expect(last.expect?.text_contains).toEqual({ selector: "body", text: "Estacionamentos Populares" });
    expect(last.expect?.selector).toBeUndefined(); // the bare landmark is dropped
    expect(trivialExpect(last.expect)).toBe(false); // and the plan now passes validation
  });
  it("also repairs the generic-but-not-landmark case (the h2 hole)", () => {
    const out = assertTaskLiteral(planWith({ selector: "h2" }), "Estacionamentos Populares");
    expect(out.actions[1].expect?.text_contains?.text).toBe("Estacionamentos Populares");
  });
  it("never overwrites a postcondition that already discriminates", () => {
    const good = { text_contains: { selector: "#total", text: "R$ 42,00" } };
    const out = assertTaskLiteral(planWith(good), "Estacionamentos Populares");
    expect(out.actions[1].expect).toEqual(good);
  });
  it("keeps a specific selector and ANDs the text onto it (strictly stronger)", () => {
    const out = assertTaskLiteral(planWith({ selector: "#product-grid" }), "Estacionamentos Populares");
    expect(out.actions[1].expect).toEqual({
      selector: "#product-grid",
      text_contains: { selector: "body", text: "Estacionamentos Populares" },
    });
  });

  it("drops a landmark selector instead of keeping it", () => {
    const out = assertTaskLiteral(planWith({ selector: "main" }), "Estacionamentos Populares");
    expect(out.actions[1].expect?.selector).toBeUndefined();
  });
});
