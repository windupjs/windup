import picomatch from "picomatch";
import type { Browser } from "./browser.js";
import type { Expect } from "./types.js";

const POLL_INTERVAL_MS = 100;

export interface VerifyResult {
  ok: boolean;
  verify_ms: number;
  /** Qual condição falhou (para diagnóstico), null se passou. */
  failed_condition: string | null;
}

/**
 * Casa a URL atual contra o glob do plano (ex.: "**\/inventory.html").
 * Query string e hash são ignorados no casamento.
 */
export function urlMatches(current: string, pattern: string): boolean {
  const clean = current.split(/[?#]/)[0];
  const isMatch = picomatch(pattern, { dot: true });
  // picomatch trata "/" como separador; URLs completas casam com padrões "**/..."
  return isMatch(clean) || isMatch(clean.replace(/^https?:\/\//, ""));
}

/**
 * Verifica as pós-condições de uma ação com polling até timeout_ms.
 * Todas as condições presentes devem passar (AND). Sem LLM — só DOM/URL.
 */
export async function verify(
  browser: Browser,
  expect: Expect | undefined,
  timeoutMs: number,
): Promise<VerifyResult> {
  const started = Date.now();
  if (!expect || (!expect.selector && !expect.url && !expect.selector_value)) {
    return { ok: true, verify_ms: 0, failed_condition: null };
  }

  let failed: string | null = null;
  const deadline = started + timeoutMs;

  while (true) {
    failed = null;

    if (expect.url && !urlMatches(browser.url(), expect.url)) {
      failed = `url: esperado ${expect.url}, atual ${browser.url()}`;
    }
    if (!failed && expect.selector && !(await browser.isVisible(expect.selector))) {
      failed = `selector: ${expect.selector} não visível`;
    }
    if (!failed && expect.selector_value) {
      const { selector, value } = expect.selector_value;
      let actual: string | null = null;
      try {
        actual = await browser.inputValue(selector);
      } catch {
        actual = null;
      }
      if (actual !== value) {
        failed = `selector_value: ${selector} esperado "${value}", atual "${actual ?? "(inexistente)"}"`;
      }
    }

    if (!failed) {
      return { ok: true, verify_ms: Date.now() - started, failed_condition: null };
    }
    if (Date.now() + POLL_INTERVAL_MS > deadline) {
      return { ok: false, verify_ms: Date.now() - started, failed_condition: failed };
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}
