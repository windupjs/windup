import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchBrowser, shutdownBrowserEngine, type Browser } from "../src/browser.js";

/**
 * Doc 07-A2, now with Playwright's NATIVE actionability: clicking a covered
 * or disabled element must FAIL (actionability timeout), never "pass".
 * Short timeout via env so the negative cases don't cost 10s each.
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

describe("click actionability (native Playwright)", () => {
  it("clicks a free element (trusted event)", async () => {
    await expect(browser.click("#livre")).resolves.toBeUndefined();
  });

  it("FAILS to click an element covered by an overlay — and the click does NOT happen", async () => {
    await expect(browser.click("#coberto")).rejects.toThrow(/Timeout|intercepts pointer events/i);
    // proof that the click did not leak through:
    const clicked = await browser.isVisible("#coberto >> text=clicado");
    expect(clicked).toBe(false);
  });

  it("fails to click a disabled element", async () => {
    await expect(browser.click("#desabilitado")).rejects.toThrow(/Timeout|enabled/i);
  });

  it("fails to click a nonexistent element", async () => {
    await expect(browser.click("#nao-existe")).rejects.toThrow(/Timeout|waiting for/i);
  });
});
