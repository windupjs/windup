import { existsSync } from "node:fs";
import { getCached } from "./cache.js";
import { getContext } from "./context.js";
import { expandPlan, loadFragments } from "./fragments.js";
import { PROVIDER_DEFAULTS, resolveLlm } from "./llm.js";
import { discoverScenarioIds, loadScenario } from "./scenario.js";
import { SiteMapStore } from "./sitemap.js";

export type CheckStatus = "ok" | "warn" | "fail";
export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
}

/**
 * Preflight: static checks that catch the common "it'll break in CI" problems
 * before a run — no browser launch, no LLM, no network. Fails (non-zero) only on
 * genuinely broken state (invalid scenarios, orphaned fragments); missing keys /
 * unscanned map are warnings (replays still run $0).
 */
export async function runDoctor(): Promise<Check[]> {
  const ctx = getContext();
  const checks: Check[] = [];

  // 1. LLM key for the active provider. Replays never need it; planning does.
  try {
    const { provider } = resolveLlm();
    const env = ctx.config.llm.providers?.[provider]?.apiKeyEnv ?? PROVIDER_DEFAULTS[provider].apiKeyEnv;
    if (PROVIDER_DEFAULTS[provider].apiKeyOptional) checks.push({ name: "llm", status: "ok", detail: `provider "${provider}" (no API key needed)` });
    else if (process.env[env]) checks.push({ name: "llm", status: "ok", detail: `provider "${provider}", ${env} is set` });
    else checks.push({ name: "llm", status: "warn", detail: `provider "${provider}": ${env} not set — cached replays still run ($0), but planning a cache miss will fail` });
  } catch (e) {
    checks.push({ name: "llm", status: "warn", detail: `could not resolve provider: ${e instanceof Error ? e.message : e}` });
  }

  // 2. Browser binary present (Windup also auto-downloads chromium on first run).
  try {
    const { chromium } = await import("playwright-core");
    const exe = process.env.CHROME_PATH ?? chromium.executablePath();
    checks.push(exe && existsSync(exe)
      ? { name: "browser", status: "ok", detail: `chromium at ${exe}` }
      : { name: "browser", status: "warn", detail: "chromium not found — run: npx playwright install chromium (or it auto-downloads on first run)" });
  } catch (e) {
    checks.push({ name: "browser", status: "warn", detail: `could not resolve chromium: ${e instanceof Error ? e.message : e}` });
  }

  // 3. Every scenario parses/validates.
  const ids = await discoverScenarioIds();
  const bad: string[] = [];
  for (const id of ids) {
    try {
      await loadScenario(id);
    } catch (e) {
      bad.push(`${id} (${e instanceof Error ? e.message.split("\n")[0] : e})`);
    }
  }
  if (ids.length === 0) checks.push({ name: "scenarios", status: "warn", detail: `none found in ${ctx.paths.scenariosDir}` });
  else if (bad.length) checks.push({ name: "scenarios", status: "fail", detail: `${bad.length} invalid: ${bad.join("; ")}` });
  else checks.push({ name: "scenarios", status: "ok", detail: `${ids.length} valid` });

  // 4. No cached plan references a fragment that no longer exists (orphan).
  const fragments = await loadFragments();
  const orphans: string[] = [];
  for (const id of ids) {
    try {
      const cached = await getCached(await loadScenario(id));
      if (cached) expandPlan(cached.plan, fragments); // throws on an orphaned { use }
    } catch (e) {
      if (e instanceof Error && /fragment/i.test(e.message)) orphans.push(`${id}: ${e.message}`);
    }
  }
  checks.push(orphans.length
    ? { name: "fragments", status: "fail", detail: `orphaned reference(s): ${orphans.join("; ")}` }
    : { name: "fragments", status: "ok", detail: `${fragments.length} fragment(s), no orphaned references` });

  // 4b. config.network / config.clock are well-formed (validated lazily at run — surface it here too).
  const { validateNetwork } = await import("./network.js");
  const { validateClock } = await import("./clock.js");
  const cfgErrors = [...validateNetwork(ctx.config.network), ...validateClock(ctx.config.clock)];
  if (ctx.config.network || ctx.config.clock) {
    checks.push(cfgErrors.length
      ? { name: "config", status: "fail", detail: cfgErrors.join("; ") }
      : { name: "config", status: "ok", detail: `${ctx.config.network ? `network: ${ctx.config.network.length} rule(s)` : ""}${ctx.config.network && ctx.config.clock ? ", " : ""}${ctx.config.clock ? "clock set" : ""}` });
  }

  // 5. Site map scanned — planning and `windup coverage` are weaker without it.
  const map = await SiteMapStore.load(ctx.paths.mapFile);
  checks.push(map.pageCount > 0
    ? { name: "site map", status: "ok", detail: `${map.pageCount} route(s) indexed${map.lastScanSha ? "" : " (observed from runs; `windup scan` adds static routes)"}` }
    : { name: "site map", status: "warn", detail: "empty — run `windup scan` so the planner and `windup coverage` know the app's routes" });

  return checks;
}

/** Prints the checks; returns false if any hard-failed (caller sets a non-zero exit). */
export function printDoctor(checks: Check[]): boolean {
  const icon = { ok: "✓", warn: "!", fail: "✗" } as const;
  for (const c of checks) console.log(`  ${icon[c.status]} ${c.name.padEnd(11)} ${c.detail}`);
  const failed = checks.some((c) => c.status === "fail");
  const warned = checks.some((c) => c.status === "warn");
  console.log(failed ? "\ndoctor: problems found ✗" : warned ? "\ndoctor: ready, with warnings" : "\ndoctor: all good ✓");
  return !failed;
}
