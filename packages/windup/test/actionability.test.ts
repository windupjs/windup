import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchBrowser, shutdownBrowserEngine, type Browser } from "../src/browser.js";

/**
 * Doc 07-A2, agora com actionability NATIVA do Playwright: clique em elemento
 * coberto/desabilitado deve FALHAR (timeout de actionability), nunca "passar".
 * Timeout curto via env para os casos negativos não custarem 10s cada.
 */
process.env.WINDUP_ACTION_TIMEOUT_MS = "1200";

const PAGE = `<!doctype html><html><body>
  <button id="livre" onclick="this.textContent='clicado'">Livre</button>
  <div style="position:relative; width:200px; height:50px;">
    <button id="coberto" onclick="this.textContent='clicado'">Coberto</button>
    <div id="overlay" style="position:absolute; inset:0; background:rgba(0,0,0,.4);"></div>
  </div>
  <button id="desabilitado" disabled>Desabilitado</button>
</body></html>`;

let browser: Browser;

beforeAll(async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "windup-a11y-"));
  const file = path.join(dir, "pagina.html");
  await writeFile(file, PAGE);
  browser = await launchBrowser();
  await browser.goto(`file://${file}`);
  await browser.waitForVisible("#livre", 5000);
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await shutdownBrowserEngine();
});

describe("actionability do clique (Playwright nativo)", () => {
  it("clica em elemento livre (evento trusted)", async () => {
    await expect(browser.click("#livre")).resolves.toBeUndefined();
  });

  it("FALHA ao clicar em elemento coberto por overlay — e o clique NÃO acontece", async () => {
    await expect(browser.click("#coberto")).rejects.toThrow(/Timeout|intercepts pointer events/i);
    // prova de que o clique não vazou:
    const clicked = await browser.isVisible("#coberto >> text=clicado");
    expect(clicked).toBe(false);
  });

  it("falha ao clicar em elemento desabilitado", async () => {
    await expect(browser.click("#desabilitado")).rejects.toThrow(/Timeout|enabled/i);
  });

  it("falha ao clicar em elemento inexistente", async () => {
    await expect(browser.click("#nao-existe")).rejects.toThrow(/Timeout|waiting for/i);
  });
});
