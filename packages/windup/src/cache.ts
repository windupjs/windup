import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CacheEntry, Plan, Scenario } from "./types.js";
import { getContext } from "./context.js";
import { startPath } from "./start-url.js";

/** Trajectory cache directory, resolved from the active context. */
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
 * Hit = file exists + status active + compatible versions + same start_url.
 * Anything else is a miss (doc 04).
 */
export async function getCached(scenario: Scenario): Promise<CacheEntry | null> {
  const entry = await readEntry(entryPath(scenario.scenario_id));
  if (!entry) return null;
  // The start_url identity is the PATH: port/host change per environment and
  // the cache travels along (old entries with absolute URLs still match).
  const compatible =
    entry.status === "active" &&
    entry.cache_version === CACHE_VERSION &&
    entry.plan?.plan_version === PLAN_VERSION &&
    entry.key?.scenario_id === scenario.scenario_id &&
    startPath(entry.key?.start_url ?? "/") === startPath(scenario.start_url ?? "/") &&
    // An edited task = a different test: the old plan no longer applies (a
    // miss, not an invalidation — the new plan's save overwrites normally).
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
    .sort() // ISO timestamp in the name: lexicographic order = chronological
    .map((f) => path.join(cacheDir(), f));
}

/** Stats of the previous entry (active or most recent stale), to accumulate across re-plans (doc 07-A3). */
async function previousStats(scenarioId: string): Promise<CacheEntry["stats"] | null> {
  const active = await readEntry(entryPath(scenarioId));
  if (active) return active.stats;
  const stale = await staleFiles(scenarioId);
  if (stale.length === 0) return null;
  const latest = await readEntry(stale[stale.length - 1]);
  return latest?.stats ?? null;
}

/**
 * Written only after a complete, verified execution (the runner's job).
 * Counters accumulate across re-plans; plan_generation counts regenerations —
 * input for detecting unstable scenarios.
 */
export async function saveCached(scenario: Scenario, plan: Plan, startSig?: string): Promise<void> {
  const prev = await previousStats(scenario.scenario_id);
  const entry: CacheEntry = {
    cache_version: CACHE_VERSION,
    key: {
      scenario_id: scenario.scenario_id,
      // environment-independent identity
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

/** Records a successful replay (feeds the evidence for criterion C2). */
export async function recordReplay(entry: CacheEntry): Promise<void> {
  entry.stats.replay_count += 1;
  entry.stats.last_replayed_at = new Date().toISOString();
  await writeFile(entryPath(entry.key.scenario_id), JSON.stringify(entry, null, 2));
}

/**
 * Verification failure on replay: marks it stale and RENAMES the file to
 * <id>.stale-<timestamp>.json — the re-plan's save must not overwrite the
 * evidence (doc 07-A3). Keeps at most the 3 most recent stale files.
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

/** Deletes the entire cache, including stale entries. */
export async function clearCache(): Promise<void> {
  await rm(cacheDir(), { recursive: true, force: true });
}
