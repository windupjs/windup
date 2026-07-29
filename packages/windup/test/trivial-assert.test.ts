import { describe, expect, it } from "vitest";
import { bareSelectorAssertion, trivialExpect, validatePlan } from "../src/schema.js";
import type { Plan } from "../src/types.js";

const planWith = (finalExpect: unknown): Plan => ({
  plan_version: "0.1",
  scenario_id: "home",
  start_url: "https://app.test/",
  actions: [
    { id: "a1", type: "wait_for", target: { selector: "#x", description: "x" }, expect: finalExpect, timeout_ms: 5000 },
  ],
} as never);

describe("trivialExpect — a postcondition that cannot fail (#1)", () => {
  it("flags bare visibility of a landmark", () => {
    for (const sel of ["body", "html", ":root", "main", "div", "#root", "#app", "section", "BODY", " body "]) {
      expect(trivialExpect({ selector: sel } as never), sel).toBe(true);
    }
  });
  it("does not flag a real content selector", () => {
    for (const sel of ["#order-confirmation", ".product-card", "[data-testid=total]", "h2.price"]) {
      expect(trivialExpect({ selector: sel } as never), sel).toBe(false);
    }
  });
  it("any content/value/count/attribute/url assertion discriminates — even on a landmark selector", () => {
    expect(trivialExpect({ text_contains: { selector: "main", text: "Estacionamentos Populares" } } as never)).toBe(false);
    expect(trivialExpect({ count: { selector: ".row", equals: 3 } } as never)).toBe(false);
    expect(trivialExpect({ attribute: { selector: "#e", name: "aria-invalid", value: "false" } } as never)).toBe(false);
    expect(trivialExpect({ selector_value: { selector: "#q", value: "abc" } } as never)).toBe(false);
    expect(trivialExpect({ url: "**/dashboard" } as never)).toBe(false);
  });
  it("flags not_visible on a landmark but not on real content", () => {
    expect(trivialExpect({ not_visible: "body" } as never)).toBe(true);
    expect(trivialExpect({ not_visible: "#error-banner" } as never)).toBe(false);
  });
  it("treats a missing expect as trivial", () => {
    expect(trivialExpect(undefined)).toBe(true);
  });
});

describe("bareSelectorAssertion — what the live match-count check applies to", () => {
  it("returns the selector for a bare visibility assertion (the h2 hole)", () => {
    expect(bareSelectorAssertion({ selector: "h2" } as never)).toBe("h2");
    expect(bareSelectorAssertion({ selector: "li" } as never)).toBe("li");
    expect(bareSelectorAssertion({ selector: "#unique" } as never)).toBe("#unique"); // counted too — the page decides
  });
  it("returns null when a real assertion rides along (the text is what's checked)", () => {
    expect(bareSelectorAssertion({ selector: "h2", text_contains: { selector: "h2", text: "X" } } as never)).toBeNull();
    expect(bareSelectorAssertion({ selector: "h2", count: { selector: ".r", equals: 2 } } as never)).toBeNull();
    expect(bareSelectorAssertion({ selector: "h2", url: "**/x" } as never)).toBeNull();
  });
  it("returns null when there is no selector at all", () => {
    expect(bareSelectorAssertion(undefined)).toBeNull();
    expect(bareSelectorAssertion({ url: "**/x" } as never)).toBeNull();
  });
});

describe("validatePlan rejects the vacuous plan (so the planner re-plans)", () => {
  it("rejects the exact plan reported in the field: final expect = body", () => {
    const v = validatePlan(planWith({ selector: "body" }));
    expect(v.ok).toBe(false);
    expect(v.errors.join(" ")).toMatch(/trivial/);
    expect(v.errors.join(" ")).toMatch(/text_contains/); // tells the model what to do instead
  });
  it("rejects a landmark 'main' too (what the pro model produced)", () => {
    expect(validatePlan(planWith({ selector: "main" })).ok).toBe(false);
  });
  it("accepts the same plan once it asserts the task's text", () => {
    const v = validatePlan(planWith({ text_contains: { selector: "main", text: "Estacionamentos Populares" } }));
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
  });
  it("accepts a specific selector", () => {
    expect(validatePlan(planWith({ selector: "#product-grid" })).ok).toBe(true);
  });
});
