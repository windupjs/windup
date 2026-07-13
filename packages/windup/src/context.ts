import path from "node:path";
import { readFileSync } from "node:fs";
import { DEFAULT_CONFIG, loadWindupConfig, type WindupConfig } from "./config.js";

/**
 * Contexto de execução do Windup: config resolvida + raiz do projeto do
 * usuário e caminhos derivados. Substitui os paths por import.meta.dirname
 * da spike, que quebrariam sob build (dist/) e sob npx em projeto externo.
 */
export interface WindupPaths {
  root: string;
  /** Cenários do usuário (commitados). */
  scenariosDir: string;
  /** Cache de trajetórias (gitignored). */
  cacheDir: string;
  /** Métricas por execução (gitignored). */
  runsDir: string;
  /** Grafo do mapa do site (gitignored). */
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
  // windup.credentials.json (mapeamento conta → ENV, commitável e sem valores;
  // ver secrets.ts) entra no manifesto. A config explícita vence em conflito.
  try {
    const file = JSON.parse(readFileSync(path.join(root, "windup.credentials.json"), "utf8")) as {
      accounts?: Record<string, Record<string, string>>;
    };
    if (file.accounts && Object.keys(file.accounts).length) {
      config.context = config.context ?? {};
      config.context.credentials = { ...file.accounts, ...config.context.credentials };
    }
  } catch {
    // sem arquivo de credenciais — manifesto segue só com a config
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

/** Carrega windup.config.* (subindo a árvore) e monta o contexto a partir dele. */
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
