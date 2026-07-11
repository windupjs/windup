/**
 * M3 — executor + verificador de verdade contra o saucedemo, ainda sem LLM.
 * 1) Plano de exemplo do doc 02 roda fim-a-fim com pós-condições passando.
 * 2) Um expect deliberadamente quebrado falha como "verification", não crash.
 *
 * Rodar: npx tsx test/m3-probe.ts
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
      target: { selector: "#user-name", description: "campo de usuário" },
      value: "standard_user",
      expect: { selector_value: { selector: "#user-name", value: "standard_user" } },
      timeout_ms: 5000,
    },
    {
      id: "a2",
      type: "fill",
      target: { selector: "#password", description: "campo de senha" },
      value: "secret_sauce",
      timeout_ms: 5000,
    },
    {
      id: "a3",
      type: "click",
      target: { selector: "#login-button", description: "botão de login" },
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
  console.log("[m3] 1/2 plano bom...");
  const good = await executePlan(browser, goodPlan);
  console.log(JSON.stringify(good, null, 2));
  if (!good.ok) throw new Error("plano bom deveria passar");

  console.log("[m3] 2/2 plano com expect quebrado...");
  const broken = await executePlan(browser, brokenPlan);
  console.log(JSON.stringify(broken.failure, null, 2));
  if (broken.ok) throw new Error("plano quebrado deveria falhar");
  if (broken.failure?.kind !== "verification") throw new Error(`kind esperado verification, veio ${broken.failure?.kind}`);

  console.log("\n[m3] PASSOU — execução fim-a-fim ok e falha classificada como verification");
} finally {
  await browser.close();
}
