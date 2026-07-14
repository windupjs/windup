import { getContext } from "./context.js";
import { WindupError } from "./errors.js";

/**
 * Effective start URL for a scenario. Environments move (port, host, staging
 * vs local), tests don't: the scenario carries at most a PATH-shaped intent,
 * and the origin comes from (in precedence order):
 *
 *   1. --base-url flag / WINDUP_BASE_URL env  (rebases even absolute URLs)
 *   2. windup.config baseUrl                  (for relative/missing start_url)
 *   3. the scenario's own absolute start_url  (fallback)
 */
export function resolveStartUrl(rawStartUrl: string | undefined): string {
  const raw = rawStartUrl?.trim() || "/";
  const override = process.env.WINDUP_BASE_URL?.trim();
  const configBase = getContext().config.baseUrl?.trim();
  const base = override || configBase;

  if (/^https?:\/\//i.test(raw)) {
    // Absolute in the scenario: an explicit override still rebases the origin.
    if (override) return new URL(startPath(raw), override).toString();
    return raw;
  }
  if (!base) {
    throw new WindupError(`start_url "${raw}" is relative and no base URL is configured (set baseUrl in windup.config, WINDUP_BASE_URL or --base-url)`);
  }
  return new URL(raw.startsWith("/") ? raw : `/${raw}`, base).toString();
}

/** Path+query+hash portion — the environment-independent identity of a start URL. */
export function startPath(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}${u.hash}` || "/";
  } catch {
    return url.startsWith("/") ? url : `/${url}`;
  }
}
