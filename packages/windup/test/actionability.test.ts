import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchBrowser, type Browser } from "../src/browser.js";

/**
 * Doc 07-A2: clique em elemento coberto por overlay deve FALHAR, não "passar".
 * Página local mínima: um botão livre, um coberto por overlay e um disabled.
 */
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
  const dir = await mkdtemp(path.join(tmpdir(), "spike-a11y-"));
  const file = path.join(dir, "pagina.html");
  await writeFile(file, PAGE);
  browser = await launchBrowser();
  await browser.goto(`file://${file}`);
  await browser.waitForVisible("#livre", 5000);
}, 60_000);

afterAll(async () => {
  await browser?.close();
});

describe("actionability do clique (doc 07-A2)", () => {
  it("clica em elemento livre", async () => {
    await expect(browser.click("#livre")).resolves.toBeUndefined();
  });

  it("FALHA ao clicar em elemento coberto por overlay", async () => {
    await expect(browser.click("#coberto")).rejects.toThrow(/covered/);
  });

  it("falha ao clicar em elemento desabilitado", async () => {
    await expect(browser.click("#desabilitado")).rejects.toThrow(/disabled/);
  });

  it("falha ao clicar em elemento inexistente", async () => {
    await expect(browser.click("#nao-existe")).rejects.toThrow(/not found/);
  });
});
