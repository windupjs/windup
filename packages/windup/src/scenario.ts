import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Scenario } from "./types.js";
import { getContext } from "./context.js";

export async function loadScenario(id: string): Promise<Scenario> {
  const file = path.join(getContext().paths.scenariosDir, `${id}.json`);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    throw new Error(`Scenario "${id}" not found at ${file}`);
  }
  const scenario = JSON.parse(raw) as Scenario;
  if (!scenario.scenario_id || !scenario.start_url || !scenario.task) {
    throw new Error(`Scenario "${id}" is invalid: scenario_id, start_url and task are required`);
  }
  if (scenario.hints !== undefined && (!Array.isArray(scenario.hints) || scenario.hints.some((h) => typeof h !== "string"))) {
    throw new Error(`Scenario "${id}" is invalid: hints must be a list of strings`);
  }
  // start_url relativo ("/login") resolve contra a baseUrl da config.
  if (scenario.start_url.startsWith("/")) {
    const base = getContext().config.baseUrl;
    if (!base) {
      throw new Error(`Scenario "${id}": relative start_url ("${scenario.start_url}") requires baseUrl in windup.config`);
    }
    scenario.start_url = new URL(scenario.start_url, base).toString();
  }
  return scenario;
}
