import { readFile, readdir } from "node:fs/promises";
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
  // Fast path: <dir>/<id>.json (backward-compatible; also serves path-style
  // ids like "contacts/list"). Fallback: search subfolders for a file whose
  // scenario_id field equals id, so scenarios can be organized in folders
  // while depends_on / --all keep resolving by scenario_id (the identity).
  let file = path.join(scenariosDir, `${id}.json`);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    const found = await findScenarioFileById(id, scenariosDir);
    if (!found) throw new WindupError(`scenario "${id}" not found in ${scenariosDir} — create one with: windup new "<instruction>"`);
    file = found;
    raw = await readFile(file, "utf8");
  }
  const scenario = JSON.parse(raw) as Scenario;
  if (!scenario.scenario_id || !scenario.task) {
    throw new WindupError(`scenario "${id}" is invalid: "scenario_id" and "task" are required`);
  }
  if (scenario.hints !== undefined && (!Array.isArray(scenario.hints) || scenario.hints.some((h) => typeof h !== "string"))) {
    throw new WindupError(`scenario "${id}" is invalid: "hints" must be a list of strings`);
  }
  for (const hook of ["setup", "teardown"] as const) {
    const v = (scenario as unknown as Record<string, unknown>)[hook];
    if (v !== undefined && typeof v !== "string" && !(Array.isArray(v) && v.every((c) => typeof c === "string"))) {
      throw new WindupError(`scenario "${id}" is invalid: "${hook}" must be a shell command string or a list of strings`);
    }
  }
  // Per-environment resolution: --base-url/WINDUP_BASE_URL > config.baseUrl >
  // the scenario's absolute URL. Environments change port/host; the test does not.
  if (scenario.depends_on !== undefined && (!Array.isArray(scenario.depends_on) || scenario.depends_on.some((d: unknown) => typeof d !== "string"))) {
    throw new WindupError(`scenario "${id}": "depends_on" must be a list of scenario ids`);
  }
  if (scenario.like !== undefined) {
    const like = scenario.like as { scenario?: unknown; set?: unknown };
    if (typeof like !== "object" || like === null || typeof like.scenario !== "string" || !like.scenario) {
      throw new WindupError(`scenario "${id}": "like" must be an object with a "scenario" id (the scenario to reuse the plan from)`);
    }
    if (like.set !== undefined && (typeof like.set !== "object" || like.set === null || Object.values(like.set).some((v) => typeof v !== "string"))) {
      throw new WindupError(`scenario "${id}": "like.set" must be a map of string → string (source value → value to use here)`);
    }
  }
  if (scenario.seed !== undefined) {
    const seed = scenario.seed as { localStorage?: unknown; sessionStorage?: unknown; origin?: unknown };
    const okMap = (v: unknown) => v === undefined || (typeof v === "object" && v !== null && Object.values(v).every((x) => typeof x === "string"));
    if (typeof seed !== "object" || seed === null || !okMap(seed.localStorage) || !okMap(seed.sessionStorage) || (seed.origin !== undefined && typeof seed.origin !== "string")) {
      throw new WindupError(`scenario "${id}": "seed" must be { localStorage?: {string→string}, sessionStorage?: {string→string}, origin?: string }`);
    }
  }
  const continueFromDependency = !scenario.start_url && (scenario.depends_on?.length ?? 0) > 0;
  scenario.start_url = resolveStartUrl(scenario.start_url);
  return Object.assign(scenario, { continue_from_dependency: continueFromDependency }) as ResolvedScenario;
}

/** Recursively list all scenario .json files under `dir` (sorted, stable order). */
export async function listScenarioFiles(dir: string = getContext().paths.scenariosDir): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!e.name.startsWith(".")) await walk(full);
      } else if (e.isFile() && e.name.endsWith(".json")) {
        out.push(full);
      }
    }
  }
  await walk(dir);
  return out.sort();
}

/** First scenario file (recursively) whose scenario_id field equals `id`. */
async function findScenarioFileById(id: string, dir: string): Promise<string | null> {
  for (const f of await listScenarioFiles(dir)) {
    try {
      if ((JSON.parse(await readFile(f, "utf8")) as Scenario).scenario_id === id) return f;
    } catch {
      // unreadable/invalid file — skip
    }
  }
  return null;
}

/**
 * All scenario ids for `run --all` / the vitest suite, discovered RECURSIVELY
 * (subfolders organize scenarios; scenario_id stays the identity). Duplicate
 * ids across files are reported and de-duplicated (first wins).
 */
export async function discoverScenarioIds(): Promise<string[]> {
  const dir = getContext().paths.scenariosDir;
  const byId = new Map<string, string>();
  for (const file of await listScenarioFiles(dir)) {
    let id: string | undefined;
    try {
      id = (JSON.parse(await readFile(file, "utf8")) as Scenario).scenario_id;
    } catch {
      continue;
    }
    if (!id) continue;
    if (byId.has(id)) {
      console.warn(`warning: duplicate scenario_id "${id}" in ${path.relative(dir, file)} and ${path.relative(dir, byId.get(id)!)} — using the first`);
      continue;
    }
    byId.set(id, file);
  }
  return [...byId.keys()].sort();
}

/** Map scenario_id → absolute path of its file (for change-impact selection). */
export async function scenarioFileById(): Promise<Map<string, string>> {
  const dir = getContext().paths.scenariosDir;
  const map = new Map<string, string>();
  for (const file of await listScenarioFiles(dir)) {
    try {
      const id = (JSON.parse(await readFile(file, "utf8")) as Scenario).scenario_id;
      if (id && !map.has(id)) map.set(id, path.resolve(file));
    } catch {
      // unreadable/invalid — skip
    }
  }
  return map;
}

/** Map scenario_id → module (the folder of its file relative to the scenarios dir; "(root)" for top-level). */
export async function scenarioModuleById(): Promise<Map<string, string>> {
  const dir = getContext().paths.scenariosDir;
  const map = new Map<string, string>();
  for (const file of await listScenarioFiles(dir)) {
    try {
      const id = (JSON.parse(await readFile(file, "utf8")) as Scenario).scenario_id;
      if (!id) continue;
      const rel = path.relative(dir, path.dirname(file));
      map.set(id, rel || "(root)");
    } catch {
      // unreadable/invalid — skip
    }
  }
  return map;
}
