import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CacheEntry, Plan, Scenario } from "./types.js";
import { getContext } from "./context.js";
import { startPath } from "./start-url.js";

/** Diretório do cache de trajetórias, resolvido pelo contexto ativo. */
export function cacheDir(): string {
  return getContext().paths.cacheDir;
}

const CACHE_VERSION = "0.2";
const PLAN_VERSION = "0.1";
const MAX_STALE_FILES = 3;

function entryPath(scenarioId: string): string {
  return path.join(cacheDir(), `${scenarioId}.json`);
}

/**
 * Hit = arquivo existe + status active + versões compatíveis + start_url igual.
 * Qualquer outra coisa é miss (doc 04).
 */
export async function getCached(scenario: Scenario): Promise<CacheEntry | null> {
  const entry = await readEntry(entryPath(scenario.scenario_id));
  if (!entry) return null;
  // Identidade do start_url é o PATH: porta/host mudam por ambiente e o
  // cache viaja junto (entradas antigas com URL absoluta continuam batendo).
  const compatible =
    entry.status === "active" &&
    entry.cache_version === CACHE_VERSION &&
    entry.plan?.plan_version === PLAN_VERSION &&
    entry.key?.scenario_id === scenario.scenario_id &&
    startPath(entry.key?.start_url ?? "/") === startPath(scenario.start_url ?? "/") &&
    // Task editada = teste diferente: o plano antigo não vale mais (miss,
    // não invalidação — o save do plano novo sobrescreve normalmente).
    (entry.plan.task === undefined || entry.plan.task === scenario.task);
  return compatible ? entry : null;
}

async function readEntry(file: string): Promise<CacheEntry | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as CacheEntry;
  } catch {
    return null;
  }
}

async function staleFiles(scenarioId: string): Promise<string[]> {
  let files: string[];
  try {
    files = await readdir(cacheDir());
  } catch {
    return [];
  }
  return files
    .filter((f) => f.startsWith(`${scenarioId}.stale-`) && f.endsWith(".json"))
    .sort() // timestamp ISO no nome: ordem lexicográfica = cronológica
    .map((f) => path.join(cacheDir(), f));
}

/** Stats da entrada anterior (ativa ou stale mais recente), para acumular entre re-planos (doc 07-A3). */
async function previousStats(scenarioId: string): Promise<CacheEntry["stats"] | null> {
  const active = await readEntry(entryPath(scenarioId));
  if (active) return active.stats;
  const stale = await staleFiles(scenarioId);
  if (stale.length === 0) return null;
  const latest = await readEntry(stale[stale.length - 1]);
  return latest?.stats ?? null;
}

/**
 * Escrita só após execução completa e verificada (responsabilidade do runner).
 * Contadores acumulam entre re-planos; plan_generation conta re-gerações —
 * insumo para detectar cenários instáveis.
 */
export async function saveCached(scenario: Scenario, plan: Plan, startSig?: string): Promise<void> {
  const prev = await previousStats(scenario.scenario_id);
  const entry: CacheEntry = {
    cache_version: CACHE_VERSION,
    key: {
      scenario_id: scenario.scenario_id,
      // identidade independente de ambiente
      start_url: startPath(scenario.start_url ?? "/"),
      ...(startSig ? { start_sig: startSig } : {}),
    },
    plan,
    status: "active",
    stats: {
      created_at: new Date().toISOString(),
      last_replayed_at: null,
      replay_count: prev?.replay_count ?? 0,
      replay_failures: prev?.replay_failures ?? 0,
      plan_generation: (prev?.plan_generation ?? 0) + 1,
    },
  };
  await mkdir(cacheDir(), { recursive: true });
  await writeFile(entryPath(scenario.scenario_id), JSON.stringify(entry, null, 2));
}

/** Registra um replay bem-sucedido (alimenta a evidência do critério C2). */
export async function recordReplay(entry: CacheEntry): Promise<void> {
  entry.stats.replay_count += 1;
  entry.stats.last_replayed_at = new Date().toISOString();
  await writeFile(entryPath(entry.key.scenario_id), JSON.stringify(entry, null, 2));
}

/**
 * Falha de verificação em replay: marca stale e RENOMEIA o arquivo para
 * <id>.stale-<timestamp>.json — o save do re-plano não pode sobrescrever a
 * evidência (doc 07-A3). Mantém no máximo os 3 stale mais recentes.
 */
export async function invalidate(entry: CacheEntry): Promise<void> {
  entry.status = "stale";
  entry.stats.replay_failures += 1;
  const scenarioId = entry.key.scenario_id;
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const staleFile = path.join(cacheDir(), `${scenarioId}.stale-${timestamp}.json`);
  await writeFile(entryPath(scenarioId), JSON.stringify(entry, null, 2));
  await rename(entryPath(scenarioId), staleFile);

  const stale = await staleFiles(scenarioId);
  for (const old of stale.slice(0, Math.max(0, stale.length - MAX_STALE_FILES))) {
    await rm(old, { force: true });
  }
}

/** Apaga o cache inteiro, incluindo entradas stale. */
export async function clearCache(): Promise<void> {
  await rm(cacheDir(), { recursive: true, force: true });
}
