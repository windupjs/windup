import picomatch from "picomatch";
import type { Browser } from "./browser.js";
import type { Action, ActionMetrics, FailureKind, Plan } from "./types.js";
import { DEFAULT_TIMEOUT_MS } from "./types.js";
import { getContext } from "./context.js";
import { verify } from "./verifier.js";
import { progress, streamEvent } from "./progress.js";

export interface ExecutionFailure {
  kind: FailureKind;
  action_id: string | null;
  message: string;
}

export interface ExecutionResult {
  ok: boolean;
  actions: ActionMetrics[];
  failure: ExecutionFailure | null;
  /** Signature of the start page after the goto (E1); null if it could not be computed. */
  start_sig: string | null;
  /** ms to navigate to start_url and reach a ready page BEFORE the first action (goto + load/hydration) — where the time actually goes in an SPA. */
  nav_ms: number;
}

/**
 * Passive collection for the site map (E2): the executor already visits
 * every page in the flow; observing costs 1 evaluate per action, zero
 * network/LLM. Collection must NEVER take down an execution — errors are
 * swallowed.
 */
export interface StepCollector {
  onPage(obs: { sig: string; url: string; title: string; interactive: string[] }): void;
  onTransition(from: string, action: { type: string; selector: string }, to: string): void;
}

async function observePage(browser: Browser, sig: string, collector: StepCollector): Promise<void> {
  try {
    collector.onPage({
      sig,
      url: browser.url(),
      title: await browser.title(),
      interactive: await browser.interactiveElements(),
    });
  } catch {
    // collection is opportunistic
  }
}

/**
 * Start-page sig: waits for the app to render (SPA: load is not enough)
 * before signing, otherwise the pre-render DOM sig would be unstable.
 */
async function initialSignature(browser: Browser, timeoutMs = 5000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  try {
    // Proceed as soon as EITHER the app renders interactive elements OR the
    // network settles — whichever comes first, capped at timeoutMs. The old
    // code polled only for interactive elements, so a display-only page (no
    // buttons, no pending requests) burned the full timeout on every run; the
    // network-idle branch lets it sign immediately once loaded. Can only be
    // faster, never slower (both are bounded by the same deadline).
    await Promise.race([
      (async () => {
        while ((await browser.interactiveElementsRaw()).length === 0 && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 100));
        }
      })(),
      browser.waitForIdle(timeoutMs),
    ]);
    return await browser.pageSignature();
  } catch {
    return null;
  }
}

const NETWORK_ERROR_PATTERNS = [/net::ERR/i, /ENOTFOUND/i, /ECONNREFUSED/i, /ETIMEDOUT/i, /Timeout.*navigat/i, /navigat.*timeout/i];

function classifyError(err: unknown): FailureKind {
  const message = err instanceof Error ? err.message : String(err);
  return NETWORK_ERROR_PATTERNS.some((p) => p.test(message)) ? "network" : "verification";
}

/** Resolves value/value_ref of a fill action. value_ref is never persisted resolved. */
export function resolveValue(action: Action): string {
  if (action.value !== undefined) return action.value;
  if (action.value_ref !== undefined) {
    const varName = action.value_ref.replace(/^ENV:/, "");
    const resolved = process.env[varName];
    if (resolved === undefined) {
      throw new Error(`value_ref ${action.value_ref}: environment variable ${varName} is not set`);
    }
    return resolved;
  }
  throw new Error(`action ${action.id}: fill has neither value nor value_ref`);
}

async function waitForVisible(browser: Browser, selector: string, timeoutMs: number): Promise<void> {
  if (!(await browser.waitForVisible(selector, timeoutMs))) {
    throw new Error(`element ${selector} did not become visible within ${timeoutMs}ms`);
  }
}

const READINESS_TIMEOUT_MS = 8000;

/** CSS selectors from config.readySignals whose route glob matches this URL's path. Exported for tests. */
export function readySelectorsFor(url: string): string[] {
  const signals = getContext().config.readySignals;
  if (!signals) return [];
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const [glob, sig] of Object.entries(signals)) {
    if (picomatch(glob)(pathname) || picomatch(glob)(pathname.replace(/^\//, ""))) {
      for (const s of Array.isArray(sig) ? sig : [sig]) out.push(s);
    }
  }
  return out;
}

/**
 * #4 — reusable readiness gate. Before the first action on a page whose URL
 * matches a `config.readySignals` glob, wait for the configured selector(s) to
 * be visible. Deterministic, LLM-free, NOT part of the cached plan. Best-effort:
 * a signal that never shows within the timeout warns and proceeds (the action's
 * own actionability wait then applies), so a stale/wrong signal never hard-fails
 * a whole suite. Closes the load-time hydration race that Playwright's per-
 * element wait can't see (element present but handlers not yet attached).
 */
async function awaitReadiness(browser: Browser, scenarioId: string): Promise<void> {
  for (const sel of readySelectorsFor(browser.url())) {
    if (!(await browser.waitForVisible(sel, READINESS_TIMEOUT_MS))) {
      progress(scenarioId, `readiness signal "${sel}" not visible in ${READINESS_TIMEOUT_MS}ms — continuing`);
    }
  }
}

/**
 * #2 — safety denylist check. Returns a human reason if this action would touch
 * a forbidden selector (substring of the plan's CSS selector) or reach a
 * forbidden URL (glob on the path), else null. Author-declared via config.forbid;
 * the engine keeps zero site knowledge. Exported for tests.
 */
export function forbiddenViolation(action: Action, currentUrl: string): string | null {
  const forbid = getContext().config.forbid;
  if (!forbid) return null;
  const urls = [currentUrl, action.type === "goto" ? action.url : undefined].filter((u): u is string => !!u);
  for (const glob of forbid.urls ?? []) {
    const isMatch = picomatch(glob);
    for (const u of urls) {
      let p: string;
      try {
        p = new URL(u).pathname;
      } catch {
        p = u;
      }
      if (isMatch(p) || isMatch(p.replace(/^\//, "")) || isMatch(u)) return `would reach forbidden URL "${u}" (matches "${glob}")`;
    }
  }
  const sel = action.target?.selector;
  if (sel) for (const bad of forbid.selectors ?? []) if (sel.includes(bad)) return `targets forbidden selector "${sel}" (contains "${bad}")`;
  return null;
}

async function performAction(browser: Browser, action: Action, timeoutMs: number): Promise<void> {
  // Arm the native-dialog handler BEFORE the action that opens it: the click
  // that triggers window.confirm blocks until the dialog is handled.
  if (action.dialog) browser.armDialog(action.dialog);
  switch (action.type) {
    case "goto":
      await browser.goto(action.url!);
      return;
    case "click":
      await waitForVisible(browser, action.target!.selector, timeoutMs);
      await browser.click(action.target!.selector);
      return;
    case "fill":
      await waitForVisible(browser, action.target!.selector, timeoutMs);
      await browser.fill(action.target!.selector, resolveValue(action));
      return;
    case "wait_for":
      await waitForVisible(browser, action.target!.selector, timeoutMs);
      return;
  }
}

/** Pause between actions for visual follow-along (SLOWMO_MS); 0 = off. Read per call (the CLI sets it via --slowmo). */
const SLOWMO_MS = () => Number.parseInt(process.env.SLOWMO_MS ?? "0", 10) || 0;

/**
 * Deterministic loop from doc 03: navigates to start_url and executes the
 * plan's actions in order, verifying postconditions after each one. Zero LLM.
 */
export interface ExecuteOptions {
  /** true = dependent scenario without start_url: continues from the CURRENT page (the dependencies' final state IS the start). */
  skipInitialGoto?: boolean;
}

export async function executePlan(browser: Browser, plan: Plan, collector?: StepCollector, opts: ExecuteOptions = {}): Promise<ExecutionResult> {
  const metrics: ActionMetrics[] = [];
  const navStart = Date.now();

  if (!opts.skipInitialGoto) {
    try {
      await browser.goto(plan.start_url);
    } catch (err) {
      return {
        ok: false,
        actions: metrics,
        failure: { kind: "network", action_id: null, message: `goto ${plan.start_url}: ${err instanceof Error ? err.message : err}` },
        start_sig: null,
        nav_ms: Date.now() - navStart,
      };
    }
  }

  // #4 readiness gate: wait for the start page's configured signal(s) before we
  // even sample the signature or run a1 (closes the on-load hydration race).
  let readiedUrl: string | null = null;
  await awaitReadiness(browser, plan.scenario_id);
  readiedUrl = browser.url();

  const startSig = await initialSignature(browser);
  if (collector && startSig) await observePage(browser, startSig, collector);
  let currentSig = startSig;
  // Everything up to here is "navigation": goto + readiness + load/hydration
  // (the signature wait blocks until interactive elements appear) + first observe.
  const navMs = Date.now() - navStart;

  // Guard the landing page itself (covers a plan with no actions).
  const landing = forbiddenViolation({ id: "start", type: "goto" } as Action, browser.url());
  if (landing) {
    return { ok: false, actions: metrics, failure: { kind: "forbidden", action_id: null, message: `blocked by config.forbid — ${landing}` }, start_sig: startSig, nav_ms: navMs };
  }

  for (const action of plan.actions) {
    // A prior action may have navigated to a new route — ready it before acting.
    if (browser.url() !== readiedUrl) {
      await awaitReadiness(browser, plan.scenario_id);
      readiedUrl = browser.url();
    }
    // #2 safety denylist: abort BEFORE performing an action that would touch a
    // forbidden selector or reach a forbidden URL (config.forbid) — the CI
    // guardrail against irreversible side effects.
    const violation = forbiddenViolation(action, browser.url());
    if (violation) {
      progress(plan.scenario_id, `blocked by config.forbid — ${violation}`);
      streamEvent(plan.scenario_id, "action", { id: action.id, type: action.type, status: "failed", reason: "forbidden" });
      return { ok: false, actions: metrics, failure: { kind: "forbidden", action_id: action.id, message: `blocked by config.forbid — ${violation}` }, start_sig: startSig, nav_ms: navMs };
    }
    const timeoutMs = action.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    const started = Date.now();
    if (process.env.LOG_LEVEL === "debug") {
      console.error(`[executor] ${action.id} ${action.type} ${action.target?.selector ?? action.url ?? ""} | url=${browser.url()}`);
    }

    try {
      await performAction(browser, action, timeoutMs);
    } catch (err) {
      const duration = Date.now() - started;
      progress(plan.scenario_id, `${action.id} ${action.type} ✗ ${err instanceof Error ? err.message.split("\n")[0] : ""}`);
      metrics.push({ id: action.id, duration_ms: duration, verify_ms: 0, status: "failed" });
      return {
        ok: false,
        actions: metrics,
        failure: {
          kind: classifyError(err),
          action_id: action.id,
          message: err instanceof Error ? err.message : String(err),
        },
        start_sig: startSig,
        nav_ms: navMs,
      };
    }

    const actionMs = Date.now() - started;
    const result = await verify(browser, action.expect, timeoutMs);
    metrics.push({
      id: action.id,
      duration_ms: actionMs,
      verify_ms: result.verify_ms,
      status: result.ok ? "passed" : "failed",
    });

    if (!result.ok) {
      progress(plan.scenario_id, `${action.id} ${action.type} ✗ verification failed`);
      streamEvent(plan.scenario_id, "action", { id: action.id, type: action.type, status: "failed", reason: "verification" });
      return {
        ok: false,
        actions: metrics,
        failure: {
          kind: "verification",
          action_id: action.id,
          message: `postcondition failed: ${result.failed_condition}`,
        },
        start_sig: startSig,
        nav_ms: navMs,
      };
    }

    progress(plan.scenario_id, `${action.id} ${action.type} ${action.target?.selector ?? action.url ?? ""} ✓`);
    streamEvent(plan.scenario_id, "action", { id: action.id, type: action.type, status: "passed" });

    if (collector) {
      try {
        const sig = await browser.pageSignature();
        if (sig && sig !== currentSig) {
          await observePage(browser, sig, collector);
          if (currentSig) {
            collector.onTransition(
              currentSig,
              { type: action.type, selector: action.target?.selector ?? action.url ?? "" },
              sig,
            );
          }
          currentSig = sig;
        }
      } catch {
        // collection is opportunistic
      }
    }

    if (SLOWMO_MS() > 0) await new Promise((r) => setTimeout(r, SLOWMO_MS()));
  }

  return { ok: true, actions: metrics, failure: null, start_sig: startSig, nav_ms: navMs };
}
