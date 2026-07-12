/**
 * M1 — prova de fricção do Stagehand v3 local, sem LLM.
 * Executa o plano de exemplo do doc 02 hardcoded (login no saucedemo)
 * usando apenas page/locator determinísticos e imprime o snapshot a11y.
 *
 * Rodar SEM GOOGLE_GENERATIVE_AI_API_KEY no ambiente para provar que
 * nenhuma chamada de LLM acontece: npx tsx test/m1-probe.ts
 */
import { launchBrowser } from "../src/browser.js";

const browser = await launchBrowser();
try {
  console.log("[m1] abrindo saucedemo...");
  await browser.goto("https://www.saucedemo.com");

  const loginDeadline = Date.now() + 10_000;
  while (Date.now() < loginDeadline && !(await browser.isVisible("#user-name"))) {
    await new Promise((r) => setTimeout(r, 100));
  }

  console.log("[m1] snapshot a11y da página de login:\n");
  const tree = await browser.snapshotTree();
  console.log(tree.slice(0, 2000));
  console.log("\n[m1] elementos interativos:");
  console.log((await browser.interactiveElements()).join("\n"));

  console.log("\n[m1] executando plano hardcoded (fill/fill/click)...");
  await browser.fill("#user-name", "standard_user");
  await browser.fill("#password", "secret_sauce");
  await browser.click("#login-button");

  const deadline = Date.now() + 10_000;
  let ok = false;
  while (Date.now() < deadline) {
    if (browser.url().includes("/inventory.html") && (await browser.isVisible(".inventory_list"))) {
      ok = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  console.log(`\n[m1] url final: ${browser.url()}`);
  console.log(`[m1] resultado: ${ok ? "PASSOU — login completo, zero LLM" : "FALHOU"}`);
  process.exitCode = ok ? 0 : 1;
} finally {
  await browser.close();
}
