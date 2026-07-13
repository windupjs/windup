/**
 * M1 — friction proof for the local Stagehand v3, without an LLM.
 * Executes the hardcoded example plan from doc 02 (saucedemo login)
 * using only deterministic page/locator calls and prints the a11y snapshot.
 *
 * Run WITHOUT GOOGLE_GENERATIVE_AI_API_KEY in the environment to prove
 * that no LLM call happens: npx tsx test/m1-probe.ts
 */
import { launchBrowser } from "../src/browser.js";

const browser = await launchBrowser();
try {
  console.log("[m1] opening saucedemo...");
  await browser.goto("https://www.saucedemo.com");

  const loginDeadline = Date.now() + 10_000;
  while (Date.now() < loginDeadline && !(await browser.isVisible("#user-name"))) {
    await new Promise((r) => setTimeout(r, 100));
  }

  console.log("[m1] a11y snapshot of the login page:\n");
  const tree = await browser.snapshotTree();
  console.log(tree.slice(0, 2000));
  console.log("\n[m1] interactive elements:");
  console.log((await browser.interactiveElements()).join("\n"));

  console.log("\n[m1] executing hardcoded plan (fill/fill/click)...");
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

  console.log(`\n[m1] final url: ${browser.url()}`);
  console.log(`[m1] result: ${ok ? "PASSED — login complete, zero LLM" : "FAILED"}`);
  process.exitCode = ok ? 0 : 1;
} finally {
  await browser.close();
}
