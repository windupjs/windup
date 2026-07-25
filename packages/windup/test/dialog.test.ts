import { describe, expect, it } from "vitest";
import { validatePlan } from "../src/schema.js";
import { normalizeActions } from "../src/planner.js";
import type { Plan } from "../src/types.js";

const plan = (dialog: unknown): Plan => ({
  plan_version: "0.1", scenario_id: "arch", start_url: "https://app.test",
  actions: [{ id: "a1", type: "click", target: { selector: "#archive", description: "archive" }, dialog, expect: { selector: "#done" }, timeout_ms: 5000 } as never],
});

describe("native dialog action field (#12)", () => {
  it("validates a click with dialog accept/dismiss", () => {
    expect(validatePlan(plan("accept")).ok).toBe(true);
    expect(validatePlan(plan("dismiss")).ok).toBe(true);
  });
  it("rejects an invalid dialog value", () => {
    expect(validatePlan(plan("maybe")).ok).toBe(false);
  });
  it("normalizeActions preserves dialog on a click (not stripped as a phantom field)", () => {
    const out = normalizeActions(plan("accept")) as Plan;
    expect(out.actions[0].dialog).toBe("accept");
  });
});
