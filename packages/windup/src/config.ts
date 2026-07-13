import { loadConfig as c12LoadConfig } from "c12";
import path from "node:path";

/**
 * Project configuration (windup.config.ts) — full SPEC-002 schema.
 * The `scan` (P2) and `context` (E4) sections are already typed but still
 * inert: existing now avoids a config migration when those phases arrive.
 */
export interface WindupConfig {
  /** Base for relative start_url in scenarios (e.g. "/login"). */
  baseUrl?: string;
  llm: {
    /** Provider active by default; switch per run with --llm / WINDUP_LLM. */
    provider: "google" | "openai";
    model: string;
    /**
     * Several providers configured AT THE SAME TIME — each one's default model
     * and key. Per-run selection (`--llm openai[:model]`) uses these
     * defaults when the model is not in the flag.
     */
    providers?: Partial<
      Record<
        "google" | "openai",
        {
          model?: string;
          /** Name of the env var holding the API key (default: GOOGLE_GENERATIVE_AI_API_KEY / OPENAI_API_KEY). */
          apiKeyEnv?: string;
          /** openai only: alternative OpenAI-compatible endpoint (Azure, proxy, local model). */
          baseUrl?: string;
        }
      >
    >;
  };
  /** Scenarios folder, relative to the config (committed). */
  scenarios: string;
  /** Framework detected by init (P2 hook; informational only for now). */
  framework?: string | null;
  signature?: {
    /** true = a diverging sig becomes a miss (default: lenient, warn only). */
    strict?: boolean;
  };
  /** P2 — project indexing (inert for now). */
  scan?: {
    root?: string;
    include?: string[];
    exclude?: string[];
    dynamic?: { enabled: boolean; maxDepth?: number; maxPages?: number };
    llmAssist?: { enabled: boolean; maxCalls?: number };
  };
  /** E4 — project manifest (inert for now; SPEC-001 component 3). */
  context?: {
    conventions?: string[];
    credentials?: Record<string, Record<string, string>>;
    vocabulary?: Record<string, string>;
  };
}

export const DEFAULT_CONFIG: WindupConfig = {
  llm: { provider: "google", model: "gemini-3.1-flash-lite" },
  scenarios: "e2e/scenarios",
};

/** Typed identity for the user's windup.config.ts. */
export function defineConfig(config: Partial<WindupConfig>): Partial<WindupConfig> {
  return config;
}

export interface LoadedConfig {
  config: WindupConfig;
  /** Config directory (the user's project root); cwd if there is no file. */
  root: string;
  configFile: string | null;
}

/**
 * Resolves windup.config.{ts,js,mjs,json} walking up the tree from the cwd
 * (c12 + jiti: TS without a build, without depending on the user's tsconfig).
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
