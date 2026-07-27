export interface WebVitals {
  ttfb_ms: number | null;
  fcp_ms: number | null;
  lcp_ms: number | null;
  dcl_ms: number | null;
  load_ms: number | null;
  cls: number | null;
}

export interface Budgets {
  ttfb_ms?: number;
  fcp_ms?: number;
  lcp_ms?: number;
  dcl_ms?: number;
  load_ms?: number;
  cls?: number;
}

/** Injected before any page script: observe LCP + CLS into window.__wv (buffered so early entries count). */
export const VITALS_INIT_SCRIPT = `(() => {
  window.__wv = { lcp: 0, cls: 0 };
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__wv.lcp = e.startTime; })
      .observe({ type: "largest-contentful-paint", buffered: true });
    new PerformanceObserver((l) => { for (const e of l.getEntries()) { if (!e.hadRecentInput) window.__wv.cls += e.value; } })
      .observe({ type: "layout-shift", buffered: true });
  } catch (_) { /* unsupported entry type — vitals stay 0/null */ }
})();`;

/**
 * Read on the final page: navigation timing + FCP + the observed LCP/CLS.
 * A plain interpolation-free STRING expression (not a function) so no build-time
 * transform can rewrite it — `page.evaluate` runs it verbatim in the page.
 */
export const READ_VITALS_SCRIPT = `(() => {
  var nav = performance.getEntriesByType("navigation")[0];
  var paint = performance.getEntriesByType("paint").filter(function (p) { return p.name === "first-contentful-paint"; })[0];
  var wv = window.__wv || {};
  var round = function (n) { return n && n > 0 ? Math.round(n) : null; };
  return {
    ttfb_ms: round(nav && nav.responseStart),
    fcp_ms: round(paint && paint.startTime),
    lcp_ms: round(wv.lcp),
    dcl_ms: round(nav && nav.domContentLoadedEventEnd),
    load_ms: round(nav && nav.loadEventEnd),
    cls: typeof wv.cls === "number" && wv.cls >= 0 ? Number(wv.cls.toFixed(4)) : null,
  };
})();`;

const LABEL: Record<keyof Budgets, string> = {
  ttfb_ms: "TTFB", fcp_ms: "FCP", lcp_ms: "LCP", dcl_ms: "DCL", load_ms: "load", cls: "CLS",
};

/** Human-readable budget violations (empty when within budget or nothing to compare). */
export function budgetViolations(vitals: WebVitals | null | undefined, budgets: Budgets | undefined): string[] {
  if (!vitals || !budgets) return [];
  const out: string[] = [];
  for (const key of Object.keys(budgets) as Array<keyof Budgets>) {
    const limit = budgets[key];
    const actual = vitals[key as keyof WebVitals];
    if (limit === undefined || actual == null) continue;
    if (actual > limit) out.push(`${LABEL[key]} ${actual}${key === "cls" ? "" : "ms"} > budget ${limit}${key === "cls" ? "" : "ms"}`);
  }
  return out;
}

/** Validate config.budgets shape (returns human-readable errors, empty when ok). */
export function validateBudgets(budgets: unknown): string[] {
  if (budgets === undefined) return [];
  if (typeof budgets !== "object" || budgets === null) return ["config.budgets must be an object { lcp_ms?, cls?, … }"];
  const errors: string[] = [];
  const allowed = new Set(["ttfb_ms", "fcp_ms", "lcp_ms", "dcl_ms", "load_ms", "cls"]);
  for (const [k, v] of Object.entries(budgets)) {
    if (!allowed.has(k)) errors.push(`config.budgets: unknown key "${k}" (use ${[...allowed].join(", ")})`);
    else if (typeof v !== "number" || v < 0) errors.push(`config.budgets.${k} must be a non-negative number`);
  }
  return errors;
}
