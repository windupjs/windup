import { describe, expect, it } from "vitest";
import { instantiatePlan } from "../src/isomorph.js";
import type { Plan, Scenario } from "../src/types.js";

const source: Plan = {
  plan_version: "0.1", scenario_id: "contacts-create", task: "create contact QA Tester", start_url: "http://x/contacts/new",
  generated_by: { model: "gemini", at: "2026-01-01" },
  actions: [
    { id: "a1", type: "fill", target: { selector: "#name", description: "name" }, value: "QA Tester", timeout_ms: 5000 },
    { id: "a2", type: "fill", target: { selector: "#id", description: "national id" }, value: "11111111111", timeout_ms: 5000 },
    { id: "a3", type: "fill", target: { selector: "#pass", description: "password" }, value_ref: "ENV:PW", timeout_ms: 5000 },
    { id: "a4", type: "click", target: { selector: "#save", description: "save" }, expect: { selector: ".row" }, timeout_ms: 10000 },
  ],
};

const target = (over: Partial<Scenario> = {}): Scenario & { start_url: string } => ({
  scenario_id: "deals-create", task: "create deal Big Deal", start_url: "http://x/deals/new", ...over,
});

describe("instantiatePlan (#1 isomorphic reuse)", () => {
  it("rebinds identity + start_url and substitutes fill values by exact match", () => {
    const { plan, unmatched } = instantiatePlan(source, target(), { "QA Tester": "Big Deal", "11111111111": "22222222222" });
    expect(plan.scenario_id).toBe("deals-create");
    expect(plan.task).toBe("create deal Big Deal");
    expect(plan.start_url).toBe("http://x/deals/new");
    expect(plan.generated_by).toBeUndefined(); // reused, not generated
    expect(plan.actions[0].value).toBe("Big Deal");
    expect(plan.actions[1].value).toBe("22222222222");
    expect(unmatched).toEqual([]);
  });

  it("leaves selectors, value_ref and non-fill actions untouched", () => {
    const { plan } = instantiatePlan(source, target(), { "QA Tester": "Big Deal" });
    expect(plan.actions[0].target!.selector).toBe("#name"); // structure is isomorphic
    expect(plan.actions[2].value_ref).toBe("ENV:PW"); // secrets stay refs
    expect(plan.actions[2].value).toBeUndefined();
    expect(plan.actions[3]).toEqual(source.actions[3]); // click unchanged
    expect(plan.actions[1].value).toBe("11111111111"); // not in set → kept
  });

  it("reports set keys that matched no fill value (misconfiguration)", () => {
    const { unmatched } = instantiatePlan(source, target(), { "Nonexistent": "x", "QA Tester": "Big Deal" });
    expect(unmatched).toEqual(["Nonexistent"]);
  });

  it("does not mutate the source plan", () => {
    instantiatePlan(source, target(), { "QA Tester": "Big Deal" });
    expect(source.actions[0].value).toBe("QA Tester");
    expect(source.scenario_id).toBe("contacts-create");
  });
});
