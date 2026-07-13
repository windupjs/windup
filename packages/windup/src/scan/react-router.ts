import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { StaticRoute } from "./nextjs.js";

/**
 * Static route indexer for react-router projects (SPEC-002, layer 1).
 *
 * react-router declares routes in code, not file conventions, so this
 * indexer parses source lightly (regex, no AST) for the common shapes:
 *
 *  1. JSX:            <Route path="/x" element={<Page />} />
 *  2. Object routes:  createBrowserRouter([{ path: "/x", element: <Page/> }])
 *                     / useRoutes([...]) — any `path: "..."` entry
 *  3. v7 helpers:     route("/x", "./pages/x.tsx"), index("./pages/home.tsx")
 *  4. fs-routes:      app/routes/*.tsx flat-file convention (dots → slashes,
 *                     $param → :param, _index → parent)
 *
 * Nested relative paths are collected as-is (best effort): the map is a hint
 * for the planner, not ground truth — imperfect routes still guide selectors,
 * and execution-sourced knowledge corrects them (knowledge is cache).
 *
 * Zero-hardcode compliance: this module knows the FRAMEWORK's public API,
 * never any specific site.
 */
export async function indexReactRouterRoutes(projectRoot: string): Promise<StaticRoute[]> {
  const routes = new Map<string, Set<string>>(); // route → files

  const add = (route: string, files: string[]) => {
    const normalized = normalizeRoute(route);
    if (!normalized) return;
    const set = routes.get(normalized) ?? new Set<string>();
    for (const f of files) set.add(f);
    routes.set(normalized, set);
  };

  // 4) fs-routes convention (app/routes/ or src/routes/ flat files)
  for (const base of ["app/routes", "src/routes"]) {
    const dir = path.join(projectRoot, base);
    if (await isDir(dir)) {
      for (const { route, file } of await flatRoutes(dir)) add(route, [file]);
    }
  }

  // 1–3) code-declared routes: scan candidate source files
  for (const file of await sourceFiles(projectRoot)) {
    let source: string;
    try {
      source = await readFile(file, "utf8");
    } catch {
      continue;
    }
    if (!/react-router|<Route[\s>]|createBrowserRouter|createHashRouter|useRoutes|createRoutesFromElements/.test(source)) continue;

    const imports = importMap(source, file, projectRoot);

    // 1) JSX <Route path="..." element={...}> — the element may nest layout
    //    wrappers (<Protected><Page/></Protected>): resolve ALL of the
    //    element's components, not just the first one.
    for (const m of source.matchAll(/<Route\b([^>]*)>/g)) {
      const attrs = m[1];
      const p = attrs.match(/\bpath\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*["'`]([^"'`]*)["'`]\s*\})/);
      if (!p) continue;
      const routePath = p[1] ?? p[2] ?? p[3];
      const files = [file];
      const start = m.index ?? 0;
      let windowText = source.slice(start, start + 400);
      const nextRoute = windowText.indexOf("<Route", 6);
      if (nextRoute > 0) windowText = windowText.slice(0, nextRoute);
      const elementPart = windowText.match(/\belement\s*=\s*\{([\s\S]*)/)?.[1] ?? "";
      const names = [...new Set([...elementPart.matchAll(/<\s*([A-Z][A-Za-z0-9_]*)/g)].map((x) => x[1]))].slice(0, 4);
      for (const name of names) {
        const comp = await resolveBase(imports.get(name));
        if (comp) files.push(comp);
      }
      add(routePath, files);
    }

    // 2) object routes: path: "..." — only counted when the surrounding window
    //    carries a route trait (element/Component/lazy/children/index/loader).
    //    Plain `path:` keys in menu/breadcrumb/API configs are NOT routes.
    for (const m of source.matchAll(/\bpath\s*:\s*(?:"([^"]+)"|'([^']+)')/g)) {
      const routePath = m[1] ?? m[2];
      const start = Math.max(0, (m.index ?? 0) - 300);
      const window = source.slice(start, (m.index ?? 0) + 400);
      if (!/\b(element|Component|lazy|children|index|loader|errorElement|action)\s*:/.test(window)) continue;
      const files = [file];
      const forward = source.slice(m.index ?? 0, (m.index ?? 0) + 400);
      const el =
        forward.match(/\belement\s*:\s*<\s*([A-Z][A-Za-z0-9_]*)/) ??
        forward.match(/\bComponent\s*:\s*([A-Z][A-Za-z0-9_]*)/);
      const comp = el && (await resolveBase(imports.get(el[1])));
      if (comp) files.push(comp);
      const lazy = forward.match(/import\(\s*["']([^"']+)["']\s*\)/);
      if (lazy) {
        const resolved = await resolveImport(lazy[1], file, projectRoot);
        if (resolved) files.push(resolved);
      }
      add(routePath, files);
    }

    // 3) v7 route config helpers: route("path", "file"), index("file")
    for (const m of source.matchAll(/\broute\s*\(\s*["']([^"']+)["']\s*,\s*["']([^"']+)["']/g)) {
      const resolved = await resolveImport(m[2], file, projectRoot);
      add(m[1], resolved ? [file, resolved] : [file]);
    }
    for (const m of source.matchAll(/\bindex\s*\(\s*["']([^"']+)["']\s*\)/g)) {
      const resolved = await resolveImport(m[1], file, projectRoot);
      add("/", resolved ? [file, resolved] : [file]);
    }
  }

  return [...routes.entries()].map(([route, files]) => ({ route, files: [...files] }));
}

/** "products/:id" → "/products/:id" · drops "*"-only and empty paths. */
function normalizeRoute(route: string): string | null {
  const trimmed = route.trim();
  if (!trimmed || trimmed === "*") return null;
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withSlash.replace(/\/\*$/, "/*").replace(/\/+$/, "") || "/";
}

/** Local import map: ComponentName → resolved file (relative and @/ specifiers). */
function importMap(source: string, file: string, projectRoot: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of source.matchAll(/import\s+(?:\{([^}]+)\}|([A-Za-z0-9_]+))\s+from\s+["'](\.{1,2}\/[^"']+|@\/[^"']+)["']/g)) {
    const names = m[1] ? m[1].split(",").map((s) => s.trim().split(/\s+as\s+/).pop()!.trim()) : [m[2]];
    const base = m[3].startsWith("@/")
      ? path.join(projectRoot, "src", m[3].slice(2))
      : path.resolve(path.dirname(file), m[3]);
    for (const name of names) if (name) map.set(name, base);
  }
  return map;
}

async function resolveImport(spec: string, fromFile: string, projectRoot: string): Promise<string | null> {
  const base = spec.startsWith("@/")
    ? path.join(projectRoot, "src", spec.slice(2))
    : spec.startsWith(".")
      ? path.resolve(path.dirname(fromFile), spec)
      : path.resolve(projectRoot, spec.replace(/^\//, ""));
  return resolveBase(base);
}

/** Resolve an extensionless import base to a real source file. */
async function resolveBase(base: string | undefined): Promise<string | null> {
  if (!base) return null;
  for (const candidate of [base, `${base}.tsx`, `${base}.jsx`, `${base}.ts`, `${base}.js`, path.join(base, "index.tsx"), path.join(base, "index.ts")]) {
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // try next
    }
  }
  return null;
}

/** flat-file convention: products.$id.tsx → /products/:id · _index.tsx → / */
async function flatRoutes(dir: string): Promise<Array<{ route: string; file: string }>> {
  const out: Array<{ route: string; file: string }> = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.(tsx|jsx|ts|js)$/.test(entry.name)) continue;
    const stem = entry.name.replace(/\.(tsx|jsx|ts|js)$/, "");
    const segments = stem
      .split(".")
      .filter((s) => s !== "_index")
      .map((s) => (s.startsWith("$") ? `:${s.slice(1)}` : s))
      .filter((s) => !s.startsWith("_")); // pathless layout segments
    out.push({ route: `/${segments.join("/")}` || "/", file: path.join(dir, entry.name) });
  }
  return out;
}

const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".next", ".git", "coverage", ".windup"]);
const MAX_FILES = 2000;

export async function sourceFiles(projectRoot: string): Promise<string[]> {
  const out: string[] = [];
  const roots = ["src", "app"].map((d) => path.join(projectRoot, d));
  const queue = (await Promise.all(roots.map(async (d) => ((await isDir(d)) ? [d] : [])))).flat();
  while (queue.length && out.length < MAX_FILES) {
    const dir = queue.shift()!;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) queue.push(full);
      } else if (/\.(tsx|jsx|ts|js)$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name)) {
        out.push(full);
      }
    }
  }
  return out;
}

async function isDir(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}
