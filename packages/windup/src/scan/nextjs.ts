import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

/**
 * Next.js route indexer by file convention (SPEC-002, layer 1).
 * No LLM, no parser: just the filesystem. Covers app router and pages router.
 *
 * Knows the FRAMEWORK (Next's public convention), never sites (doc 07).
 */
export interface StaticRoute {
  /** URL route ("/products/[id]" becomes "/products/:id"). */
  route: string;
  /** Source files that define/compose the route (input for P3: diff → stale). */
  files: string[];
}

export async function indexNextRoutes(projectRoot: string): Promise<StaticRoute[]> {
  const routes: StaticRoute[] = [];
  for (const base of ["app", "src/app"]) {
    const dir = path.join(projectRoot, base);
    if (await isDir(dir)) routes.push(...(await walkAppRouter(dir, dir)));
  }
  for (const base of ["pages", "src/pages"]) {
    const dir = path.join(projectRoot, base);
    if (await isDir(dir)) routes.push(...(await walkPagesRouter(dir, dir)));
  }
  return routes;
}

const PAGE_FILES = new Set(["page.tsx", "page.jsx", "page.ts", "page.js"]);
const IGNORED_DIRS = new Set(["api", "node_modules"]);

/** app router: each page.* defines a route; (groups) do not affect the URL. */
async function walkAppRouter(dir: string, root: string): Promise<StaticRoute[]> {
  const routes: StaticRoute[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith("_")) continue;
      routes.push(...(await walkAppRouter(full, root)));
    } else if (PAGE_FILES.has(entry.name)) {
      const rel = path.relative(root, path.dirname(full));
      routes.push({ route: appSegmentsToRoute(rel), files: [full] });
    }
  }
  return routes;
}

function appSegmentsToRoute(rel: string): string {
  const segments = rel
    .split(path.sep)
    .filter((s) => s !== "" && !(s.startsWith("(") && s.endsWith(")")) && !s.startsWith("@"))
    .map(dynamicSegment);
  return `/${segments.join("/")}`.replace(/\/+$/, "") || "/";
}

/** pages router: every .tsx/.jsx file is a route (except _app/_document/api). */
async function walkPagesRouter(dir: string, root: string): Promise<StaticRoute[]> {
  const routes: StaticRoute[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      routes.push(...(await walkPagesRouter(full, root)));
    } else if (/\.(tsx|jsx|ts|js)$/.test(entry.name) && !entry.name.startsWith("_")) {
      const rel = path.relative(root, full).replace(/\.(tsx|jsx|ts|js)$/, "");
      const segments = rel
        .split(path.sep)
        .filter((s) => s !== "index")
        .map(dynamicSegment);
      routes.push({ route: `/${segments.join("/")}`.replace(/\/+$/, "") || "/", files: [full] });
    }
  }
  return routes;
}

function dynamicSegment(segment: string): string {
  // [id] → :id · [...slug] → :slug* — neutral notation for the url_pattern.
  const catchAll = segment.match(/^\[\.\.\.(.+)\]$/);
  if (catchAll) return `:${catchAll[1]}*`;
  const dynamic = segment.match(/^\[(.+)\]$/);
  if (dynamic) return `:${dynamic[1]}`;
  return segment;
}

/**
 * Sources composing the route beyond the page.*: direct local imports
 * (1 level — cheap heuristic; enough for elements of the components
 * imported by the page).
 */
export async function collectRouteSources(route: StaticRoute, projectRoot: string): Promise<string[]> {
  const files = [...route.files];
  for (const file of route.files) {
    let source: string;
    try {
      source = await readFile(file, "utf8");
    } catch {
      continue;
    }
    for (const match of source.matchAll(/from\s+["'](\.{1,2}\/[^"']+|@\/[^"']+)["']/g)) {
      const spec = match[1];
      const base = spec.startsWith("@/")
        ? path.join(projectRoot, "src", spec.slice(2))
        : path.resolve(path.dirname(file), spec);
      const resolved = await resolveSource(base);
      if (resolved) files.push(resolved);
    }
  }
  return [...new Set(files)];
}

async function resolveSource(base: string): Promise<string | null> {
  const candidates = [base, `${base}.tsx`, `${base}.jsx`, `${base}.ts`, `${base}.js`, path.join(base, "index.tsx"), path.join(base, "index.ts")];
  for (const candidate of candidates) {
    try {
      const s = await stat(candidate);
      if (s.isFile()) return candidate;
    } catch {
      // try the next one
    }
  }
  return null;
}

async function isDir(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}
