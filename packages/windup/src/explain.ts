import { getCached } from "./cache.js";
import { loadScenario } from "./scenario.js";
import { trivialExpect } from "./schema.js";
import type { Action } from "./types.js";

export interface Explanation {
  scenario_id: string;
  planned: boolean;
  task?: string;
  start_url?: string;
  steps: string[];
  /** Set when the cached plan's final postcondition proves nothing (asserts only a landmark) — a green run that is not evidence. */
  warning?: string;
}

/** One human-readable line per action — never a fill's VALUE (secrets/OTP stay out; a `value_ref` shows as its name). */
function describe(action: Action): string {
  const target = action.target?.description || action.target?.selector || "the element";
  switch (action.type) {
    case "goto":
      return `go to ${action.url ?? (action.url_ref ? `{${action.url_ref}} (resolved URL)` : "the start page")}`;
    case "click":
      return `click ${target}`;
    case "fill":
      return action.value_ref ? `fill ${target} with {${action.value_ref}} (resolved at run time)` : `fill ${target}`;
    case "wait_for":
      return `wait for ${target} to appear`;
    case "use":
      return `run the "${action.use}" fragment`;
    default:
      return `${action.type} ${target}`;
  }
}

function verifyLine(action: Action): string | null {
  const e = action.expect;
  if (!e) return null;
  const parts: string[] = [];
  if (e.url) parts.push(`the URL matches ${e.url}`);
  if (e.selector) parts.push(`${e.selector} is visible`);
  if (e.selector_value) parts.push(`${e.selector_value.selector} equals "${e.selector_value.value}"`);
  if (e.text_contains) parts.push(`${e.text_contains.selector} contains "${e.text_contains.text}"`);
  if (e.count) {
    const c = e.count;
    const how = c.equals !== undefined ? `exactly ${c.equals}` : [c.min !== undefined ? `at least ${c.min}` : "", c.max !== undefined ? `at most ${c.max}` : ""].filter(Boolean).join(" and ");
    parts.push(`${how} ${c.selector} match`);
  }
  if (e.not_visible) parts.push(`${e.not_visible} is gone`);
  if (e.attribute) parts.push(`${e.attribute.selector}'s ${e.attribute.name} equals "${e.attribute.value}"`);
  return parts.length ? `verify ${parts.join(" and ")}` : null;
}

/** The cached plan for a scenario, rendered as an ordered, readable step list — no LLM, no browser. */
export async function explainPlan(scenarioId: string): Promise<Explanation> {
  const scenario = await loadScenario(scenarioId);
  const cached = await getCached(scenario);
  if (!cached) {
    return { scenario_id: scenarioId, planned: false, task: scenario.task, start_url: scenario.start_url, steps: [] };
  }
  const steps: string[] = [];
  for (const action of cached.plan.actions) {
    steps.push(describe(action));
    const v = verifyLine(action);
    if (v) steps.push(`  ↳ ${v}`);
  }
  // Plans cached before this check existed can still hold a vacuous postcondition.
  // explain is where a careful user looks, so flag it here rather than let a green
  // run keep looking like evidence.
  const last = cached.plan.actions[cached.plan.actions.length - 1];
  const warning = last && last.type !== "use" && trivialExpect(last.expect)
    ? `this plan's final check only asserts "${last.expect?.selector ?? last.expect?.not_visible}" — a landmark present on every page, so the test passes even if the feature is broken. Sharpen the task (name the exact text to verify), then re-run: the plan will be rejected and re-planned.`
    : undefined;
  return { scenario_id: scenarioId, planned: true, task: cached.plan.task ?? scenario.task, start_url: scenario.start_url, steps, ...(warning ? { warning } : {}) };
}

export function printExplain(e: Explanation): void {
  console.log(`\n${e.scenario_id}${e.task ? ` — ${e.task}` : ""}`);
  if (!e.planned) {
    console.log("  (not planned yet — run it once so a plan is cached, then explain shows the steps)");
    return;
  }
  if (e.start_url) console.log(`  start: ${e.start_url}`);
  let n = 0;
  for (const step of e.steps) {
    if (step.startsWith("  ↳")) console.log(`     ${step.trim()}`);
    else console.log(`  ${++n}. ${step}`);
  }
  if (e.warning) console.log(`\n  ⚠ weak verification: ${e.warning}`);
}
