import picomatch from "picomatch";
import type { Browser } from "./browser.js";
import type { Action, ActionMetrics, FailureKind, Plan } from "./types.js";
import { DEFAULT_TIMEOUT_MS } from "./types.js";
import { getContext } from "./context.js";
import type { WindupConfig } from "./config.js";
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

/**
 * Run-scoped resolver context: the config-declared dynamic-value sources and a
 * per-run cache of already-resolved values. Values are EPHEMERAL — held only
 * here, never cached, reported or logged.
 */
export interface ResolverContext {
  resolvers?: WindupConfig["resolve"];
  /** Deterministic selector-substring → resolver name binding (config.resolveFields). */
  resolveFields?: Record<string, string>;
  vars: Map<string, string>;
}

/** Find a declared resolver by name, tolerating the LLM's casing/dashes (OTP_CODE / otp-code → otp_code). */
function findResolver(ref: string, resolvers?: WindupConfig["resolve"]): string | null {
  if (!resolvers) return null;
  if (resolvers[ref]) return ref;
  const norm = ref.toLowerCase().replace(/-/g, "_");
  if (resolvers[norm]) return norm;
  const hit = Object.keys(resolvers).find((k) => k.toLowerCase().replace(/-/g, "_") === norm);
  return hit ?? null;
}

/** Resolve a "ENV:NAME" env var or a `config.resolve` name (fetched + polled once per run, then cached in-memory). */
async function resolveRef(ref: string, ctx: ResolverContext): Promise<string> {
  if (ref.startsWith("ENV:")) {
    const name = ref.slice(4);
    const v = process.env[name];
    if (v === undefined) throw new Error(`value_ref ENV:${name}: environment variable is not set`);
    return v;
  }
  const name = findResolver(ref, ctx.resolvers) ?? ref;
  const cached = ctx.vars.get(name);
  if (cached !== undefined) return cached;
  const spec = ctx.resolvers?.[name];
  if (!spec) throw new Error(`value_ref "${ref}": no such env var (use ENV:${ref}) and no resolver named "${ref}" in config.resolve`);
  const { runResolver } = await import("./resolvers.js");
  const value = await runResolver(name, spec);
  ctx.vars.set(name, value);
  return value;
}

/** The resolver a field is deterministically bound to (config.resolveFields), if any — by selector substring. */
function boundResolver(selector: string, ctx: ResolverContext): string | null {
  if (!ctx.resolveFields) return null;
  for (const [key, resolver] of Object.entries(ctx.resolveFields)) if (selector.includes(key)) return resolver;
  return null;
}

/** Resolves value/value_ref of a fill action (async — value_ref may fetch a runtime value). Never persisted resolved. */
export async function resolveValue(action: Action, ctx: ResolverContext): Promise<string> {
  if (action.value !== undefined) return action.value;
  if (action.value_ref !== undefined) return resolveRef(action.value_ref, ctx);
  throw new Error(`action ${action.id}: fill has neither value nor value_ref`);
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

/** Human label for the report: WHAT the action did. Never a fill's value (secrets/OTP stay out). */
function actionLabel(action: Action): string {
  if (action.type === "goto") return `→ ${action.url ?? (action.url_ref ? `{${action.url_ref}}` : "")}`;
  if (action.type === "use") return `use ${action.use ?? ""}`;
  const target = action.target?.description || action.target?.selector || "";
  if (action.type === "fill") return `${target}${action.value_ref ? ` = {${action.value_ref}}` : ""}`; // {ref} is a name, not the value
  return target;
}

/** Message when a target can't be found — flags the likely a11y gap (the field a screen reader also can't find). */
function notFound(selector: string, description?: string): Error {
  return new Error(
    description
      ? `element ${selector} not found, and no single field matches "${description}" by label/placeholder/role — the control likely has no accessible label (a11y gap). Anchor it with a hint.`
      : `element ${selector} did not become visible within the timeout`,
  );
}

/** Runs an action. Returns a note when an accessibility fallback recovered the target (the plan's selector was wrong but the field has a label). */
async function performAction(browser: Browser, action: Action, timeoutMs: number, ctx: ResolverContext): Promise<string | undefined> {
  // Arm the native-dialog handler BEFORE the action that opens it (unless a
  // scenario-level on_dialog default already handles every dialog).
  if (action.dialog) browser.armDialog(action.dialog);
  const sel = action.target?.selector;
  const desc = action.target?.description;
  switch (action.type) {
    case "goto":
      // url_ref resolves a runtime URL (e.g. a magic-link) via config.resolve.
      await browser.goto(action.url_ref ? await resolveRef(action.url_ref, ctx) : action.url!);
      return;
    case "click":
      if (await browser.waitForVisible(sel!, timeoutMs)) { await browser.click(sel!); return; }
      if (desc && (await browser.clickByDescription(desc))) return `≈ found "${desc}" by label (plan selector "${sel}" missed)`;
      throw notFound(sel!, desc);
    case "fill": {
      // A field bound in config.resolveFields is ALWAYS filled from its resolver,
      // overriding whatever the plan put there — deterministic OTP/token.
      const bound = boundResolver(sel!, ctx);
      const value = bound ? await resolveRef(bound, ctx) : await resolveValue(action, ctx);
      if (await browser.waitForVisible(sel!, timeoutMs)) { await browser.fill(sel!, value); return; }
      if (desc && (await browser.fillByDescription(desc, value))) return `≈ found "${desc}" by label (plan selector "${sel}" missed)`;
      throw notFound(sel!, desc);
    }
    case "wait_for":
      if (await browser.waitForVisible(sel!, timeoutMs)) return;
      if (desc && (await browser.isVisibleByDescription(desc))) return `≈ found "${desc}" by label (plan selector "${sel}" missed)`;
      throw notFound(sel!, desc);
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
  // Ephemeral per-run resolver context for dynamic values (OTP/magic-link, etc.).
  const cfg = getContext().config;
  const resolverCtx: ResolverContext = { resolvers: cfg.resolve, resolveFields: cfg.resolveFields, vars: new Map() };
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

    let recovered: string | undefined;
    try {
      recovered = await performAction(browser, action, timeoutMs, resolverCtx);
      if (recovered) progress(plan.scenario_id, `${action.id} ${recovered}`);
    } catch (err) {
      const duration = Date.now() - started;
      progress(plan.scenario_id, `${action.id} ${action.type} ✗ ${err instanceof Error ? err.message.split("\n")[0] : ""}`);
      metrics.push({ id: action.id, type: action.type, label: actionLabel(action), duration_ms: duration, verify_ms: 0, status: "failed" });
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
      type: action.type,
      label: actionLabel(action),
      ...(recovered ? { note: recovered } : {}),
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
