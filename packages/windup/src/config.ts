import { loadConfig as c12LoadConfig } from "c12";
import path from "node:path";

/**
 * Configuração do projeto (windup.config.ts) — schema completo da SPEC-002.
 * As seções `scan` (P2) e `context` (E4) já são tipadas mas ainda inertes:
 * existir desde já evita migração de config quando as fases chegarem.
 */
export interface WindupConfig {
  /** Base para start_url relativo nos cenários (ex.: "/login"). */
  baseUrl?: string;
  llm: {
    provider: "google";
    model: string;
  };
  /** Pasta dos cenários, relativa à config (commitada). */
  scenarios: string;
  /** Framework detectado pelo init (gancho do P2; só informativo por ora). */
  framework?: string | null;
  signature?: {
    /** true = sig divergente vira miss (padrão: leniente, só avisa). */
    strict?: boolean;
  };
  /** P2 — indexação de projeto (inerte por enquanto). */
  scan?: {
    root?: string;
    include?: string[];
    exclude?: string[];
    dynamic?: { enabled: boolean; maxDepth?: number; maxPages?: number };
    llmAssist?: { enabled: boolean; maxCalls?: number };
  };
  /** E4 — manifesto do projeto (inerte por enquanto; SPEC-001 componente 3). */
  context?: {
    conventions?: string[];
    credentials?: Record<string, Record<string, string>>;
    vocabulary?: Record<string, string>;
  };
}

export const DEFAULT_CONFIG: WindupConfig = {
  llm: { provider: "google", model: "gemini-2.5-flash" },
  scenarios: "e2e/scenarios",
};

/** Identidade tipada para o windup.config.ts do usuário. */
export function defineConfig(config: Partial<WindupConfig>): Partial<WindupConfig> {
  return config;
}

export interface LoadedConfig {
  config: WindupConfig;
  /** Diretório da config (root do projeto do usuário); cwd se não houver arquivo. */
  root: string;
  configFile: string | null;
}

/**
 * Resolve windup.config.{ts,js,mjs,json} subindo a árvore a partir do cwd
 * (c12 + jiti: TS sem build, sem depender do tsconfig do usuário).
 */
export async function loadWindupConfig(cwd: string = process.cwd()): Promise<LoadedConfig> {
  const { config, configFile } = await c12LoadConfig<WindupConfig>({
    name: "windup",
    cwd,
    defaults: DEFAULT_CONFIG,
  });
  const file = configFile && configFile !== "windup.config" ? configFile : null;
  return {
    config: config ?? DEFAULT_CONFIG,
    root: file ? path.dirname(file) : cwd,
    configFile: file,
  };
}
