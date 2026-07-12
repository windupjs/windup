import { describe, expect, it } from "vitest";
import { validatePlan } from "../src/schema.js";
import type { Plan } from "../src/types.js";

/** Plano de exemplo do doc 02 (cenário 1). */
function examplePlan(): Plan {
  return {
    plan_version: "0.1",
    scenario_id: "saucedemo-login",
    start_url: "https://www.saucedemo.com",
    actions: [
      {
        id: "a1",
        type: "fill",
        target: { selector: "#user-name", description: "campo de usuário" },
        value: "standard_user",
        expect: { selector_value: { selector: "#user-name", value: "standard_user" } },
        timeout_ms: 5000,
      },
      {
        id: "a2",
        type: "fill",
        target: { selector: "#password", description: "campo de senha" },
        value: "secret_sauce",
        timeout_ms: 5000,
      },
      {
        id: "a3",
        type: "click",
        target: { selector: "#login-button", description: "botão de login" },
        expect: { url: "**/inventory.html", selector: ".inventory_list" },
        timeout_ms: 10000,
      },
    ],
  };
}

describe("validatePlan", () => {
  it("aceita o plano de exemplo do doc 02", () => {
    const result = validatePlan(examplePlan());
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("rejeita click sem target.selector", () => {
    const plan = examplePlan();
    delete plan.actions[2].target;
    const result = validatePlan(plan);
    expect(result.ok).toBe(false);
    expect(result.errors.join()).toContain("target.selector");
  });

  it("rejeita plano cuja última ação não tem expect", () => {
    const plan = examplePlan();
    delete plan.actions[2].expect;
    const result = validatePlan(plan);
    expect(result.ok).toBe(false);
    expect(result.errors.join()).toContain("final action");
  });

  it("rejeita fill com value E value_ref", () => {
    const plan = examplePlan();
    plan.actions[1].value_ref = "ENV:SAUCE_PASSWORD";
    const result = validatePlan(plan);
    expect(result.ok).toBe(false);
    expect(result.errors.join()).toContain("exactly one");
  });

  it("rejeita fill sem value nem value_ref", () => {
    const plan = examplePlan();
    delete plan.actions[1].value;
    const result = validatePlan(plan);
    expect(result.ok).toBe(false);
  });

  it("aceita fill com value_ref no formato ENV:*", () => {
    const plan = examplePlan();
    delete plan.actions[1].value;
    plan.actions[1].value_ref = "ENV:SAUCE_PASSWORD";
    expect(validatePlan(plan).ok).toBe(true);
  });

  it("rejeita value_ref fora do formato ENV:*", () => {
    const plan = examplePlan();
    delete plan.actions[1].value;
    plan.actions[1].value_ref = "env:sauce";
    expect(validatePlan(plan).ok).toBe(false);
  });

  it("rejeita goto sem url", () => {
    const plan = examplePlan();
    plan.actions.unshift({ id: "a0", type: "goto" });
    const result = validatePlan(plan);
    expect(result.ok).toBe(false);
    expect(result.errors.join()).toContain("goto");
  });

  it("rejeita ids duplicados", () => {
    const plan = examplePlan();
    plan.actions[1].id = "a1";
    const result = validatePlan(plan);
    expect(result.ok).toBe(false);
    expect(result.errors.join()).toContain("duplicate");
  });

  it("rejeita plan_version desconhecida", () => {
    const plan = examplePlan() as unknown as Record<string, unknown>;
    plan.plan_version = "0.2";
    expect(validatePlan(plan).ok).toBe(false);
  });

  it("rejeita timeout fora do limite (máx 30000)", () => {
    const plan = examplePlan();
    plan.actions[0].timeout_ms = 60000;
    expect(validatePlan(plan).ok).toBe(false);
  });

  it("rejeita plano com mais de 30 ações", () => {
    const plan = examplePlan();
    const template = plan.actions[0];
    plan.actions = Array.from({ length: 31 }, (_, i) => ({ ...template, id: `a${i + 1}` }));
    expect(validatePlan(plan).ok).toBe(false);
  });
});
