import path from "node:path";
import { readFileSync } from "node:fs";
import { DEFAULT_CONFIG, loadWindupConfig, type WindupConfig } from "./config.js";

/**
 * Windup execution context: resolved config + the user's project root and
 * derived paths. Replaces the spike's import.meta.dirname-based paths, which
 * would break under build (dist/) and under npx in an external project.
 */
export interface WindupPaths {
  root: string;
  /** The user's scenarios (committed). */
  scenariosDir: string;
  /** Trajectory cache (gitignored). */
  cacheDir: string;
  /** Per-run metrics (gitignored). */
  runsDir: string;
  /** Site map graph (gitignored). */
  mapFile: string;
}

export interface WindupContext {
  paths: WindupPaths;
  config: WindupConfig;
}

export function createContext(
  root: string = process.cwd(),
  opts: { scenariosDir?: string; config?: WindupConfig } = {},
): WindupContext {
  const dataDir = path.join(root, ".windup");
  const config = opts.config ?? DEFAULT_CONFIG;
  // windup.credentials.json (account → ENV mapping, committable and value-free;
  // see secrets.ts) goes into the manifest. Explicit config wins on conflict.
  try {
    const file = JSON.parse(readFileSync(path.join(root, "windup.credentials.json"), "utf8")) as {
      accounts?: Record<string, Record<string, string>>;
    };
    if (file.accounts && Object.keys(file.accounts).length) {
      config.context = config.context ?? {};
      config.context.credentials = { ...file.accounts, ...config.context.credentials };
    }
  } catch {
    // no credentials file — the manifest proceeds with just the config
  }
  return {
    config,
    paths: {
      root,
      scenariosDir: path.resolve(
        root,
        opts.scenariosDir ?? process.env.WINDUP_SCENARIOS_DIR ?? config.scenarios,
      ),
      cacheDir: process.env.WINDUP_CACHE_DIR
        ? path.resolve(process.env.WINDUP_CACHE_DIR)
        : path.join(dataDir, "cache", "trajetorias"),
      runsDir: path.join(dataDir, "runs"),
      mapFile: path.join(dataDir, "map", "site-map.json"),
    },
  };
}

/** Loads windup.config.* (walking up the tree) and builds the context from it. */
export async function createContextFromConfig(cwd: string = process.cwd()): Promise<WindupContext> {
  const { config, root } = await loadWindupConfig(cwd);
  return createContext(root, { config });
}

let current: WindupContext | null = null;

export function getContext(): WindupContext {
  if (!current) current = createContext();
  return current;
}

export function setContext(ctx: WindupContext): void {
  current = ctx;
}
