import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getContext } from "./context.js";

/**
 * A dependency's "exit state": the Playwright `storageState` (cookies +
 * localStorage) and the URL it ended on. Restoring it into a fresh context lets
 * a dependent scenario skip re-running the whole `depends_on` chain (e.g. the UI
 * login) — the biggest wall-clock cost of a cached replay (feedback #4).
 *
 * Stored under `.windup/state/` (gitignored). It contains AUTH COOKIES/TOKENS —
 * it is machine-local, environment-specific and MUST NEVER be committed.
 */
export interface SessionSnapshot {
  scenario_id: string;
  /** Playwright storageState object (cookies + origins/localStorage). Opaque here; passed straight to newContext. */
  storage_state: unknown;
  /** URL the scenario ended on — where a continuing dependent resumes. */
  url: string;
  saved_at: string;
}

function stateDir(): string {
  return getContext().paths.stateDir;
}

function snapshotPath(scenarioId: string): string {
  // scenario_id can contain "/" (path-style ids) — flatten so it's one file.
  return path.join(stateDir(), `${scenarioId.replace(/[/\\]/g, "__")}.json`);
}

export async function saveSnapshot(scenarioId: string, storageState: unknown, url: string): Promise<void> {
  const snapshot: SessionSnapshot = { scenario_id: scenarioId, storage_state: storageState, url, saved_at: new Date().toISOString() };
  await mkdir(stateDir(), { recursive: true });
  await writeFile(snapshotPath(scenarioId), JSON.stringify(snapshot));
}

export async function getSnapshot(scenarioId: string): Promise<SessionSnapshot | null> {
  try {
    return JSON.parse(await readFile(snapshotPath(scenarioId), "utf8")) as SessionSnapshot;
  } catch {
    return null;
  }
}

export async function dropSnapshot(scenarioId: string): Promise<void> {
  await rm(snapshotPath(scenarioId), { force: true });
}
