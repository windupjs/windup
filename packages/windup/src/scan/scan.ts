import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { getContext } from "../context.js";
import { estimateCostUsd } from "../metrics.js";
import { SiteMapStore } from "../sitemap.js";
import { runAssist, selectCandidates, type AssistCaller } from "./assist.js";
import { extractElements, formatElement } from "./extract.js";
import { collectRouteSources, indexNextRoutes, type StaticRoute } from "./nextjs.js";
import { indexReactRouterRoutes, sourceFiles } from "./react-router.js";

const exec = promisify(execFile);

/**
 * `windup scan` (SPEC-002): static indexing of the project — routes by
 * framework convention + elements by lightweight parsing — feeding the SAME
 * site-map graph with `source: "static"`.
 *
 * `--update` (P3): incremental via git, not a watcher — re-indexes only
 * routes whose sources changed since the last scan (SHA recorded in the map)
 * and marks the affected execution knowledge stale.
 *
 * Explicit caps and zero LLM in this layer; the LLM-assist layer is P4.
 */
export interface ScanSummary {
  framework: string | null;
  routes: number;
  elements: number;
  mapFile: string;
  mode: "full" | "incremental";
  assist: { calls: number; max_calls: number; est_cost_usd: number } | null;
}

/** Storage cap per page node; the prompt slice shows at most 30 anyway. */
const MAX_ELEMENTS_PER_NODE = 150;

export async function runScan(opts: { update?: boolean; assist?: boolean; assistCaller?: AssistCaller } = {}): Promise<ScanSummary> {
  const ctx = getContext();
  const root = path.resolve(ctx.paths.root, ctx.config.scan?.root ?? ".");
  const framework = ctx.config.framework ?? (await detectFramework(root));

  const store = await SiteMapStore.load(ctx.paths.mapFile);
  let routesCount = 0;
  let elementsCount = 0;
  let mode: "full" | "incremental" = "full";
  let assistSummary: ScanSummary["assist"] = null;

  if (framework === "next" || framework === "react-router" || framework === "remix") {
    let routes = framework === "next" ? await indexNextRoutes(root) : await indexReactRouterRoutes(root);

    // Barrel/router anti-inheritance: a file shared by many routes (the
    // router file that imports every page) does NOT get its imports
    // expanded — otherwise each route inherits the whole app's elements.
    const fileRouteCount = new Map<string, number>();
    for (const route of routes) {
      for (const f of route.files) fileRouteCount.set(f, (fileRouteCount.get(f) ?? 0) + 1);
    }
    const sources = new Map<StaticRoute, string[]>();
    for (const route of routes) {
      const expandable = route.files.filter((f) => (fileRouteCount.get(f) ?? 0) <= 2);
      const expanded = expandable.length
        ? await collectRouteSources({ route: route.route, files: expandable }, root)
        : [];
      sources.set(route, [...new Set([...route.files, ...expanded])]);
    }

    if (opts.update && store.lastScanSha) {
      const changed = await gitChangedFiles(root, store.lastScanSha);
      if (changed !== null) {
        mode = "incremental";
        const changedAbs = new Set(changed.map((f) => path.resolve(root, f)));
        store.markStaleByFiles([...changedAbs]);
        routes = routes.filter((route) => (sources.get(route) ?? []).some((f) => changedAbs.has(path.resolve(f))));
      } else {
        console.log("scan --update: git unavailable — falling back to a full scan");
      }
    } else if (opts.update) {
      console.log("scan --update: no previous scan recorded — running a full scan");
    }

    let droppedByCap = 0;
    for (const route of routes) {
      const files = sources.get(route) ?? route.files;
      const lines: string[] = [];
      for (const file of files) {
        try {
          lines.push(...extractElements(await readFile(file, "utf8")).map(formatElement));
        } catch {
          // unreadable source never breaks a scan
        }
      }
      // Honest accounting: store and count deduped lines, capped per node.
      const unique = [...new Set(lines)];
      const capped = unique.slice(0, MAX_ELEMENTS_PER_NODE);
      droppedByCap += unique.length - capped.length;
      store.upsertStaticPage(route.route, capped, files);
      routesCount += 1;
      elementsCount += capped.length;
    }
    if (droppedByCap > 0) {
      console.log(`scan: ${droppedByCap} element(s) dropped by the ${MAX_ELEMENTS_PER_NODE}/page cap (prompt slices use at most 30/page anyway)`);
    }

    // A full scan reconciles: routes gone from the code leave the map (static);
    // llm nodes whose sources changed/vanished drop so the assist re-evaluates.
    if (mode === "full") {
      const current = new Set(routes.map((r) => `**${r.route}`));
      const pruned = store.pruneStaticExcept(current);
      let prunedLlm = 0;
      for (const node of store.llmPages()) {
        const file = node.files[0];
        // Duplicate of a better source, or empty: adds nothing — remove (migrates old maps).
        let gone = node.elements === 0 || store.coveredByBetterSource(node.url_pattern) || !file;
        if (!gone && file) {
          try {
            const hash = sha16(await readFile(file, "utf8"));
            if (!store.assistAlreadySeen(file, hash)) gone = true;
          } catch {
            gone = true;
          }
        }
        if (gone) {
          store.removePage(node.sig);
          if (file) store.forgetAssistSeen(file);
          prunedLlm += 1;
        }
      }
      if (pruned + prunedLlm > 0) console.log(`scan: pruned ${pruned} static and ${prunedLlm} AI-inferred page(s) no longer backed by the code`);
    }

    // Layer 3 (P4): LLM-assist for whatever the static layers could not resolve.
    const assistEnabled = opts.assist !== false && (ctx.config.scan?.llmAssist?.enabled ?? true);
    if (assistEnabled && mode === "full") {
      assistSummary = await runAssistLayer(root, routes, sources, store, opts.assistCaller);
    }

    store.lastScanSha = (await gitHead(root)) ?? store.lastScanSha;
  } else {
    console.log(
      `scan: no static indexer for ${framework ?? "this project"} yet (supported: Next.js, react-router, remix). Nothing was indexed — the site map will still be fed by executions.`,
    );
  }

  await store.save();
  return { framework, routes: routesCount, elements: elementsCount, mapFile: ctx.paths.mapFile, mode, assist: assistSummary };
}

/** Selects candidates, calls the LLM within the cap and records the cost in the ledger. */
async function runAssistLayer(
  root: string,
  routes: StaticRoute[],
  sources: Map<StaticRoute, string[]>,
  store: SiteMapStore,
  caller?: AssistCaller,
): Promise<ScanSummary["assist"]> {
  const ctx = getContext();
  const maxCalls = ctx.config.scan?.llmAssist?.maxCalls ?? 20;

  const coveredFiles = new Set<string>();
  for (const route of routes) for (const f of sources.get(route) ?? route.files) coveredFiles.add(path.resolve(f));
  // A shared declaring file (router) is never a candidate: the AI would read
  // the router and return routes the static layer already has (useless duplication).
  const sharedDeclaring = new Set<string>();
  const declCount = new Map<string, number>();
  for (const route of routes) for (const f of route.files) declCount.set(path.resolve(f), (declCount.get(path.resolve(f)) ?? 0) + 1);
  for (const [f, n] of declCount) if (n > 2) sharedDeclaring.add(f);

  const nodesWithoutElements = new Set<string>();
  // (routes whose node ended up with no elements: the sources deserve a second read via LLM)
  for (const route of routes) {
    const files = sources.get(route) ?? route.files;
    let any = false;
    for (const f of files) {
      try {
        if (extractElements(await readFile(f, "utf8")).length > 0) { any = true; break; }
      } catch { /* ignore */ }
    }
    if (!any) {
      for (const f of files) {
        const abs = path.resolve(f);
        if (!sharedDeclaring.has(abs)) nodesWithoutElements.add(abs);
      }
    }
  }

  const files: Array<{ file: string; content: string }> = [];
  for (const file of await sourceFiles(root)) {
    try {
      files.push({ file: path.resolve(file), content: await readFile(file, "utf8") });
    } catch { /* ignore */ }
  }

  const allCandidates = selectCandidates(files, coveredFiles, nodesWithoutElements);
  // Assist memory: content already analyzed (same hash) is never paid for again.
  const hashes = new Map<string, string>();
  for (const { file, content } of files) hashes.set(file, sha16(content));
  const candidates = allCandidates.filter((c) => {
    if (sharedDeclaring.has(c.file)) return false;
    const hash = hashes.get(c.file);
    return !hash || !store.assistAlreadySeen(c.file, hash);
  });
  const skippedCached = allCandidates.length - candidates.length;
  if (skippedCached > 0) console.log(`scan assist: ${skippedCached} file(s) unchanged since last analysis — skipped (no cost)`);
  if (candidates.length === 0) return { calls: 0, max_calls: maxCalls, est_cost_usd: 0 };

  const outcome = await runAssist(candidates, caller);
  for (const c of candidates.slice(0, outcome.calls)) {
    const hash = hashes.get(c.file);
    if (hash) store.recordAssistSeen(c.file, hash);
  }
  // An AI node only enters when it ADDS something: it has elements and no
  // better source (execution/static) covers the same url.
  outcome.pages = outcome.pages.filter(
    (page) => page.elements.length > 0 && !store.coveredByBetterSource(`**${page.path}`),
  );
  for (const page of outcome.pages) {
    store.upsertLlmPage(page.path, page.elements.slice(0, 150), page.file);
  }

  const cost = estimateCostUsd(outcome.tokens, outcome.model, outcome.provider);
  if (outcome.calls > 0) {
    // The scan's AI cost goes into the SAME ledger as the runs (windup costs).
    await mkdir(ctx.paths.runsDir, { recursive: true });
    const record = {
      kind: "scan",
      started_at: new Date().toISOString(),
      llm_calls: outcome.calls,
      llm_model: outcome.model,
      llm_provider: outcome.provider,
      tokens: outcome.tokens,
      estimated_cost_usd: cost,
      files_analyzed: Math.min(candidates.length, outcome.calls),
      pages_inferred: outcome.pages.length,
    };
    const stamp = record.started_at.replace(/[:.]/g, "-");
    await writeFile(path.join(ctx.paths.runsDir, `scan-${stamp}.json`), JSON.stringify(record, null, 2));
  }
  return { calls: outcome.calls, max_calls: maxCalls, est_cost_usd: cost };
}

function sha16(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/** Files changed since the SHA (commits + staged + worktree); null if git is unavailable. */
async function gitChangedFiles(root: string, sinceSha: string): Promise<string[] | null> {
  try {
    const { stdout } = await exec("git", ["diff", "--name-only", sinceSha], { cwd: root });
    return stdout.split("\n").filter(Boolean);
  } catch {
    return null;
  }
}

async function gitHead(root: string): Promise<string | null> {
  try {
    const { stdout } = await exec("git", ["rev-parse", "HEAD"], { cwd: root });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function detectFramework(root: string): Promise<string | null> {
  try {
    const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps.next) return "next";
    if (deps["react-router"] || deps["react-router-dom"]) return "react-router";
    return null;
  } catch {
    return null;
  }
}
