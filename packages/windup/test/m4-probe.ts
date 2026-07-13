/**
 * M4 — cache + runner with a fake planner (no LLM).
 * 1) miss → executes and writes the cache
 * 2) hit → replay with llm_calls=0
 * 3) broken selector in the cache → invalidates (stale) → re-plans (fake) → overwrites
 *
 * Run: npx tsx test/m4-probe.ts
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { cacheDir, clearCache } from "../src/cache.js";
import { runScenario, type Planner } from "../src/runner.js";
import { loadScenario } from "../src/scenario.js";
import type { CacheEntry, Plan } from "../src/types.js";

const plan: Plan = {
  plan_version: "0.1",
  scenario_id: "saucedemo-login",
  start_url: "https://www.saucedemo.com",
  actions: [
    { id: "a1", type: "fill", target: { selector: "#user-name", description: "username field" }, value: "standard_user", timeout_ms: 5000 },
    { id: "a2", type: "fill", target: { selector: "#password", description: "password field" }, value: "secret_sauce", timeout_ms: 5000 },
    { id: "a3", type: "click", target: { selector: "#login-button", description: "login button" }, expect: { url: "**/inventory.html", selector: ".inventory_list" }, timeout_ms: 10000 },
  ],
};

let fakeCalls = 0;
const fakePlanner: Planner = {
  async generate() {
    fakeCalls += 1;
    return { plan, llm_calls: 1, model: "fake", planning_mode: "full" as const, tokens: { input: 1000, output: 100 }, semantic_retries: 0 };
  },
};

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

const scenario = await loadScenario("saucedemo-login");
await clearCache();

console.log("[m4] 1/3 miss → plans (fake) and writes the cache...");
const run1 = await runScenario(scenario, fakePlanner, { useCache: true });
assert(run1.result === "passed", "run1 should pass");
assert(run1.cache === "miss", `run1 cache=miss, got ${run1.cache}`);
assert(run1.llm_calls === 1, "run1 should have 1 call");
const cacheFile = path.join(cacheDir(), "saucedemo-login.json");
const entry1 = JSON.parse(await readFile(cacheFile, "utf8")) as CacheEntry;
assert(entry1.status === "active", "cache should be active");

console.log("[m4] 2/3 hit → replay without LLM...");
const run2 = await runScenario(scenario, fakePlanner, { useCache: true });
assert(run2.result === "passed", "run2 should pass");
assert(run2.cache === "hit", `run2 cache=hit, got ${run2.cache}`);
assert(run2.llm_calls === 0, `run2 llm_calls=0, got ${run2.llm_calls}`);
const entry2 = JSON.parse(await readFile(cacheFile, "utf8")) as CacheEntry;
assert(entry2.stats.replay_count === 1, "replay_count should be 1");

console.log("[m4] 3/3 broken selector → invalidates → re-plans → overwrites...");
entry2.plan.actions[2].target!.selector = "#login-button-x";
await writeFile(cacheFile, JSON.stringify(entry2, null, 2));
const run3 = await runScenario(scenario, fakePlanner, { useCache: true });
assert(run3.result === "passed", "run3 should pass after re-planning");
assert(run3.cache === "invalidated", `run3 cache=invalidated, got ${run3.cache}`);
assert(run3.llm_calls === 1, "run3 should have 1 call (re-plan)");
const entry3 = JSON.parse(await readFile(cacheFile, "utf8")) as CacheEntry;
assert(entry3.status === "active", "the overwritten cache should be active");
assert(entry3.plan.actions[2].target!.selector === "#login-button", "the new plan should have the good selector");

console.log(`\n[m4] PASSED — miss→hit→invalidated ok (fake planner called ${fakeCalls}x)`);
