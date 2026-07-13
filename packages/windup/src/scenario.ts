import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Scenario } from "./types.js";
import { getContext } from "./context.js";
import { resolveStartUrl } from "./start-url.js";

export type ResolvedScenario = Scenario & { start_url: string };

export async function loadScenario(id: string): Promise<ResolvedScenario> {
  const file = path.join(getContext().paths.scenariosDir, `${id}.json`);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    throw new Error(`Scenario "${id}" not found at ${file}`);
  }
  const scenario = JSON.parse(raw) as Scenario;
  if (!scenario.scenario_id || !scenario.task) {
    throw new Error(`Scenario "${id}" is invalid: scenario_id and task are required`);
  }
  if (scenario.hints !== undefined && (!Array.isArray(scenario.hints) || scenario.hints.some((h) => typeof h !== "string"))) {
    throw new Error(`Scenario "${id}" is invalid: hints must be a list of strings`);
  }
  // Resolução por ambiente: --base-url/WINDUP_BASE_URL > config.baseUrl >
  // URL absoluta do cenário. Ambientes mudam de porta/host; o teste não.
  scenario.start_url = resolveStartUrl(scenario.start_url);
  return scenario as ResolvedScenario;
}
