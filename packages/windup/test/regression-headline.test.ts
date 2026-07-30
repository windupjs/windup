import { describe, expect, it } from "vitest";
import { regressionWithReplanNote } from "../src/runner.js";
import type { RunMetrics } from "../src/types.js";

type Failure = NonNullable<RunMetrics["failure"]>;

const regression: Failure = {
  kind: "verification",
  action_id: "a3",
  message: 'postcondition failed: text_contains: body expected to contain "Estacionamentos Populares", got "QUEBRADO"',
};

describe("a caught regression outranks the self-heal that follows it (#edge2)", () => {
  it("keeps the postcondition failure as the headline when the re-plan truncates", () => {
    const replan: Failure = { kind: "plan_invalid", action_id: null, message: "degenerate/truncated response at the token limit — transient API failure" };
    const out = regressionWithReplanNote(regression, replan);
    // The developer must read the REGRESSION first: kind, action and expected/actual survive.
    expect(out.kind).toBe("verification");
    expect(out.action_id).toBe("a3");
    expect(out.message).toMatch(/^postcondition failed: .*Estacionamentos Populares/);
    // …and the planner's own trouble is demoted to a note, not lost.
    expect(out.message).toMatch(/note: the plan was invalidated and re-planned/);
    expect(out.message).toMatch(/truncated response/);
  });

  it("does the same when the re-plan fails on config (bad model / missing key)", () => {
    const replan: Failure = { kind: "config", action_id: null, message: 'the model "nope" does not exist for provider "google"' };
    const out = regressionWithReplanNote(regression, replan);
    expect(out.kind).toBe("verification"); // NOT config — the app broke, that's the finding
    expect(out.message).toMatch(/does not exist for provider/); // still reported, as a note
  });

  it("adds no note when the re-plan left no separate failure", () => {
    expect(regressionWithReplanNote(regression, null)).toEqual(regression);
    expect(regressionWithReplanNote(regression, regression)).toEqual(regression); // same object → nothing new to say
  });
});
