import type { Plan, Scenario } from "./types.js";

export interface InstantiateResult {
  plan: Plan;
  /** `set` keys that matched no fill value in the source plan (author misconfiguration). */
  unmatched: string[];
}

/**
 * #1 — instantiate a source scenario's PROVEN plan for an isomorphic target:
 * same action structure and selectors, but this scenario's identity + start_url
 * and, optionally, different fill values. `set` maps a literal value present in
 * the source plan's fill actions → the value to use here (exact match, applied
 * to `value` fields only — never selectors or `value_ref`). Deterministic and
 * LLM-free; the caller still executes + verifies before trusting the result.
 */
export function instantiatePlan(
  source: Plan,
  target: Scenario & { start_url: string },
  set: Record<string, string> = {},
): InstantiateResult {
  const used = new Set<string>();
  const actions = source.actions.map((a) => {
    if (a.type === "fill" && a.value !== undefined && Object.prototype.hasOwnProperty.call(set, a.value)) {
      used.add(a.value);
      return { ...a, value: set[a.value] };
    }
    return { ...a };
  });
  const plan: Plan = {
    ...source,
    scenario_id: target.scenario_id,
    task: target.task,
    start_url: target.start_url,
    // It was reused, not generated — drop the source's provenance stamp.
    generated_by: undefined,
    actions,
  };
  const unmatched = Object.keys(set).filter((k) => !used.has(k));
  return { plan, unmatched };
}
