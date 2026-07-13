/**
 * P5: windup scenarios as native vitest tests — this file IS the
 * acceptance criterion: the runner's report lists each scenario as a test.
 *
 * Hermetic: seeds a known-good plan into the cache before the suite, so the
 * scenario runs as a REPLAY (zero LLM, no API key, immune to state left
 * behind by benches).
 */
import { createContextFromConfig, setContext } from "../src/context.js";
import { saveCached } from "../src/cache.js";
import { loadScenario } from "../src/scenario.js";
import { windupSuite } from "../src/adapters/vitest.js";
import type { Plan } from "../src/types.js";

setContext(await createContextFromConfig());
const scenario = await loadScenario("saucedemo-login");
const knownGoodPlan: Plan = {
  plan_version: "0.1",
  scenario_id: "saucedemo-login",
  start_url: "https://www.saucedemo.com",
  actions: [
    { id: "a1", type: "fill", target: { selector: "#user-name", description: "username" }, value: "standard_user", timeout_ms: 5000 },
    { id: "a2", type: "fill", target: { selector: "#password", description: "password" }, value: "secret_sauce", timeout_ms: 5000 },
    { id: "a3", type: "click", target: { selector: "#login-button", description: "login" }, expect: { url: "**/inventory.html", selector: ".inventory_list" }, timeout_ms: 10000 },
  ],
};
await saveCached(scenario, knownGoodPlan);

await windupSuite({ filter: (id) => id === "saucedemo-login", name: "windup e2e" });
