import { describe, expect, it } from "vitest";
import { validatePlan } from "../src/schema.js";
import type { Plan } from "../src/types.js";

/** Example plan from doc 02 (scenario 1). */
function examplePlan(): Plan {
  return {
    plan_version: "0.1",
    scenario_id: "saucedemo-login",
    start_url: "https://www.saucedemo.com",
    actions: [
      {
        id: "a1",
        type: "fill",
        target: { selector: "#user-name", description: "username field" },
        value: "standard_user",
        expect: { selector_value: { selector: "#user-name", value: "standard_user" } },
        timeout_ms: 5000,
      },
      {
        id: "a2",
        type: "fill",
        target: { selector: "#password", description: "password field" },
        value: "secret_sauce",
        timeout_ms: 5000,
      },
      {
        id: "a3",
        type: "click",
        target: { selector: "#login-button", description: "login button" },
        expect: { url: "**/inventory.html", selector: ".inventory_list" },
        timeout_ms: 10000,
      },
    ],
  };
}

describe("validatePlan", () => {
  it("accepts the example plan from doc 02", () => {
    const result = validatePlan(examplePlan());
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("rejects click without target.selector", () => {
    const plan = examplePlan();
    delete plan.actions[2].target;
    const result = validatePlan(plan);
    expect(result.ok).toBe(false);
    expect(result.errors.join()).toContain("target.selector");
  });

  it("rejects a plan whose last action has no expect", () => {
    const plan = examplePlan();
    delete plan.actions[2].expect;
    const result = validatePlan(plan);
    expect(result.ok).toBe(false);
    expect(result.errors.join()).toContain("final action");
  });

  it("rejects fill with both value AND value_ref", () => {
    const plan = examplePlan();
    plan.actions[1].value_ref = "ENV:SAUCE_PASSWORD";
    const result = validatePlan(plan);
    expect(result.ok).toBe(false);
    expect(result.errors.join()).toContain("exactly one");
  });

  it("rejects fill without value or value_ref", () => {
    const plan = examplePlan();
    delete plan.actions[1].value;
    const result = validatePlan(plan);
    expect(result.ok).toBe(false);
  });

  it("accepts fill with value_ref in the ENV:* format", () => {
    const plan = examplePlan();
    delete plan.actions[1].value;
    plan.actions[1].value_ref = "ENV:SAUCE_PASSWORD";
    expect(validatePlan(plan).ok).toBe(true);
  });

  it("rejects value_ref outside the ENV:* format", () => {
    const plan = examplePlan();
    delete plan.actions[1].value;
    plan.actions[1].value_ref = "env:sauce";
    expect(validatePlan(plan).ok).toBe(false);
  });

  it("rejects goto without url", () => {
    const plan = examplePlan();
    plan.actions.unshift({ id: "a0", type: "goto" });
    const result = validatePlan(plan);
    expect(result.ok).toBe(false);
    expect(result.errors.join()).toContain("goto");
  });

  it("rejects duplicate ids", () => {
    const plan = examplePlan();
    plan.actions[1].id = "a1";
    const result = validatePlan(plan);
    expect(result.ok).toBe(false);
    expect(result.errors.join()).toContain("duplicate");
  });

  it("rejects an unknown plan_version", () => {
    const plan = examplePlan() as unknown as Record<string, unknown>;
    plan.plan_version = "0.2";
    expect(validatePlan(plan).ok).toBe(false);
  });

  it("rejects a timeout outside the limit (max 30000)", () => {
    const plan = examplePlan();
    plan.actions[0].timeout_ms = 60000;
    expect(validatePlan(plan).ok).toBe(false);
  });

  it("rejects a plan with more than 30 actions", () => {
    const plan = examplePlan();
    const template = plan.actions[0];
    plan.actions = Array.from({ length: 31 }, (_, i) => ({ ...template, id: `a${i + 1}` }));
    expect(validatePlan(plan).ok).toBe(false);
  });
});
