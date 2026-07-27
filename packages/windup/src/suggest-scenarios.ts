import { computeCoverage } from "./coverage.js";
import { generateScenario, type AuthoringResult } from "./authoring.js";
import { createLlmClient, type LlmClient } from "./llm.js";

export interface SuggestResult {
  empty_map: boolean;
  dry_run: boolean;
  /** Total uncovered routes found. */
  uncovered: number;
  /** Routes we acted on (after --limit). */
  attempted: number;
  /** Paths we would/did author for (normalized from the route glob). */
  planned: string[];
  generated: AuthoringResult[];
  errors: Array<{ route: string; error: string }>;
}

/** A route glob (`**\/reports`, `**\/reports/**`) → the plain path to author for. */
function routePath(urlPattern: string): string {
  const p = urlPattern.replace(/^\*+/, "").replace(/\/\*+$/, "");
  return p.startsWith("/") ? p : `/${p}` || "/";
}

/**
 * Proposes (writes) a scenario for each UNCOVERED route in the site map, reusing
 * the `windup new` authoring machinery — one LLM call per route, each recorded
 * in the ledger as `kind: "authoring"`. The output is committed-for-review
 * scenario files, not something the engine runs. Sequential so generated ids
 * stay unique (each writes before the next reads).
 */
export async function suggestScenarios(
  opts: { limit?: number; force?: boolean; dryRun?: boolean; client?: LlmClient } = {},
): Promise<SuggestResult> {
  const report = await computeCoverage();
  if (report.empty_map) {
    return { empty_map: true, dry_run: Boolean(opts.dryRun), uncovered: 0, attempted: 0, planned: [], generated: [], errors: [] };
  }
  const uncovered = report.routes.filter((r) => r.scenarios.length === 0);
  const routes = opts.limit && opts.limit > 0 ? uncovered.slice(0, opts.limit) : uncovered;
  const planned = routes.map((r) => routePath(r.url_pattern));

  if (opts.dryRun) {
    return { empty_map: false, dry_run: true, uncovered: uncovered.length, attempted: routes.length, planned, generated: [], errors: [] };
  }

  const client = opts.client ?? createLlmClient();
  const generated: AuthoringResult[] = [];
  const errors: Array<{ route: string; error: string }> = [];
  for (const path of planned) {
    const instruction = `Write an end-to-end test scenario that exercises the route \`${path}\`. Navigate there, perform the page's primary action, and end by verifying a concrete, persistent result on the page.`;
    try {
      // Sequential (not parallel): each call writes its file before the next reads,
      // so the id-uniqueness suffix sees siblings from earlier in this batch.
      generated.push(await generateScenario(instruction, { force: opts.force }, client));
    } catch (err) {
      errors.push({ route: path, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { empty_map: false, dry_run: false, uncovered: uncovered.length, attempted: routes.length, planned, generated, errors };
}

export function printSuggest(r: SuggestResult): void {
  if (r.empty_map) {
    console.log("site map is empty — run `windup scan` first so suggest-scenarios knows the app's routes.");
    return;
  }
  if (r.uncovered === 0) {
    console.log("every indexed route already has a scenario — nothing to suggest. ✓");
    return;
  }
  if (r.dry_run) {
    console.log(`${r.uncovered} uncovered route(s); --dry-run (nothing written), would author for:`);
    for (const p of r.planned) console.log(`  • ${p}`);
    return;
  }
  console.log(`${r.uncovered} uncovered route(s); generated ${r.generated.length}${r.attempted < r.uncovered ? ` (of ${r.attempted} attempted — raise --limit for more)` : ""}:`);
  let cost = 0;
  for (const g of r.generated) {
    console.log(`  ✎ ${g.file}  (${g.scenario.scenario_id}) — ${g.scenario.task}`);
    cost += g.est_cost_usd;
  }
  for (const e of r.errors) console.log(`  ✗ ${e.route}: ${e.error}`);
  console.log(`cost: $${cost.toFixed(4)} · these are drafts — review, edit and commit the files.`);
}
