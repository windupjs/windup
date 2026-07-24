import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { StaticRoute } from "./nextjs.js";

/**
 * Static route indexer for TanStack Router / TanStack Start (SPEC-002, layer 1).
 *
 * TanStack uses FILE-BASED routing under `src/routes/` (or `app/routes/`) with
 * its own conventions, which react-router's flat-file indexer does not model:
 *
 *  - dot-notation as path separators:  `workspace.loja.aparencia.tsx` → /workspace/loja/aparencia
 *  - directories + params:             `loja/$companySlug/checkout/pagamento.tsx` → /loja/:companySlug/checkout/pagamento
 *  - pathless layout segments (`_x`):  `_authenticated/_company/manager.companies.tsx` → /manager/companies
 *  - index / route / __root markers:   `posts/index.tsx` → /posts · `__root.tsx` → (skipped)
 *  - splat:                            `$.tsx` → /*  ·  opt-out `posts_.tsx` → /posts
 *
 * Authoritative source of truth: each route file calls
 * `createFileRoute('/resolved/path')` (or `createLazyFileRoute`) — TanStack's
 * codegen writes the resolved route id there. We prefer that string; when it is
 * absent we derive the path from the file name via the same conventions.
 *
 * Zero-hardcode compliance: knows the FRAMEWORK's conventions, never a site.
 */

const ROUTE_FILE = /\.(tsx|jsx|ts|js)$/;
const CREATE_ROUTE = /create(?:Lazy)?FileRoute\(\s*['"`]([^'"`]+)['"`]/;

export async function indexTanstackRoutes(projectRoot: string): Promise<StaticRoute[]> {
  const routesDir = await firstExistingDir(projectRoot, ["src/routes", "app/routes"]);
  if (!routesDir) return [];

  const byRoute = new Map<string, Set<string>>();
  for (const file of await walk(routesDir)) {
    if (!ROUTE_FILE.test(file) || /\.(test|spec)\./.test(file)) continue;
    let source: string;
    try {
      source = await readFile(file, "utf8");
    } catch {
      continue;
    }
    const marker = source.match(CREATE_ROUTE);
    const relStem = path.relative(routesDir, file).replace(ROUTE_FILE, "");
    // Prefer the createFileRoute id (resolved by TanStack); fall back to the
    // file name. A file with neither is a helper, not a route — skip it.
    if (!marker && !looksLikeRouteFile(source, relStem)) continue;
    const route = toUrlPattern(marker ? marker[1] : relStem);
    if (route === null) continue; // __root and other non-URL nodes

    const set = byRoute.get(route) ?? new Set<string>();
    set.add(file);
    byRoute.set(route, set);
  }

  return [...byRoute].map(([route, set]) => ({ route, files: [...set] }));
}

/**
 * Turns a TanStack route id or file stem into a URL pattern. Segments are split
 * on both `/` (directories, resolved ids) and `.` (dot-notation file names), so
 * the same logic serves the createFileRoute string and the file-name fallback.
 * Exported for testing.
 */
export function toUrlPattern(raw: string): string | null {
  const out: string[] = [];
  const segments = raw
    .split("/")
    .flatMap((s) => s.split("."))
    .map((s) => s.trim())
    .filter(Boolean);

  for (let seg of segments) {
    if (seg === "__root") return null; // root layout — no URL
    if (seg === "index" || seg === "route") continue; // index/layout markers
    if (seg.startsWith("_")) continue; // pathless layout segment (_authenticated…)
    if (seg.endsWith("_")) seg = seg.slice(0, -1); // opt-out-of-layout marker (posts_)
    if (!seg) continue;
    if (seg === "$") {
      out.push("*"); // splat / catch-all
      continue;
    }
    out.push(seg.startsWith("$") ? `:${seg.slice(1)}` : seg);
  }
  return out.length ? `/${out.join("/")}` : "/";
}

/** A route file without a createFileRoute marker is rare; accept obvious ones. */
function looksLikeRouteFile(source: string, relStem: string): boolean {
  if (/createRootRoute|createRootRouteWithContext/.test(source)) return false; // __root
  return /export\s+const\s+Route\b/.test(source) || relStem === "index";
}

async function firstExistingDir(root: string, candidates: string[]): Promise<string | null> {
  for (const c of candidates) {
    const dir = path.join(root, c);
    try {
      if ((await readdir(dir)).length >= 0) return dir;
    } catch {
      // not a directory
    }
  }
  return null;
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      out.push(...(await walk(full)));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}
