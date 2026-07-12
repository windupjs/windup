import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getContext } from "./context.js";
import { getCached } from "./cache.js";
import { loadScenario } from "./scenario.js";
import type { Action, Fragment, Plan } from "./types.js";

/** Diretório dos fragmentos (irmão dos cenários; commitado — conhecimento curado). */
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
      console.warn(`[windup] aviso: fragmento ilegível ignorado: ${file}`);
    }
  }
  return fragments;
}

/**
 * Expande ações { type: "use" } inline (profundidade 1 — fragmento não usa
 * fragmento) e renumera os ids. Fragmento desconhecido é erro de plano.
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
      throw new Error(`plano referencia fragmento inexistente: "${action.use}"`);
    }
    for (const fragAction of fragment.actions) {
      if (fragAction.type === "use") {
        throw new Error(`fragmento "${fragment.fragment_id}" aninha outro fragmento — profundidade máxima é 1`);
      }
      actions.push({ ...fragAction });
    }
  }
  actions.forEach((a, i) => (a.id = `a${i + 1}`));
  return { ...plan, actions };
}

/**
 * `windup fragment extract <cenario> <a-inicio>..<a-fim>`: promove um trecho
 * de plano CACHEADO (executado e verificado) a fragmento.
 */
export async function extractFragment(
  scenarioId: string,
  range: string,
  opts: { id: string; description: string },
): Promise<string> {
  const match = range.match(/^(a\d+)\.\.(a\d+)$/);
  if (!match) throw new Error(`range inválido "${range}" — use o formato a1..a3`);
  const scenario = await loadScenario(scenarioId);
  const cached = await getCached(scenario);
  if (!cached) throw new Error(`cenário "${scenarioId}" não tem plano cacheado (rode-o com sucesso primeiro)`);

  const ids = cached.plan.actions.map((a) => a.id);
  const start = ids.indexOf(match[1]);
  const end = ids.indexOf(match[2]);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`range ${range} não existe no plano cacheado (ações: ${ids.join(", ")})`);
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

/** Catálogo para o prompt: id + descrição + pós-condição — NUNCA as ações (SPEC-001). */
export function formatCatalog(fragments: Fragment[]): string {
  return fragments
    .map((f) => {
      const post = f.postcondition ? ` (pós-condição: ${JSON.stringify(f.postcondition)})` : "";
      return `- ${f.fragment_id}: "${f.description}"${post}`;
    })
    .join("\n");
}
