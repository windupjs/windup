import { describe, expect, it } from "vitest";
import { buildPlanFromEvents, type RecordEvent } from "../src/record.js";
import { normalizeActions, sanitizePlan } from "../src/planner.js";
import { validatePlan } from "../src/schema.js";
import type { Plan } from "../src/types.js";

const ctx = { scenarioId: "recorded", startUrl: "http://app.test/login", finalUrl: "http://app.test/dashboard" };
const finalize = (events: RecordEvent[]) => normalizeActions(sanitizePlan(buildPlanFromEvents(events, ctx))) as Plan;

describe("buildPlanFromEvents", () => {
  it("maps click/fill and turns the last assert into the final verification — a valid plan", () => {
    const events: RecordEvent[] = [
      { kind: "fill", selector: "#email", description: "email", value: "qa@x.test", url: ctx.startUrl },
      { kind: "fill", selector: "#password", description: "password", value_ref: "ENV:WINDUP_QA_PASSWORD", url: ctx.startUrl },
      { kind: "click", selector: "#login", description: "Sign in", url: ctx.startUrl },
      { kind: "assert", selector: "#welcome", description: "Welcome", text: "Welcome back", url: ctx.finalUrl },
    ];
    const plan = finalize(events);
    const v = validatePlan(plan);
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
    expect(plan.actions.map((a) => a.id)).toEqual(["a1", "a2", "a3", "a4"]); // renumbered
    expect(plan.actions[1].value_ref).toBe("ENV:WINDUP_QA_PASSWORD");
    expect(plan.actions[1].value).toBeUndefined(); // secret never a literal
    const last = plan.actions[plan.actions.length - 1];
    expect(last.expect?.text_contains).toEqual({ selector: "#welcome", text: "Welcome back" });
  });

  it("falls back to a URL verification when nothing is marked", () => {
    const events: RecordEvent[] = [
      { kind: "click", selector: "#buy", description: "Buy", url: ctx.startUrl },
    ];
    const plan = finalize(events);
    expect(validatePlan(plan).ok).toBe(true);
    expect(plan.actions[plan.actions.length - 1].expect?.url).toBe("/dashboard");
  });

  it("an assert without text asserts the selector is visible", () => {
    const events: RecordEvent[] = [
      { kind: "click", selector: "#go", description: "Go", url: ctx.startUrl },
      { kind: "assert", selector: "#grid", description: "the grid", url: ctx.finalUrl },
    ];
    const plan = finalize(events);
    expect(validatePlan(plan).ok).toBe(true);
    expect(plan.actions[plan.actions.length - 1].expect?.selector).toBe("#grid");
  });

  it("produces a valid plan even with no interactions (URL-only)", () => {
    const plan = finalize([]);
    expect(validatePlan(plan).ok).toBe(true);
    expect(plan.actions).toHaveLength(1);
  });
});
