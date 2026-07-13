import type { Browser } from "./browser.js";
import type { Action, ActionMetrics, FailureKind, Plan } from "./types.js";
import { DEFAULT_TIMEOUT_MS } from "./types.js";
import { verify } from "./verifier.js";

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
    while ((await browser.interactiveElementsRaw()).length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
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

async function performAction(browser: Browser, action: Action, timeoutMs: number): Promise<void> {
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

  if (!opts.skipInitialGoto) {
    try {
      await browser.goto(plan.start_url);
    } catch (err) {
      return {
        ok: false,
        actions: metrics,
        failure: { kind: "network", action_id: null, message: `goto ${plan.start_url}: ${err instanceof Error ? err.message : err}` },
        start_sig: null,
      };
    }
  }

  const startSig = await initialSignature(browser);
  if (collector && startSig) await observePage(browser, startSig, collector);
  let currentSig = startSig;

  for (const action of plan.actions) {
    const timeoutMs = action.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    const started = Date.now();
    if (process.env.LOG_LEVEL === "debug") {
      console.error(`[executor] ${action.id} ${action.type} ${action.target?.selector ?? action.url ?? ""} | url=${browser.url()}`);
    }

    try {
      await performAction(browser, action, timeoutMs);
    } catch (err) {
      const duration = Date.now() - started;
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
      return {
        ok: false,
        actions: metrics,
        failure: {
          kind: "verification",
          action_id: action.id,
          message: `postcondition failed: ${result.failed_condition}`,
        },
        start_sig: startSig,
      };
    }

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

  return { ok: true, actions: metrics, failure: null, start_sig: startSig };
}
