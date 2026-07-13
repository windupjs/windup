import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getContext } from "./context.js";
import { getCached } from "./cache.js";
import { loadScenario } from "./scenario.js";
import type { Action, Fragment, Plan } from "./types.js";

/** Fragments directory (sibling of the scenarios; committed — curated knowledge). */
export function fragmentsDir(): string {
  return path.resolve(getContext().paths.scenariosDir, "..", "fragments");
}

export async function loadFragments(): Promise<Fragment[]> {
  let files: string[];
  try {
    files = await readdir(fragmentsDir());
  } catch {
    return [];
  }
  const fragments: Fragment[] = [];
  for (const file of files.filter((f) => f.endsWith(".json"))) {
    try {
      const fragment = JSON.parse(await readFile(path.join(fragmentsDir(), file), "utf8")) as Fragment;
      if (fragment.fragment_id && fragment.description && Array.isArray(fragment.actions)) {
        fragments.push(fragment);
      }
    } catch {
      console.warn(`warning: skipping unreadable fragment: ${file}`);
    }
  }
  return fragments;
}

/**
 * Expands { type: "use" } actions inline (depth 1 — a fragment does not use
 * a fragment) and renumbers the ids. An unknown fragment is a plan error.
 */
export function expandPlan(plan: Plan, fragments: Fragment[]): Plan {
  const byId = new Map(fragments.map((f) => [f.fragment_id, f]));
  const actions: Action[] = [];
  for (const action of plan.actions) {
    if (action.type !== "use") {
      actions.push({ ...action });
      continue;
    }
    const fragment = byId.get(action.use ?? "");
    if (!fragment) {
      throw new Error(`plan references unknown fragment: "${action.use}"`);
    }
    for (const fragAction of fragment.actions) {
      if (fragAction.type === "use") {
        throw new Error(`fragment "${fragment.fragment_id}" nests another fragment — maximum depth is 1`);
      }
      actions.push({ ...fragAction });
    }
  }
  actions.forEach((a, i) => (a.id = `a${i + 1}`));
  return { ...plan, actions };
}

/**
 * `windup fragment extract <scenario> <a-start>..<a-end>`: promotes a slice
 * of a CACHED plan (executed and verified) to a fragment.
 */
export async function extractFragment(
  scenarioId: string,
  range: string,
  opts: { id: string; description: string },
): Promise<string> {
  const match = range.match(/^(a\d+)\.\.(a\d+)$/);
  if (!match) throw new Error(`invalid range "${range}" — use the form a1..a3`);
  const scenario = await loadScenario(scenarioId);
  const cached = await getCached(scenario);
  if (!cached) throw new Error(`scenario "${scenarioId}" has no cached plan (run it successfully first)`);

  const ids = cached.plan.actions.map((a) => a.id);
  const start = ids.indexOf(match[1]);
  const end = ids.indexOf(match[2]);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`range ${range} does not exist in the cached plan (actions: ${ids.join(", ")})`);
  }

  const actions = cached.plan.actions.slice(start, end + 1).map((a) => ({ ...a }));
  const params: Record<string, string> = {};
  for (const action of actions) {
    if (action.value_ref) params[action.target?.description ?? action.id] = action.value_ref;
  }
  const fragment: Fragment = {
    fragment_id: opts.id,
    description: opts.description,
    ...(Object.keys(params).length ? { params } : {}),
    actions,
    postcondition: actions[actions.length - 1].expect,
  };

  await mkdir(fragmentsDir(), { recursive: true });
  const file = path.join(fragmentsDir(), `${opts.id}.json`);
  await writeFile(file, `${JSON.stringify(fragment, null, 2)}\n`);
  return file;
}

/** Catalog for the prompt: id + description + postcondition — NEVER the actions (SPEC-001). */
export function formatCatalog(fragments: Fragment[]): string {
  return fragments
    .map((f) => {
      const post = f.postcondition ? ` (postcondition: ${JSON.stringify(f.postcondition)})` : "";
      return `- ${f.fragment_id}: "${f.description}"${post}`;
    })
    .join("\n");
}
