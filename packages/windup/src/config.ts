import { loadConfig as c12LoadConfig } from "c12";
import path from "node:path";
import type { ClockConfig } from "./clock.js";

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
  /**
   * Deterministic field → resolver binding (feedback: don't leave it to the LLM
   * to guess `value_ref`). Keyed by a SELECTOR SUBSTRING; any `fill` whose
   * selector contains the key is filled with that resolver's value, overriding
   * whatever the plan put there (a literal or a mis-named ref). Declare it once,
   * app-wide, so an OTP/token field is always resolved — the whole point of a
   * deterministic CI test. E.g. `{ "[name=otp]": "otp_code" }`.
   */
  resolveFields?: Record<string, string>;
  /**
   * Request stubbing (#network): deterministic responses for matched requests,
   * applied on EVERY run (never part of the cached plan) so a scenario can hit a
   * hard-to-seed state — a 500, an empty list, a slow endpoint — without touching
   * the backend. Author-declared (the engine keeps zero site knowledge). The
   * FIRST rule whose `url` (substring or glob) and optional `method` match wins.
   * Global here applies to every scenario hitting a matched URL; a single scenario
   * can also set `network` in its JSON, merged over this (scenario rules win) so an
   * error-state test is scoped to just that run.
   */
  network?: NetworkRule[];
  /**
   * Frozen clock (#clock): pin the page's time and/or timezone for date-dependent
   * scenarios ("orders from today", a countdown) that otherwise drift at midnight.
   * Applied on every run, never cached. `now` freezes `Date`/`Date.now()` to a
   * fixed instant (it does not tick); `timezone` sets the browser's IANA zone.
   * Also settable per scenario (field-merged over this global, scenario winning).
   */
  clock?: ClockConfig;
  /**
   * Fail a scenario on runtime health signals observed DURING the run (#diagnostics),
   * even if every action verified. `consoleErrors` fails when the page logged a
   * console error or threw an uncaught exception; `http5xx` fails when a request
   * got a 5xx response. `ignore` is a list of URL/text substrings to silence
   * (known-noisy analytics, a third-party 500 you don't own). Requests answered by
   * `config.network` are always excluded (a deliberate stub is not a real failure).
   * The CLI flags `--fail-on-console` / `--fail-on-5xx` force these on for a run.
   */
  failOn?: { consoleErrors?: boolean; http5xx?: boolean; ignore?: string[] };
  /**
   * Device emulation (#device): a Playwright device-preset NAME (e.g. "iPhone 14",
   * "Pixel 7", "iPad Pro 11") applied to every run — viewport, user-agent, scale,
   * mobile/touch. Also `--device <name>` (wins over this). Cached plans are keyed
   * per device, so mobile and desktop keep separate trajectories. Mobile emulation
   * needs chromium.
   */
  device?: string;
  /**
   * Performance budgets (#web-vitals): fail a scenario when the final page's
   * metric exceeds the threshold — `ttfb_ms`, `fcp_ms`, `lcp_ms`, `dcl_ms`,
   * `load_ms` (milliseconds) or `cls` (unitless). Setting any budget turns on
   * web-vitals capture (also `--web-vitals`, which captures without gating).
   * Timing varies run-to-run — set budgets with headroom.
   */
  budgets?: { ttfb_ms?: number; fcp_ms?: number; lcp_ms?: number; dcl_ms?: number; load_ms?: number; cls?: number };
}

export interface NetworkRule {
  /** Matched against the request URL: a substring (fast path) or a glob (`**\/api/orders`). */
  url: string;
  /** Optional HTTP method filter (GET, POST, …), case-insensitive. */
  method?: string;
  /** Abort the request instead of responding (simulate a network error). Mutually exclusive with a response. */
  abort?: boolean;
  /** Response status (default 200). */
  status?: number;
  /** Response body as a string (use `json` for objects). */
  body?: string;
  /** Convenience: a JSON body — stringified, with content-type application/json unless overridden. */
  json?: unknown;
  /** Override the response content-type. */
  contentType?: string;
  /** Extra response headers. */
  headers?: Record<string, string>;
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
