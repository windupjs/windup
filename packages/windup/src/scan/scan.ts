import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { getContext } from "../context.js";
import { SiteMapStore } from "../sitemap.js";
import { extractElements, formatElement } from "./extract.js";
import { collectRouteSources, indexNextRoutes, type StaticRoute } from "./nextjs.js";
import { indexReactRouterRoutes } from "./react-router.js";

const exec = promisify(execFile);

/**
 * `windup scan` (SPEC-002): indexação estática do projeto — rotas por
 * convenção de framework + elementos por parse leve — alimentando o MESMO
 * grafo do mapa do site com `source: "static"`.
 *
 * `--update` (P3): incremental via git, não watcher — re-indexa só rotas
 * cujos fontes mudaram desde o último scan (SHA gravado no mapa) e marca
 * stale o conhecimento de execução afetado.
 *
 * Tetos explícitos e zero LLM nesta camada; a camada LLM-assist é P4.
 */
export interface ScanSummary {
  framework: string | null;
  routes: number;
  elements: number;
  mapFile: string;
  mode: "full" | "incremental";
}

export async function runScan(opts: { update?: boolean } = {}): Promise<ScanSummary> {
  const ctx = getContext();
  const root = path.resolve(ctx.paths.root, ctx.config.scan?.root ?? ".");
  const framework = ctx.config.framework ?? (await detectFramework(root));

  const store = await SiteMapStore.load(ctx.paths.mapFile);
  let routesCount = 0;
  let elementsCount = 0;
  let mode: "full" | "incremental" = "full";

  if (framework === "next" || framework === "react-router" || framework === "remix") {
    let routes = framework === "next" ? await indexNextRoutes(root) : await indexReactRouterRoutes(root);
    const sources = new Map<StaticRoute, string[]>();
    for (const route of routes) {
      sources.set(route, await collectRouteSources(route, root));
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

    for (const route of routes) {
      const files = sources.get(route) ?? route.files;
      const lines: string[] = [];
      for (const file of files) {
        try {
          lines.push(...extractElements(await readFile(file, "utf8")).map(formatElement));
        } catch {
          // fonte ilegível não derruba o scan
        }
      }
      store.upsertStaticPage(route.route, [...new Set(lines)], files);
      routesCount += 1;
      elementsCount += lines.length;
    }

    store.lastScanSha = (await gitHead(root)) ?? store.lastScanSha;
  } else {
    console.log(
      `scan: no static indexer for ${framework ?? "this project"} yet (supported: Next.js, react-router, remix). Nothing was indexed — the site map will still be fed by executions.`,
    );
  }

  await store.save();
  return { framework, routes: routesCount, elements: elementsCount, mapFile: ctx.paths.mapFile, mode };
}

/** Arquivos alterados desde o SHA (commits + staged + worktree); null se git indisponível. */
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
