import picomatch from "picomatch";
import type { NetworkRule } from "./config.js";

/**
 * Validates `config.network` (returns human-readable errors, empty when ok).
 * Consumed eagerly by the runner so a malformed rule fails loud, not silently.
 */
export function validateNetwork(rules: unknown): string[] {
  if (rules === undefined) return [];
  if (!Array.isArray(rules)) return ["config.network must be an array of rules"];
  const errors: string[] = [];
  rules.forEach((r, i) => {
    const p = `config.network[${i}]`;
    if (typeof r !== "object" || r === null) { errors.push(`${p} must be an object`); return; }
    const rule = r as NetworkRule;
    if (typeof rule.url !== "string" || !rule.url) errors.push(`${p}.url must be a non-empty string (a substring or glob of the request URL)`);
    if (rule.method !== undefined && typeof rule.method !== "string") errors.push(`${p}.method must be a string (GET, POST, …)`);
    if (rule.status !== undefined && (typeof rule.status !== "number" || rule.status < 100 || rule.status > 599)) errors.push(`${p}.status must be an HTTP status 100–599`);
    if (rule.body !== undefined && typeof rule.body !== "string") errors.push(`${p}.body must be a string (use "json" for objects)`);
    if (rule.abort && (rule.status !== undefined || rule.body !== undefined || rule.json !== undefined)) errors.push(`${p}: "abort" cannot be combined with a response (status/body/json)`);
  });
  return errors;
}

/**
 * Merge a scenario's network rules over the global `config.network`: scenario
 * rules come FIRST so they win on overlapping URLs (`matchRule` takes the first
 * match), with global rules falling through. Returns `undefined` when neither
 * side declares any (so the caller can leave the global config path untouched).
 */
export function effectiveNetwork(
  scenarioRules: NetworkRule[] | undefined,
  globalRules: NetworkRule[] | undefined,
): NetworkRule[] | undefined {
  if (!scenarioRules?.length) return globalRules;
  return [...scenarioRules, ...(globalRules ?? [])];
}

/** The first rule whose method (if any) and url (substring or glob) match the request — or null. */
export function matchRule(rules: NetworkRule[], url: string, method: string): NetworkRule | null {
  for (const rule of rules) {
    if (rule.method && rule.method.toUpperCase() !== method.toUpperCase()) continue;
    if (urlMatches(rule.url, url)) return rule;
  }
  return null;
}

function urlMatches(pattern: string, url: string): boolean {
  if (url.includes(pattern)) return true; // cheap substring match first
  try {
    return picomatch(pattern, { dot: true })(url);
  } catch {
    return false;
  }
}
