import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import picomatch from "picomatch";
import { getCached } from "./cache.js";
import { getContext } from "./context.js";
import { loadScenario, scenarioFileById } from "./scenario.js";
import { SiteMapStore } from "./sitemap.js";
import type { Plan } from "./types.js";

const exec = promisify(execFile);

export interface ChangedSelection {
  /** Scenario ids to actually run. */
  run: string[];
  /** Ids proven unaffected by the change (safe to skip). */
  skipped: string[];
  /** Changed files (relative), for the log line. */
  files: string[];
  /** Human-readable note: full vs partial, and why. */
  reason: string;
}

/** `git diff --name-only <ref>` → relative paths, or null if git is unavailable / not a repo. */
async function gitDiff(root: string, ref: string): Promise<string[] | null> {
  try {
    const { stdout } = await exec("git", ["diff", "--name-only", ref], { cwd: root });
    return stdout.split("\n").filter(Boolean);
  } catch {
    return null;
  }
}

/** Pathnames a cached plan visits (start + any action url), for route matching. Exported for tests. */
export function planPaths(plan: Plan): string[] {
  const raw = [plan.start_url, ...plan.actions.map((a) => a.url)].filter((u): u is string => !!u);
  const paths = new Set<string>();
  for (const u of raw) {
    try {
      paths.add(new URL(u, "http://x").pathname);
    } catch {
      // not a URL — treat as a bare path
      paths.add(u.startsWith("/") ? u : `/${u}`);
    }
  }
  return [...paths];
}

/** Does any of the plan's paths fall under one of the affected route patterns? Exported for tests. */
export function touchesAffected(plan: Plan, patterns: Set<string>): boolean {
  if (patterns.size === 0) return false;
  const isMatch = picomatch([...patterns]);
  return planPaths(plan).some((p) => isMatch(p) || isMatch(p.replace(/^\//, "")));
}

/**
 * Pick the subset of `allIds` affected by the changes since `ref`.
 *
 * Sound-but-coarse by design (Windup's map is a route index, not a full
 * dependency graph). A scenario is SKIPPED only when we can prove it safe:
 *   - the diff is fully "understood" (every changed file is an indexed route
 *     file or a scenario file), AND
 *   - the scenario's file didn't change, AND
 *   - it has an active cached plan, AND
 *   - that plan touches no route whose source changed.
 * Anything we can't prove safe runs. When impact can't be computed at all
 * (no git, no site map with source info, or the diff touches files the map
 * can't attribute to a route) we run EVERYTHING and say why — never a silent
 * false green.
 */
export async function selectAffected(allIds: string[], ref: string): Promise<ChangedSelection> {
  const root = getContext().paths.root;
  const files = await gitDiff(root, ref);
  if (files === null) {
    return { run: allIds, skipped: [], files: [], reason: `git unavailable (or not a repo) — running all ${allIds.length}` };
  }
  if (files.length === 0) {
    return { run: [], skipped: allIds, files, reason: `no changes since ${ref} — nothing to run` };
  }

  const fileById = await scenarioFileById();
  const changedAbs = new Set(files.map((f) => path.resolve(root, f)));
  const changedScenarioIds = new Set(allIds.filter((id) => { const f = fileById.get(id); return f !== undefined && changedAbs.has(f); }));

  const map = await SiteMapStore.load(getContext().paths.mapFile);
  const indexed = map.indexedSourceFiles();
  if (indexed.size === 0) {
    return { run: allIds, skipped: [], files, reason: `no site map with source info — cannot compute code→scenario impact; running all ${allIds.length} (run \`windup scan\` for precise selection)` };
  }

  // Is the diff fully understood? Every changed file must be an indexed route
  // file or a scenario file; otherwise a shared/util change could affect any
  // scenario and we must not skip.
  const scenarioFiles = new Set(fileById.values());
  const unaccounted = files.map((f) => path.resolve(root, f)).filter((abs) => !indexed.has(abs) && !scenarioFiles.has(abs));
  if (unaccounted.length > 0) {
    return { run: allIds, skipped: [], files, reason: `${unaccounted.length} changed file(s) not attributed to any indexed route — running all ${allIds.length} to stay safe (narrow with --since, or re-scan)` };
  }

  const affected = map.affectedPatternsByFiles([...changedAbs]);
  const run: string[] = [];
  const skipped: string[] = [];
  for (const id of allIds) {
    if (changedScenarioIds.has(id)) { run.push(id); continue; }
    let keep = true;
    try {
      const scenario = await loadScenario(id);
      const cached = await getCached(scenario);
      keep = !cached || touchesAffected(cached.plan, affected);
    } catch {
      keep = true; // can't inspect it → run it
    }
    (keep ? run : skipped).push(id);
  }
  return {
    run,
    skipped,
    files,
    reason: `running ${run.length}/${allIds.length} affected by changes since ${ref} (${skipped.length} unaffected: routes unchanged, plans cached)`,
  };
}
