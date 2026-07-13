import { readFile } from "node:fs/promises";
import { saveCached } from "../src/cache.js";
import { loadScenario } from "../src/scenario.js";
const runFile = process.argv[2];
const m = JSON.parse(await readFile(runFile, "utf8"));
const scenario = await loadScenario(m.scenario_id);
await saveCached(scenario, m.plan);
console.log("cache seeded with the plan from", runFile);
