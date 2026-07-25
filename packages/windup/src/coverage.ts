import picomatch from "picomatch";
import { getCached } from "./cache.js";
import { getContext } from "./context.js";
import { discoverScenarioIds, loadScenario } from "./scenario.js";
import { SiteMapStore } from "./sitemap.js";
import type { Plan } from "./types.js";

export interface RouteCoverage {
  url_pattern: string;
  source: string;
  /** scenario_ids whose start_url (or cached plan) visits a URL under this route. */
  scenarios: string[];
}

export interface CoverageReport {
  routes: RouteCoverage[];
  covered: number;
  total: number;
  rate: number;
  scenarios_total: number;
  /** true = the site map has no routes yet (run `windup scan` first). */
  empty_map: boolean;
}

/** Pathnames a scenario visits: its start_url + any URL in its cached plan. */
function scenarioPathsOf(startUrl: string, plan?: Plan): string[] {
  const raw = [startUrl, ...(plan ? [plan.start_url, ...plan.actions.map((a) => a.url)] : [])].filter((u): u is string => !!u);
  const paths = new Set<string>();
  for (const u of raw) {
    try {
      paths.add(new URL(u, "http://x").pathname);
    } catch {
      paths.add(u.startsWith("/") ? u : `/${u}`);
    }
  }
  return [...paths];
}

/**
 * Cross-references the indexed routes (site map) with the scenarios: which
 * routes have at least one scenario, and which have none. Uses data Windup
 * already has — no LLM, no network. `windup scan` must have run so the map
 * knows the app's routes; each scenario's start_url (and cached plan URLs) is
 * matched against every route's url_pattern glob.
 */
export async function computeCoverage(): Promise<CoverageReport> {
  const map = await SiteMapStore.load(getContext().paths.mapFile);
  const routes = map.allRoutes();
  const ids = await discoverScenarioIds();

  const scenarioPaths = new Map<string, string[]>();
  for (const id of ids) {
    try {
      const s = await loadScenario(id);
      const cached = await getCached(s);
      scenarioPaths.set(id, scenarioPathsOf(s.start_url, cached?.plan));
    } catch {
      scenarioPaths.set(id, []);
    }
  }

  const cov: RouteCoverage[] = routes.map((r) => {
    const isMatch = picomatch(r.url_pattern);
    const scenarios = ids.filter((id) => scenarioPaths.get(id)!.some((p) => isMatch(p) || isMatch(p.replace(/^\//, ""))));
    return { url_pattern: r.url_pattern, source: r.source, scenarios };
  });
  const covered = cov.filter((r) => r.scenarios.length > 0).length;
  return {
    routes: cov,
    covered,
    total: routes.length,
    rate: routes.length ? Number((covered / routes.length).toFixed(3)) : 0,
    scenarios_total: ids.length,
    empty_map: routes.length === 0,
  };
}

/** Human-readable coverage report for the terminal. */
export function printCoverage(report: CoverageReport): void {
  if (report.empty_map) {
    console.log("no indexed routes — run `windup scan` first so coverage knows the app's routes.");
    return;
  }
  const uncovered = report.routes.filter((r) => r.scenarios.length === 0);
  console.log(`coverage: ${report.covered}/${report.total} routes have a scenario (${Math.round(report.rate * 100)}%)  ·  ${report.scenarios_total} scenarios`);
  if (uncovered.length) {
    console.log(`\nuncovered routes (${uncovered.length}):`);
    for (const r of uncovered) console.log(`  ${r.url_pattern}  (${r.source})`);
  } else {
    console.log("every indexed route has at least one scenario. ✓");
  }
}
