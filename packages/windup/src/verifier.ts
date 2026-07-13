import picomatch from "picomatch";
import type { Browser } from "./browser.js";
import type { Expect } from "./types.js";

const POLL_INTERVAL_MS = 100;

export interface VerifyResult {
  ok: boolean;
  verify_ms: number;
  /** Which condition failed (for diagnostics), null if it passed. */
  failed_condition: string | null;
}

/**
 * Matches the current URL against the plan's glob (e.g. "**\/inventory.html").
 * Query string and hash are ignored in the match.
 */
export function urlMatches(current: string, pattern: string): boolean {
  const clean = current.split(/[?#]/)[0];
  const isMatch = picomatch(pattern, { dot: true });
  // picomatch treats "/" as a separator; full URLs match "**/..." patterns.
  // The pathname covers patterns written as a bare path ("/dashboard/index").
  let pathname = "";
  try {
    pathname = new URL(clean).pathname;
  } catch {
    // current is not an absolute URL; proceed with the other forms only
  }
  return isMatch(clean) || isMatch(clean.replace(/^https?:\/\//, "")) || (pathname !== "" && isMatch(pathname));
}

/**
 * Verifies an action's postconditions, polling until timeout_ms.
 * Every condition present must pass (AND). No LLM — DOM/URL only.
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
    // Native waitForVisible tracks navigations/frames (polling isVisible on
    // a stale frame failed after navigation with long pauses).
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
