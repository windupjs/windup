import { chromium, firefox, webkit, type Browser as PWBrowser, type BrowserContext, type BrowserType, type Page } from "playwright-core";
import { getContext } from "./context.js";
import { WindupError } from "./errors.js";
import { installChromium, isMissingBrowserError } from "./ensure-browser.js";
import { computeSignature, type RawElement } from "./signature.js";

/**
 * Single boundary with the browser engine — Playwright since v0.6 (the spike
 * validated on Stagehand v3; the swap fixed isTrusted clicks and cut the
 * dependency tree). Executor, verifier and planner only ever talk to this
 * interface; nothing here calls an LLM.
 *
 * E5: one Chromium process per CLI invocation (lazy singleton engine), one
 * fresh BrowserContext per run — repeat/bench pay the launch cost once while
 * every run keeps incognito-grade isolation. No daemon across invocations by
 * design (SPEC-001 forbids that complexity until metrics demand it).
 */
export interface RawPageElement extends RawElement {
  placeholder?: string;
  text?: string;
}

export interface Browser {
  goto(url: string): Promise<void>;
  click(selector: string): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  isVisible(selector: string): Promise<boolean>;
  /** Wait until the selector is visible (frame-safe). false on timeout. */
  waitForVisible(selector: string, timeoutMs: number): Promise<boolean>;
  inputValue(selector: string): Promise<string>;
  url(): string;
  /** Accessibility tree of the current page, as text (planner context). */
  snapshotTree(): Promise<string>;
  /** Prompt-formatted interactive elements (planner context). */
  interactiveElements(): Promise<string[]>;
  /** Structured interactive elements (signature + site map). */
  interactiveElementsRaw(): Promise<RawPageElement[]>;
  /** Structural signature of the current page (E1). */
  pageSignature(): Promise<string>;
  /** Current page title (site-map metadata). */
  title(): Promise<string>;
  close(): Promise<void>;
}

const ACTION_TIMEOUT_MS = () => Number.parseInt(process.env.WINDUP_ACTION_TIMEOUT_MS ?? "10000", 10) || 10_000;

class PlaywrightSession implements Browser {
  constructor(
    private readonly context: BrowserContext,
    private readonly page: Page,
  ) {}

  /**
   * Targeting policy: the first VISIBLE match, not the first in the DOM.
   * Text selectors (:has-text) match hidden items (closed menus, spotlight,
   * dialogs) that come earlier in the DOM — with plain .first(), the "right
   * and visible" target lost to an invisible ghost (seen in dogfooding).
   * The filter is dynamic: elements that become visible later count.
   */
  private visible(selector: string) {
    return this.page.locator(selector).filter({ visible: true }).first();
  }

  async goto(url: string): Promise<void> {
    await this.page.goto(url, { waitUntil: "load" });
  }

  async click(selector: string): Promise<void> {
    // Native actionability (visible/stable/enabled/receives-events) with
    // trusted input events — settles doc 07-A2 for good.
    await this.visible(selector).click({ timeout: ACTION_TIMEOUT_MS() });
  }

  async fill(selector: string, value: string): Promise<void> {
    await this.visible(selector).fill(value, { timeout: ACTION_TIMEOUT_MS() });
  }

  async isVisible(selector: string): Promise<boolean> {
    try {
      return await this.visible(selector).isVisible();
    } catch {
      return false;
    }
  }

  async waitForVisible(selector: string, timeoutMs: number): Promise<boolean> {
    try {
      await this.visible(selector).waitFor({ state: "visible", timeout: timeoutMs });
      return true;
    } catch {
      return false;
    }
  }

  async inputValue(selector: string): Promise<string> {
    return this.visible(selector).inputValue({ timeout: ACTION_TIMEOUT_MS() });
  }

  url(): string {
    return this.page.url();
  }

  async snapshotTree(): Promise<string> {
    // YAML aria snapshot (Playwright ≥1.59). "default" mode on purpose: the
    // "ai" mode's [ref=eN] handles are session-scoped — useless in a replayed
    // plan that must address elements by CSS selector.
    return this.page.ariaSnapshot();
  }

  // One evaluate feeds prompt context, page signature and the site map.
  async interactiveElementsRaw(): Promise<RawPageElement[]> {
    return this.page.evaluate<RawPageElement[]>(() => {
      const els = Array.from(
        document.querySelectorAll("input, button, a, select, textarea"),
      );
      return els.map((el) => {
        const tag = el.tagName.toLowerCase();
        return {
          tag,
          id: el.id || undefined,
          name: el.getAttribute("name") ?? undefined,
          dataTest: el.getAttribute("data-test") ?? undefined,
          type: el.getAttribute("type") ?? undefined,
          placeholder: el.getAttribute("placeholder") ?? undefined,
          text: tag === "input" ? undefined : (el.textContent ?? "").trim().slice(0, 40) || undefined,
        };
      });
    });
  }

  async interactiveElements(): Promise<string[]> {
    const raw = await this.interactiveElementsRaw();
    return raw.map((el) => {
      const parts = [el.tag];
      if (el.id) parts.push(`id=${el.id}`);
      if (el.name) parts.push(`name=${el.name}`);
      if (el.dataTest) parts.push(`data-test=${el.dataTest}`);
      if (el.type) parts.push(`type=${el.type}`);
      if (el.placeholder) parts.push(`placeholder=${el.placeholder}`);
      if (el.text) parts.push(`text=${el.text}`);
      return parts.join(" ");
    });
  }

  async pageSignature(): Promise<string> {
    return computeSignature(await this.interactiveElementsRaw());
  }

  async title(): Promise<string> {
    return this.page.title();
  }

  async close(): Promise<void> {
    // Closes only the session (context); the engine stays warm for the next
    // run in this process (E5).
    await this.context.close();
  }
}

let engine: Promise<PWBrowser> | null = null;

export type BrowserName = "chromium" | "firefox" | "webkit";
const ENGINES: Record<BrowserName, BrowserType> = { chromium, firefox, webkit };

/** Resolve + validate the browser name (pure; exported for testing). */
export function resolveBrowserName(envValue: string | undefined, configValue: string | undefined): BrowserName {
  const raw = (envValue ?? configValue ?? "chromium").toLowerCase();
  if (raw !== "chromium" && raw !== "firefox" && raw !== "webkit") {
    throw new WindupError(`unknown browser "${raw}" — use chromium, firefox or webkit`);
  }
  return raw;
}

/** Selected browser: WINDUP_BROWSER env → config.browser → chromium. */
function selectedBrowser(): BrowserName {
  return resolveBrowserName(process.env.WINDUP_BROWSER, getContext().config.browser);
}

function launchOptions(name: BrowserName) {
  const headless = process.env.HEADLESS !== "false";
  if (name === "chromium") {
    return {
      headless,
      ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
      args: ["--window-size=1280,1000", ...(process.env.CHROME_ARGS?.split(" ") ?? [])],
    };
  }
  // firefox/webkit: chromium-only args/env don't apply.
  return { headless };
}

function getEngine(): Promise<PWBrowser> {
  const name = selectedBrowser();
  // Lazy fallback for --ignore-scripts installs: if Chromium's binary is
  // missing, download it once and retry — `npm i -D windupjs` must be enough.
  // firefox/webkit are not auto-downloaded (opt-in extra browsers).
  engine ??= ENGINES[name].launch(launchOptions(name)).catch(async (err) => {
    if (name === "chromium" && isMissingBrowserError(err) && installChromium("first run")) {
      return chromium.launch(launchOptions("chromium"));
    }
    if (isMissingBrowserError(err)) {
      throw new WindupError(`the ${name} browser is not installed — run:  npx playwright install ${name}`);
    }
    throw err;
  });
  return engine;
}

/** New isolated session (fresh context+page) on the warm engine. */
export async function launchBrowser(): Promise<Browser> {
  const browser = await getEngine();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  return new PlaywrightSession(context, page);
}

/** Shut the engine down (CLI exit hook; API/test teardown). Safe to call twice. */
export async function shutdownBrowserEngine(): Promise<void> {
  if (!engine) return;
  const current = engine;
  engine = null;
  try {
    await (await current).close();
  } catch {
    // already gone
  }
}
