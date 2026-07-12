import { readFile } from "node:fs/promises";
import path from "node:path";
import { getContext } from "../context.js";
import { SiteMapStore } from "../sitemap.js";
import { extractElements, formatElement } from "./extract.js";
import { collectRouteSources, indexNextRoutes } from "./nextjs.js";

/**
 * `windup scan` (SPEC-002): indexação estática do projeto — rotas por
 * convenção de framework + elementos por parse leve — alimentando o MESMO
 * grafo do mapa do site com `source: "static"`.
 *
 * Tetos explícitos e zero LLM nesta camada; a camada LLM-assist é P4.
 */
export interface ScanSummary {
  framework: string | null;
  routes: number;
  elements: number;
  mapFile: string;
}

export async function runScan(_opts: { update?: boolean } = {}): Promise<ScanSummary> {
  const ctx = getContext();
  const root = path.resolve(ctx.paths.root, ctx.config.scan?.root ?? ".");
  const framework = ctx.config.framework ?? (await detectFramework(root));

  const store = await SiteMapStore.load(ctx.paths.mapFile);
  let routesCount = 0;
  let elementsCount = 0;

  if (framework === "next") {
    const routes = await indexNextRoutes(root);
    for (const route of routes) {
      const files = await collectRouteSources(route, root);
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
  } else {
    console.log(
      `[windup] scan: indexador para ${framework ?? "framework não detectado"} ainda não existe (P2 cobre Next.js; react-router é o próximo). Nada indexado.`,
    );
  }

  await store.save();
  return { framework, routes: routesCount, elements: elementsCount, mapFile: ctx.paths.mapFile };
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
