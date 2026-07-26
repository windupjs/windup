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
    provider: "google" | "openai" | "claude-code";
    model: string;
    /**
     * Several providers configured AT THE SAME TIME — each one's default model
     * and key. Per-run selection (`--llm openai[:model]`) uses these
     * defaults when the model is not in the flag.
     */
    providers?: Partial<
      Record<
        "google" | "openai" | "claude-code",
        {
          model?: string;
          /** Name of the env var holding the API key (default: GOOGLE_GENERATIVE_AI_API_KEY / OPENAI_API_KEY; optional for claude-code). */
          apiKeyEnv?: string;
          /**
           * openai: alternative OpenAI-compatible endpoint (Azure, proxy, local model).
           * claude-code: where the local wrapper listens (default http://localhost:8000/v1).
           */
          baseUrl?: string;
        }
      >
    >;
  };
  /** Scenarios folder, relative to the config (committed). */
  scenarios: string;
  /** Framework detected by init (P2 hook; informational only for now). */
  framework?: string | null;
  /** Browser engine: chromium (default, auto-provisioned) | firefox | webkit (need `npx playwright install <name>`). Also: --browser / WINDUP_BROWSER. */
  browser?: "chromium" | "firefox" | "webkit";
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
  /**
   * Reusable readiness signals per route glob (anti-flake). Keyed by a route
   * glob (e.g. "**\/workspace/**"), each value is a CSS selector (or list of
   * selectors) that must be VISIBLE before the executor runs the first action
   * on a matching page. Applied deterministically at run time (no LLM, $0, not
   * part of the cached plan) whenever the page URL matches — so a hydration/
   * loading wait isn't repeated as a hint in every scenario. Best-effort: a
   * signal that never appears within the timeout is a warning, not a failure.
   */
  readySignals?: Record<string, string | string[]>;
  /**
   * Suite-level fixtures for `run --all`: shell command(s) run ONCE before the
   * whole suite (`setup`) and ONCE after it (`teardown`, always — even on
   * failure), outside every cached plan. Use for seeding/tearing down a shared
   * fixture database or starting an external stub. Per-scenario `setup`/
   * `teardown` (in the scenario JSON) still handle per-test state. If `setup`
   * fails the suite aborts before running any scenario; a `teardown` failure is
   * a warning. They are the team's own trusted commands, run in the project root.
   */
  suite?: {
    setup?: string | string[];
    teardown?: string | string[];
  };
  /**
   * Safety denylist — controls a plan must NEVER touch (a CI guardrail against
   * irreversible side effects: changing the test account's password, deleting
   * data, saving persistent config). If any action targets a forbidden selector
   * (substring match on the plan's CSS selector) or the run navigates to a
   * forbidden URL (glob on the path), the run ABORTS with a `forbidden` failure.
   * Author-declared (never inferred) — the engine keeps zero site knowledge.
   */
  forbid?: {
    /** Substrings; an action whose selector CONTAINS one is blocked (e.g. "#change-password", "[data-danger]"). */
    selectors?: string[];
    /** URL-path globs the run must never reach (e.g. "**\/account/password", "**\/admin/**"). */
    urls?: string[];
  };
  /**
   * Dynamic values fetched at run time (OTP codes, magic-link URLs, …), keyed by
   * a name a plan references via `value_ref: "<name>"` (a fill) or `url_ref:
   * "<name>"` (a goto). The SOURCE is AUTHOR-declared here — never emitted by the
   * LLM — so this can run trusted shell/HTTP/JS without becoming a code-exec
   * vector. Resolved lazily at the point of use, with polling (the value takes a
   * moment to appear). The value is ephemeral: it is NEVER cached, reported or logged.
   */
  resolve?: Record<string, {
    source: {
      kind: "cmd" | "http" | "fn";
      /** cmd: a shell command whose stdout is the value (e.g. `psql -tAc "select code from otp_codes …"`). */
      command?: string;
      /** http: fetch this URL (e.g. a test-inbox API); response text/JSON is the source. */
      url?: string;
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      /** fn: path to a project JS/TS module that default-exports (or names) an async () => string. */
      module?: string;
      export?: string;
    };
    /** Pull the value out of the source output: a regex (capture group 1, or the whole match) or a dot-path into JSON. */
    extract?: { regex?: string; json?: string };
    /** Poll until the value appears (default 30s, every 1s). */
    poll?: { timeout_ms?: number; interval_ms?: number };
    /** true = the resolved value is a URL (used via `url_ref` on a goto) — informational for the planner. */
    url?: boolean;
  }>;
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
