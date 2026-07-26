import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { getContext } from "./context.js";
import type { RunMetrics } from "./types.js";

/**
 * Reads every real run record from `.windup/runs/` (excludes bench-, scan and
 * authoring entries), oldest-first by `started_at`. The shared source for
 * `windup why` / `diff` / `badge` — none of which should re-implement the
 * readdir/parse/skip dance in costs.ts.
 */
export async function readRuns(): Promise<RunMetrics[]> {
  const runsDir = getContext().paths.runsDir;
  let files: string[] = [];
  try {
    files = (await readdir(runsDir)).filter((f) => f.endsWith(".json") && !f.startsWith("bench-"));
  } catch {
    return []; // no runs yet
  }
  const runs: RunMetrics[] = [];
  for (const file of files) {
    try {
      const m = JSON.parse(await readFile(path.join(runsDir, file), "utf8")) as RunMetrics & { kind?: string };
      if (!m.started_at || !m.scenario_id) continue;
      if (m.kind === "scan" || m.kind === "authoring") continue;
      runs.push(m);
    } catch {
      // unreadable record — skip
    }
  }
  runs.sort((a, b) => a.started_at.localeCompare(b.started_at));
  return runs;
}

/** All runs of one scenario, oldest-first. */
export async function runsForScenario(scenarioId: string): Promise<RunMetrics[]> {
  return (await readRuns()).filter((m) => m.scenario_id === scenarioId);
}

/** The latest run record per scenario_id (for suite-wide status: `badge`). */
export async function latestRunPerScenario(): Promise<Map<string, RunMetrics>> {
  const latest = new Map<string, RunMetrics>();
  for (const m of await readRuns()) latest.set(m.scenario_id, m); // sorted asc → last write wins
  return latest;
}
