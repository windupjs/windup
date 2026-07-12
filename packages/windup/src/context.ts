import path from "node:path";

/**
 * Contexto de execução do Windup: raiz do projeto do usuário e caminhos
 * derivados. Substitui os paths por import.meta.dirname da spike, que
 * quebrariam sob build (dist/) e sob npx em projeto externo.
 *
 * No M2 (P1) o contexto passa a ser resolvido a partir do windup.config.ts;
 * por ora deriva do cwd com overrides por env (usados pelos testes).
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
}

export function createContext(root: string = process.cwd(), opts: { scenariosDir?: string } = {}): WindupContext {
  const dataDir = path.join(root, ".windup");
  return {
    paths: {
      root,
      scenariosDir: path.resolve(
        root,
        opts.scenariosDir ?? process.env.WINDUP_SCENARIOS_DIR ?? "scenarios",
      ),
      cacheDir: process.env.WINDUP_CACHE_DIR
        ? path.resolve(process.env.WINDUP_CACHE_DIR)
        : path.join(dataDir, "cache", "trajetorias"),
      runsDir: path.join(dataDir, "runs"),
      mapFile: path.join(dataDir, "map", "site-map.json"),
    },
  };
}

let current: WindupContext | null = null;

export function getContext(): WindupContext {
  if (!current) current = createContext();
  return current;
}

export function setContext(ctx: WindupContext): void {
  current = ctx;
}
