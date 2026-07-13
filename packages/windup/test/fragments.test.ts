import { describe, expect, it } from "vitest";
import { expandPlan, formatCatalog } from "../src/fragments.js";
import { validatePlan } from "../src/schema.js";
import type { Fragment, Plan } from "../src/types.js";

const loginFragment: Fragment = {
  fragment_id: "login-padrao",
  description: "Standard login",
  actions: [
    { id: "a1", type: "fill", target: { selector: "#user", description: "username" }, value: "u" },
    { id: "a2", type: "fill", target: { selector: "#pass", description: "password" }, value_ref: "ENV:SENHA" },
    { id: "a3", type: "click", target: { selector: "#entrar", description: "sign in" }, expect: { url: "**/home" } },
  ],
  postcondition: { url: "**/home" },
};

const composedPlan: Plan = {
  plan_version: "0.1",
  scenario_id: "composto",
  start_url: "https://x.com",
  actions: [
    { id: "a1", type: "use", use: "login-padrao" },
    { id: "a2", type: "click", target: { selector: "#perfil", description: "profile" }, expect: { selector: ".dados" } },
  ],
};

describe("expandPlan (E3)", () => {
  it("expands use inline and renumbers the ids", () => {
    const expanded = expandPlan(composedPlan, [loginFragment]);
    expect(expanded.actions.map((a) => a.id)).toEqual(["a1", "a2", "a3", "a4"]);
    expect(expanded.actions[0].target?.selector).toBe("#user");
    expect(expanded.actions[3].target?.selector).toBe("#perfil");
  });

  it("does not mutate the original plan (the cache keeps the reference)", () => {
    expandPlan(composedPlan, [loginFragment]);
    expect(composedPlan.actions).toHaveLength(2);
    expect(composedPlan.actions[0].type).toBe("use");
  });

  it("unknown fragment is an error", () => {
    expect(() => expandPlan(composedPlan, [])).toThrow(/unknown fragment/);
  });

  it("fragment nesting a fragment is an error (depth 1)", () => {
    const nested: Fragment = { ...loginFragment, actions: [{ id: "a1", type: "use", use: "outro" }] };
    expect(() => expandPlan(composedPlan, [nested])).toThrow(/depth/);
  });
});

describe("validatePlan with use (E3)", () => {
  it("accepts a plan with a use action and no expect on the last action when it is a use", () => {
    const plan: Plan = {
      ...composedPlan,
      actions: [
        { id: "a1", type: "click", target: { selector: "#x", description: "x" } },
        { id: "a2", type: "use", use: "login-padrao" },
      ],
    };
    expect(validatePlan(plan).ok).toBe(true);
  });

  it("rejects use without the use field", () => {
    const plan: Plan = { ...composedPlan, actions: [{ id: "a1", type: "use" }] };
    const result = validatePlan(plan);
    expect(result.ok).toBe(false);
    expect(result.errors.join()).toContain("requires the use field");
  });
});

describe("formatCatalog", () => {
  it("exposes id, description and postcondition — never the actions", () => {
    const catalog = formatCatalog([loginFragment]);
    expect(catalog).toContain("login-padrao");
    expect(catalog).toContain("Standard login");
    expect(catalog).toContain("**/home");
    expect(catalog).not.toContain("#user");
  });
});
