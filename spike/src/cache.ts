import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CacheEntry, Plan, Scenario } from "./types.js";

export const CACHE_DIR = path.resolve(import.meta.dirname, "..", ".cache", "trajetorias");

const CACHE_VERSION = "0.1";
const PLAN_VERSION = "0.1";

function entryPath(scenarioId: string): string {
  return path.join(CACHE_DIR, `${scenarioId}.json`);
}

/**
 * Hit = arquivo existe + status active + versões compatíveis + start_url igual.
 * Qualquer outra coisa é miss (doc 04).
 */
export async function getCached(scenario: Scenario): Promise<CacheEntry | null> {
  let raw: string;
  try {
    raw = await readFile(entryPath(scenario.scenario_id), "utf8");
  } catch {
    return null;
  }
  let entry: CacheEntry;
  try {
    entry = JSON.parse(raw) as CacheEntry;
  } catch {
    return null;
  }
  const compatible =
    entry.status === "active" &&
    entry.cache_version === CACHE_VERSION &&
    entry.plan?.plan_version === PLAN_VERSION &&
    entry.key?.scenario_id === scenario.scenario_id &&
    entry.key?.start_url === scenario.start_url;
  return compatible ? entry : null;
}

/** Escrita só após execução completa e verificada (responsabilidade do runner). */
export async function saveCached(scenario: Scenario, plan: Plan): Promise<void> {
  const entry: CacheEntry = {
    cache_version: CACHE_VERSION,
    key: { scenario_id: scenario.scenario_id, start_url: scenario.start_url },
    plan,
    status: "active",
    stats: {
      created_at: new Date().toISOString(),
      last_replayed_at: null,
      replay_count: 0,
      replay_failures: 0,
    },
  };
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(entryPath(scenario.scenario_id), JSON.stringify(entry, null, 2));
}

/** Registra um replay bem-sucedido (alimenta a evidência do critério C2). */
export async function recordReplay(entry: CacheEntry): Promise<void> {
  entry.stats.replay_count += 1;
  entry.stats.last_replayed_at = new Date().toISOString();
  await writeFile(entryPath(entry.key.scenario_id), JSON.stringify(entry, null, 2));
}

/** Falha de verificação em replay: marca stale (arquivo mantido para diagnóstico). */
export async function invalidate(entry: CacheEntry): Promise<void> {
  entry.status = "stale";
  entry.stats.replay_failures += 1;
  await writeFile(entryPath(entry.key.scenario_id), JSON.stringify(entry, null, 2));
}

export async function clearCache(): Promise<void> {
  await rm(CACHE_DIR, { recursive: true, force: true });
}
