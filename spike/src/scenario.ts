import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Scenario } from "./types.js";

export const SCENARIOS_DIR = path.resolve(import.meta.dirname, "..", "scenarios");

export async function loadScenario(id: string): Promise<Scenario> {
  const file = path.join(SCENARIOS_DIR, `${id}.json`);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    throw new Error(`Cenário "${id}" não encontrado em ${file}`);
  }
  const scenario = JSON.parse(raw) as Scenario;
  if (!scenario.scenario_id || !scenario.start_url || !scenario.task) {
    throw new Error(`Cenário "${id}" inválido: exige scenario_id, start_url e task`);
  }
  return scenario;
}
