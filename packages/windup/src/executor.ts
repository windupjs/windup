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
  /** Assinatura da página inicial após o goto (E1); null se não pôde ser calculada. */
  start_sig: string | null;
}

/**
 * Coleta passiva para o mapa do site (E2): o executor já passa por cada
 * página do fluxo; observar custa 1 evaluate por ação, zero rede/LLM.
 * A coleta NUNCA pode derrubar uma execução — erros são engolidos.
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
    // coleta é oportunista
  }
}

/**
 * Sig da página inicial: espera o app renderizar (SPA: load não basta) antes
 * de assinar, senão a sig do DOM pré-render seria instável.
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

/** Resolve value/value_ref de uma ação fill. value_ref nunca é persistido resolvido. */
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

/** Pausa entre ações para acompanhamento visual (SLOWMO_MS); 0 = desligado. Lido por chamada (a CLI seta via --slowmo). */
const SLOWMO_MS = () => Number.parseInt(process.env.SLOWMO_MS ?? "0", 10) || 0;

/**
 * Loop determinístico do doc 03: navega para start_url e executa as ações
 * do plano em ordem, verificando pós-condições após cada uma. Zero LLM.
 */
export async function executePlan(browser: Browser, plan: Plan, collector?: StepCollector): Promise<ExecutionResult> {
  const metrics: ActionMetrics[] = [];

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
        // coleta é oportunista
      }
    }

    if (SLOWMO_MS() > 0) await new Promise((r) => setTimeout(r, SLOWMO_MS()));
  }

  return { ok: true, actions: metrics, failure: null, start_sig: startSig };
}
