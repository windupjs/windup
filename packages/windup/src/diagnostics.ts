/**
 * Pure helpers for runtime-health diagnostics (#diagnostics / config.failOn).
 * Kept out of browser.ts so the classification and ignore-matching are unit-
 * testable without a real Playwright page.
 */

/**
 * A Chromium sub-resource load failure logs the generic
 * "Failed to load resource: the server responded with a status of NNN ()" —
 * the noisy 4xx kind (broken image, missing font, a Gravatar `d=404`). Everything
 * else that reaches the error console (uncaught exceptions, `console.error`, CSP
 * violations) is a real page/JS error. The distinction lets `failOn.consoleErrors`
 * gate JS health without drowning in resource 404s (`failOn.resourceErrors`).
 */
export function classifyConsoleError(message: string): "js" | "resource" {
  return /failed to load resource/i.test(message) ? "resource" : "js";
}

/**
 * True when any `failOn.ignore` substring appears in ANY of the given parts
 * (the console message AND its originating URL). Matching the URL is the fix for
 * resource errors whose console text is the generic string with no URL in it —
 * `ignore: ["gravatar.com"]` still silences them via `location().url`.
 */
export function matchesIgnore(ignore: string[], ...parts: Array<string | undefined>): boolean {
  return ignore.some((s) => parts.some((p) => p !== undefined && p.includes(s)));
}
