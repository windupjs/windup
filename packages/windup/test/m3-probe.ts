/**
 * M3 — executor + real verifier against saucedemo, still without an LLM.
 * 1) The example plan from doc 02 runs end-to-end with postconditions passing.
 * 2) A deliberately broken expect fails as "verification", not a crash.
 *
 * Run: npx tsx test/m3-probe.ts
 */
import { launchBrowser } from "../src/browser.js";
import { executePlan } from "../src/executor.js";
import type { Plan } from "../src/types.js";

const goodPlan: Plan = {
  plan_version: "0.1",
  scenario_id: "saucedemo-login",
  start_url: "https://www.saucedemo.com",
  actions: [
    {
      id: "a1",
      type: "fill",
      target: { selector: "#user-name", description: "username field" },
      value: "standard_user",
      expect: { selector_value: { selector: "#user-name", value: "standard_user" } },
      timeout_ms: 5000,
    },
    {
      id: "a2",
      type: "fill",
      target: { selector: "#password", description: "password field" },
      value: "secret_sauce",
      timeout_ms: 5000,
    },
    {
      id: "a3",
      type: "click",
      target: { selector: "#login-button", description: "login button" },
      expect: { url: "**/inventory.html", selector: ".inventory_list" },
      timeout_ms: 10000,
    },
  ],
};

const brokenPlan: Plan = {
  ...goodPlan,
  actions: goodPlan.actions.map((a) =>
    a.id === "a3" ? { ...a, expect: { ...a.expect, selector: ".inventory_list_x" }, timeout_ms: 3000 } : a,
  ),
};

const browser = await launchBrowser();
try {
  console.log("[m3] 1/2 good plan...");
  const good = await executePlan(browser, goodPlan);
  console.log(JSON.stringify(good, null, 2));
  if (!good.ok) throw new Error("the good plan should pass");

  console.log("[m3] 2/2 plan with a broken expect...");
  const broken = await executePlan(browser, brokenPlan);
  console.log(JSON.stringify(broken.failure, null, 2));
  if (broken.ok) throw new Error("the broken plan should fail");
  if (broken.failure?.kind !== "verification") throw new Error(`expected kind verification, got ${broken.failure?.kind}`);

  console.log("\n[m3] PASSED — end-to-end execution ok and failure classified as verification");
} finally {
  await browser.close();
}
