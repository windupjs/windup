import type { NetworkRule } from "./config.js";
import type { ClockConfig } from "./clock.js";

export type ActionType = "goto" | "click" | "fill" | "wait_for" | "use";

export interface ActionTarget {
  selector: string;
  description: string;
}

export interface ExpectSelectorValue {
  selector: string;
  value: string;
}

export interface ExpectTextContains {
  selector: string;
  text: string;
}

export interface ExpectCount {
  selector: string;
  equals?: number;
  min?: number;
  max?: number;
}

export interface ExpectAttribute {
  selector: string;
  name: string;
  value: string;
}

export interface Expect {
  selector?: string;
  url?: string;
  selector_value?: ExpectSelectorValue;
  /** A selector's visible text CONTAINS this string. */
  text_contains?: ExpectTextContains;
  /** How many elements match a selector (equals / min / max — at least one). */
  count?: ExpectCount;
  /** A selector is absent or hidden (the negative of `selector`). */
  not_visible?: string;
  /** A selector's attribute equals this value. */
  attribute?: ExpectAttribute;
}

export interface Action {
  id: string;
  type: ActionType;
  target?: ActionTarget;
  value?: string;
  /** Fill value from a reference: "ENV:NAME" (an env var) or a `config.resolve` name (a runtime value like an OTP). Never a literal secret. */
  value_ref?: string;
  url?: string;
  /** goto: navigate to a runtime-resolved URL (a `config.resolve` name, e.g. a magic-link). Resolved at run time; never cached as a value. */
  url_ref?: string;
  /** type=use: id of the fragment to expand inline (E3). */
  use?: string;
  expect?: Expect;
  /** Handle a native browser dialog (window.confirm/alert/prompt) that THIS action opens: accept or dismiss it. */
  dialog?: "accept" | "dismiss";
  timeout_ms?: number;
}

/**
 * Trajectory fragment (SPEC-001, component 2): a named, reusable
 * sub-trajectory. Lives versioned in the user's repo (it is curated
 * knowledge), unlike the cache. The plan references { type: "use", use: "<id>" }
 * and the runner expands it inline before executing.
 */
export interface Fragment {
  fragment_id: string;
  description: string;
  /** Documentation of the secrets/parameters (the actions use value_ref ENV:*). */
  params?: Record<string, string>;
  actions: Action[];
  postcondition?: Expect;
}

export interface Plan {
  plan_version: "0.1";
  scenario_id: string;
  task?: string;
  start_url: string;
  generated_by?: { model: string; at: string };
  actions: Action[];
}

export interface Scenario {
  scenario_id: string;
  /**
   * Initial URL. Optional (default "/") and it NEVER needs to be absolute: paths
   * resolve against the effective baseUrl — and --base-url/WINDUP_BASE_URL
   * override the ORIGIN even of absolute URLs (port/host change per
   * environment; the test is the same).
   */
  start_url?: string;
  task: string;
  /** Site-specific knowledge provided by the scenario AUTHOR (doc 07: no hardcoded site knowledge in the engine). */
  hints?: string[];
  /** Shell command(s) run BEFORE the scenario, outside the cached plan (fixtures / DB reset). */
  setup?: string | string[];
  /** Shell command(s) run AFTER the scenario — always, even on failure — outside the cached plan (cleanup for non-idempotent CREATE). */
  teardown?: string | string[];
  /**
   * Prerequisite scenarios (e.g. ["login"]), executed IN THE SAME browser
   * session before this one — each with its own cache/replay. Without an
   * explicit start_url, this scenario CONTINUES from the page where the last
   * dependency ended (and the planner sees that real page).
   */
  depends_on?: string[];
  /**
   * #1 — isomorphic plan reuse (opt-in). This scenario reuses another scenario's
   * PROVEN cached plan instead of asking the LLM: same flow, different route
   * (this scenario's start_url) and, optionally, different fill values (`set`
   * maps a literal value in the source plan → the value to use here). The reused
   * plan is still executed and verified before it is trusted/cached; any
   * mismatch falls back to normal LLM planning. Never bypasses the verify gate.
   */
  like?: {
    /** scenario_id whose active cached plan is the template. */
    scenario: string;
    /** Optional fill-value overrides: source literal value → value to use here. */
    set?: Record<string, string>;
  };
  /**
   * #5 — deterministic browser-storage fixtures, applied BEFORE the plan runs
   * (no server call). Seed `localStorage` (e.g. a pre-built cart) and/or
   * `sessionStorage` (e.g. a POS device selection) so a scenario can reach a
   * client-side state directly, instead of building it through the UI. Seeded
   * per origin; each key is set only if absent, so the app's own mutations
   * (a cart the test then edits) are never clobbered on later navigations.
   */
  seed?: {
    localStorage?: Record<string, string>;
    sessionStorage?: Record<string, string>;
    /** Origin to seed (default: the scenario's start_url origin). */
    origin?: string;
  };
  /**
   * #3 — human-readable DATA preconditions this scenario assumes exist (e.g.
   * "1 active attraction", "a paid order"). Declarative only: Windup shows them
   * in the report so a reader understands why the scenario breaks when the data
   * is gone, and can plan the create→use→archive cycle. It does NOT verify them
   * (use `setup`/`suite.setup` to actually seed the data).
   */
  requires?: string[];
  /** Free-form tags for selecting a subset with `run --all --tag <name>` (e.g. ["smoke", "checkout"]). */
  tags?: string[];
  /** Auto-handle EVERY native dialog (window.confirm/alert/prompt) this scenario opens — a default so a per-action `dialog` isn't repeated on each destructive step. */
  on_dialog?: "accept" | "dismiss";
  /** Force one interaction per action: tell the planner never to combine a reveal/expand click with the action it uncovers (multi-click flows behind accordions/menus). */
  atomic_steps?: boolean;
  /** Quarantine a known-flaky scenario: it still runs and reports, but its failure does NOT fail the suite (non-zero exit). Surfaced prominently so it isn't forgotten. */
  quarantine?: boolean;
  /** Per-scenario request stubs, MERGED over `config.network` (scenario rules win). Scope a stub — e.g. a `{ url, status: 500 }` — to just this run so an error-state test doesn't leak into every scenario hitting that endpoint. Applied every run, never cached. */
  network?: NetworkRule[];
  /** Per-scenario frozen clock / timezone, field-merged over `config.clock` (scenario fields win). Applied every run, never cached. */
  clock?: ClockConfig;
}

export type CacheStatus = "active" | "stale";

export interface CacheEntry {
  cache_version: "0.2";
  key: {
    scenario_id: string;
    start_url: string;
    /** Structural signature of the initial page at plan time (E1). */
    start_sig?: string;
  };
  plan: Plan;
  status: CacheStatus;
  stats: {
    created_at: string;
    last_replayed_at: string | null;
    replay_count: number;
    replay_failures: number;
    /** How many times this scenario's plan has been (re)generated — unstable-scenario detector. */
    plan_generation: number;
  };
}

export type FailureKind = "network" | "verification" | "plan_invalid" | "dependency" | "setup" | "forbidden" | "diagnostics" | "budget";

export type CacheOutcome = "hit" | "miss" | "invalidated";

export interface ActionMetrics {
  id: string;
  /** What the action did — its kind (goto/click/fill/wait_for/use). */
  type?: ActionType;
  /** Human label for the report: the target's description/selector, the goto URL, or the fragment id (never a fill VALUE — secrets stay out). */
  label?: string;
  /** Set when the plan's selector missed but an accessibility fallback (label/placeholder) recovered the target — a signal the app's selector is fragile. */
  note?: string;
  duration_ms: number;
  verify_ms: number;
  status: "passed" | "failed";
}

export interface RunMetrics {
  scenario_id: string;
  /** Folder of the scenario file relative to the scenarios dir ("(root)" for top-level) — used to group the suite report. */
  module?: string;
  /** #3 — the scenario's declared DATA preconditions (from `requires`), surfaced in the report. */
  requires?: string[];
  started_at: string;
  cache: CacheOutcome;
  /** #1 — set to the source scenario_id when this run reused another scenario's plan (isomorphic reuse, no LLM); absent otherwise. */
  reused_from?: string | null;
  /** #4 — set to the dependency scenario_id whose session snapshot was restored (skipping the depends_on chain replay); absent otherwise. */
  reused_session_from?: string | null;
  llm_calls: number;
  llm_model: string | null;
  /** Model provider ("google", "openai"); null in replays, absent in pre-0.10 records. */
  llm_provider?: string | null;
  planning_mode: "full" | "incremental" | null;
  /** The planner's semantic retries (doc 03 allows ≤1); null if it did not plan. */
  plan_semantic_retries: number | null;
  /**
   * E1, lenient policy: true if the initial page's sig diverged from the one
   * recorded in the cache (the replay proceeds anyway); null when there was no comparable sig.
   */
  sig_mismatch: boolean | null;
  /** Planning prompt size in chars (E2); null if it did not plan. */
  prompt_chars: number | null;
  tokens: { input: number; output: number };
  estimated_cost_usd: number;
  /**
   * Wall-clock breakdown (ms). `total` = the whole run; `planning` = LLM
   * planning (0 on cache hit); `execution` = THIS scenario's Playwright actions;
   * `dependencies` = time spent (re)running the `depends_on` chain; `setup` =
   * browser context launch. The point of the cache is `$0` (no LLM) — wall-clock
   * is still Playwright actions + dependencies, which `dependencies`/`setup` make visible.
   */
  duration_ms: { total: number; planning: number; execution: number; dependencies?: number; setup?: number; navigation?: number };
  actions: ActionMetrics[];
  result: "passed" | "failed";
  failure: { kind: FailureKind; action_id: string | null; message: string } | null;
  /** #a11y — accessibility violations on the final page (axe-core), when `--a11y` ran. Informational; never fails the run. */
  a11y?: { violations: Array<{ id: string; impact: string; help: string; nodes: number }> };
  /** #diagnostics — console errors / 5xx responses observed during the run. Recorded when present; fails the run only under config.failOn / --fail-on-*. */
  diagnostics?: { console_errors?: string[]; failed_responses?: Array<{ url: string; status: number; method: string }> };
  /** #web-vitals — final-page performance (TTFB/FCP/LCP/DCL/load/CLS), captured under --web-vitals or config.budgets. Fails only when a config.budgets threshold is exceeded. */
  web_vitals?: { ttfb_ms: number | null; fcp_ms: number | null; lcp_ms: number | null; dcl_ms: number | null; load_ms: number | null; cls: number | null };
  /** --trace — paths (relative to the report dir) to a saved Playwright trace / screenshot captured on a FAILED run. */
  artifacts?: { trace?: string; screenshot?: string };
  /** Executed plan (diagnostic; absent if generation failed before a plan existed). */
  plan?: Plan;
  /**
   * Post-run summary generated by LLM (`run --summary`, opt-in): what the
   * test did, concrete observed results and difficulties. This call's cost
   * does NOT count toward llm_calls (which measures planning), but adds to
   * estimated_cost_usd.
   */
  summary?: { text: string; model: string; provider: string; tokens: { input: number; output: number }; est_cost_usd: number };
  /**
   * Fix suggestion generated by an LLM after a FAILED run (`run --suggest`):
   * a concrete, actionable diagnosis of why the scenario failed and how to fix
   * its task/hints. Cost is added to estimated_cost_usd, not to llm_calls.
   */
  suggestion?: { text: string; model: string; provider: string; tokens: { input: number; output: number }; est_cost_usd: number };
  /** Snapshot (a11y tree) of the page at failure time — diagnostic in the ledger; absent in green runs. */
  failure_snapshot?: string;
  /** Dependencies executed before this scenario (depends_on), in order. */
  dependencies?: Array<{ scenario_id: string; cache: CacheOutcome; llm_calls: number; result: "passed" | "failed"; duration_ms: number }>;
  /** `--retries` — total attempts made (present only when the scenario was retried, i.e. > 1). */
  attempts?: number;
  /** `--retries` — true when the scenario ultimately PASSED but needed more than one attempt (a flake worth surfacing). */
  flaky?: boolean;
  /** `scenario.quarantine` — a failure here is reported but does NOT fail the suite (non-blocking). */
  quarantined?: boolean;
}

export const DEFAULT_TIMEOUT_MS = 5000;
export const MAX_TIMEOUT_MS = 30000;
