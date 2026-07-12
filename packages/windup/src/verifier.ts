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
  // picomatch trata "/" como separador; URLs completas casam com padrões "**/...".
  // O pathname cobre padrões escritos como caminho puro ("/dashboard/index").
  let pathname = "";
  try {
    pathname = new URL(clean).pathname;
  } catch {
    // current não é URL absoluta; segue só com as outras formas
  }
  return isMatch(clean) || isMatch(clean.replace(/^https?:\/\//, "")) || (pathname !== "" && isMatch(pathname));
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

  const deadline = started + timeoutMs;
  const remaining = () => Math.max(POLL_INTERVAL_MS, deadline - Date.now());
  const fail = (condition: string): VerifyResult => ({
    ok: false,
    verify_ms: Date.now() - started,
    failed_condition: condition,
  });

  if (expect.url) {
    while (!urlMatches(browser.url(), expect.url)) {
      if (Date.now() + POLL_INTERVAL_MS > deadline) {
        return fail(`url: expected ${expect.url}, got ${browser.url()}`);
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  }

  if (expect.selector) {
    // waitForVisible nativo acompanha navegações/frames (polling de isVisible
    // sobre frame obsoleto falhava após navegação com pausas longas).
    if (!(await browser.waitForVisible(expect.selector, remaining()))) {
      return fail(`selector: ${expect.selector} not visible`);
    }
  }

  if (expect.selector_value) {
    const { selector, value } = expect.selector_value;
    while (true) {
      let actual: string | null = null;
      try {
        actual = await browser.inputValue(selector);
      } catch {
        actual = null;
      }
      if (actual === value) break;
      if (Date.now() + POLL_INTERVAL_MS > deadline) {
        return fail(`selector_value: ${selector} expected "${value}", got "${actual ?? "(missing)"}"`);
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  }

  return { ok: true, verify_ms: Date.now() - started, failed_condition: null };
}
