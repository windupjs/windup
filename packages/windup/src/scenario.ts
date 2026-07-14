import { readFile } from "node:fs/promises";
import { WindupError } from "./errors.js";
import path from "node:path";
import type { Scenario } from "./types.js";
import { getContext } from "./context.js";
import { resolveStartUrl } from "./start-url.js";

export type ResolvedScenario = Scenario & {
  start_url: string;
  /** true = no explicit start_url AND with depends_on: continues from the last dependency's final page (no initial goto). */
  continue_from_dependency?: boolean;
};

export async function loadScenario(id: string): Promise<ResolvedScenario> {
  const scenariosDir = getContext().paths.scenariosDir;
  const file = path.join(scenariosDir, `${id}.json`);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    throw new WindupError(`scenario "${id}" not found in ${scenariosDir} — create one with: windup new "<instruction>"`);
  }
  const scenario = JSON.parse(raw) as Scenario;
  if (!scenario.scenario_id || !scenario.task) {
    throw new WindupError(`scenario "${id}" is invalid: "scenario_id" and "task" are required`);
  }
  if (scenario.hints !== undefined && (!Array.isArray(scenario.hints) || scenario.hints.some((h) => typeof h !== "string"))) {
    throw new WindupError(`scenario "${id}" is invalid: "hints" must be a list of strings`);
  }
  // Per-environment resolution: --base-url/WINDUP_BASE_URL > config.baseUrl >
  // the scenario's absolute URL. Environments change port/host; the test does not.
  if (scenario.depends_on !== undefined && (!Array.isArray(scenario.depends_on) || scenario.depends_on.some((d: unknown) => typeof d !== "string"))) {
    throw new WindupError(`scenario "${id}": "depends_on" must be a list of scenario ids`);
  }
  const continueFromDependency = !scenario.start_url && (scenario.depends_on?.length ?? 0) > 0;
  scenario.start_url = resolveStartUrl(scenario.start_url);
  return Object.assign(scenario, { continue_from_dependency: continueFromDependency }) as ResolvedScenario;
}
