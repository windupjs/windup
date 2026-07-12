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
}

const NETWORK_ERROR_PATTERNS = [/net::ERR/i, /ENOTFOUND/i, /ECONNREFUSED/i, /ETIMEDOUT/i, /Timeout.*navigat/i, /navigat.*timeout/i];

function classifyError(err: unknown): FailureKind {
  const message = err instanceof Error ? err.message : String(err);
  return NETWORK_ERROR_PATTERNS.some((p) => p.test(message)) ? "network" : "verification";
}

/** Resolve value/value_ref de uma ação fill. value_ref nunca é persistido resolvido. */
export function resolveValue(action: Action): string {
  if (action.value !== undefined) return action.value;
  if (action.value_ref !== undefined) {
    const varName = action.value_ref.replace(/^ENV:/, "");
    const resolved = process.env[varName];
    if (resolved === undefined) {
      throw new Error(`value_ref ${action.value_ref}: variável de ambiente ${varName} não definida`);
    }
    return resolved;
  }
  throw new Error(`ação ${action.id}: fill sem value nem value_ref`);
}

async function waitForVisible(browser: Browser, selector: string, timeoutMs: number): Promise<void> {
  if (!(await browser.waitForVisible(selector, timeoutMs))) {
    throw new Error(`elemento ${selector} não ficou visível em ${timeoutMs}ms`);
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

/** Pausa entre ações para acompanhamento visual (SLOWMO_MS); 0 = desligado. */
const SLOWMO_MS = Number.parseInt(process.env.SLOWMO_MS ?? "0", 10) || 0;

/**
 * Loop determinístico do doc 03: navega para start_url e executa as ações
 * do plano em ordem, verificando pós-condições após cada uma. Zero LLM.
 */
export async function executePlan(browser: Browser, plan: Plan): Promise<ExecutionResult> {
  const metrics: ActionMetrics[] = [];

  try {
    await browser.goto(plan.start_url);
  } catch (err) {
    return {
      ok: false,
      actions: metrics,
      failure: { kind: "network", action_id: null, message: `goto ${plan.start_url}: ${err instanceof Error ? err.message : err}` },
    };
  }

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
          message: `pós-condição falhou: ${result.failed_condition}`,
        },
      };
    }

    if (SLOWMO_MS > 0) await new Promise((r) => setTimeout(r, SLOWMO_MS));
  }

  return { ok: true, actions: metrics, failure: null };
}
