/**
 * M4 — cache + runner com planejador fake (sem LLM).
 * 1) miss → executa e grava cache
 * 2) hit → replay com llm_calls=0
 * 3) seletor quebrado no cache → invalida (stale) → re-planeja (fake) → sobrescreve
 *
 * Rodar: npx tsx test/m4-probe.ts
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { CACHE_DIR, clearCache } from "../src/cache.js";
import { runScenario, type Planner } from "../src/runner.js";
import { loadScenario } from "../src/scenario.js";
import type { CacheEntry, Plan } from "../src/types.js";

const plan: Plan = {
  plan_version: "0.1",
  scenario_id: "saucedemo-login",
  start_url: "https://www.saucedemo.com",
  actions: [
    { id: "a1", type: "fill", target: { selector: "#user-name", description: "campo de usuário" }, value: "standard_user", timeout_ms: 5000 },
    { id: "a2", type: "fill", target: { selector: "#password", description: "campo de senha" }, value: "secret_sauce", timeout_ms: 5000 },
    { id: "a3", type: "click", target: { selector: "#login-button", description: "botão de login" }, expect: { url: "**/inventory.html", selector: ".inventory_list" }, timeout_ms: 10000 },
  ],
};

let fakeCalls = 0;
const fakePlanner: Planner = {
  async generate() {
    fakeCalls += 1;
    return { plan, llm_calls: 1, model: "fake", planning_mode: "full" as const, tokens: { input: 1000, output: 100 } };
  },
};

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

const scenario = await loadScenario("saucedemo-login");
await clearCache();

console.log("[m4] 1/3 miss → planeja (fake) e grava cache...");
const run1 = await runScenario(scenario, fakePlanner, { useCache: true });
assert(run1.result === "passed", "run1 deveria passar");
assert(run1.cache === "miss", `run1 cache=miss, veio ${run1.cache}`);
assert(run1.llm_calls === 1, "run1 deveria ter 1 chamada");
const cacheFile = path.join(CACHE_DIR, "saucedemo-login.json");
const entry1 = JSON.parse(await readFile(cacheFile, "utf8")) as CacheEntry;
assert(entry1.status === "active", "cache deveria estar active");

console.log("[m4] 2/3 hit → replay sem LLM...");
const run2 = await runScenario(scenario, fakePlanner, { useCache: true });
assert(run2.result === "passed", "run2 deveria passar");
assert(run2.cache === "hit", `run2 cache=hit, veio ${run2.cache}`);
assert(run2.llm_calls === 0, `run2 llm_calls=0, veio ${run2.llm_calls}`);
const entry2 = JSON.parse(await readFile(cacheFile, "utf8")) as CacheEntry;
assert(entry2.stats.replay_count === 1, "replay_count deveria ser 1");

console.log("[m4] 3/3 seletor quebrado → invalida → re-planeja → sobrescreve...");
entry2.plan.actions[2].target!.selector = "#login-button-x";
await writeFile(cacheFile, JSON.stringify(entry2, null, 2));
const run3 = await runScenario(scenario, fakePlanner, { useCache: true });
assert(run3.result === "passed", "run3 deveria passar após re-planejamento");
assert(run3.cache === "invalidated", `run3 cache=invalidated, veio ${run3.cache}`);
assert(run3.llm_calls === 1, "run3 deveria ter 1 chamada (re-plano)");
const entry3 = JSON.parse(await readFile(cacheFile, "utf8")) as CacheEntry;
assert(entry3.status === "active", "cache sobrescrito deveria estar active");
assert(entry3.plan.actions[2].target!.selector === "#login-button", "plano novo deveria ter o seletor bom");

console.log(`\n[m4] PASSOU — miss→hit→invalidated ok (planejador fake chamado ${fakeCalls}x)`);
