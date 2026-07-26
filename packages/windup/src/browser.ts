import { chromium, firefox, webkit, type Browser as PWBrowser, type BrowserContext, type BrowserContextOptions, type BrowserType, type Page } from "playwright-core";
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
  /** Arm a one-time handler for the next native dialog (window.confirm/alert/prompt), to fire on the action that opens it. */
  armDialog(action: "accept" | "dismiss"): void;
  /** Persistent default for EVERY native dialog this run (scenario `on_dialog`) — so authors don't repeat a per-action `dialog`. Disables one-time arming. */
  setDialogHandler(action: "accept" | "dismiss"): void;
  /** Accessibility fallback: click the single visible field/control whose accessible name (label/placeholder/role) matches `description`. false if none or ambiguous. */
  clickByDescription(description: string): Promise<boolean>;
  /** Accessibility fallback: fill the single visible field matching `description`. false if none or ambiguous. */
  fillByDescription(description: string, value: string): Promise<boolean>;
  /** Accessibility fallback: is there a single visible element matching `description`? */
  isVisibleByDescription(description: string): Promise<boolean>;
  fill(selector: string, value: string): Promise<void>;
  isVisible(selector: string): Promise<boolean>;
  /** Wait until the selector is visible (frame-safe). false on timeout. */
  waitForVisible(selector: string, timeoutMs: number): Promise<boolean>;
  /** Wait until the network settles (no requests for 500ms), capped at timeoutMs. Best-effort — resolves (never throws) on timeout. */
  waitForIdle(timeoutMs: number): Promise<void>;
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
  /** Playwright storageState (cookies + localStorage) of the current context — a session snapshot for dependents. */
  storageState(): Promise<unknown>;
  /** Seed localStorage/sessionStorage for an origin BEFORE the plan runs (client-side fixtures). Each key is set only if absent. */
  seedStorage(seed: { localStorage?: Record<string, string>; sessionStorage?: Record<string, string>; origin?: string }): Promise<void>;
  /** Run an axe-core accessibility audit on the current page (needs axe-core installed). Returns the violations. */
  runAxe(): Promise<A11yViolation[]>;
  /** Stop the Playwright trace and write it to `path` (a .zip openable in the trace viewer). No-op if tracing wasn't started. */
  saveTrace(path: string): Promise<void>;
  /** Full-page screenshot to `path`. */
  screenshot(path: string): Promise<void>;
  close(): Promise<void>;
}

export interface A11yViolation {
  id: string;
  impact: string;
  help: string;
  nodes: number;
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

  private persistentDialog = false;

  armDialog(action: "accept" | "dismiss"): void {
    // One-time: applies to the next dialog only (the one this action opens).
    // Without a handler Playwright auto-dismisses dialogs, so a confirm()-gated
    // mutation never runs — this lets a scenario accept (or cancel) it. No-op
    // when a persistent scenario default is active (would double-handle).
    if (this.persistentDialog) return;
    this.page.once("dialog", (d) => {
      void (action === "accept" ? d.accept() : d.dismiss()).catch(() => {});
    });
  }

  setDialogHandler(action: "accept" | "dismiss"): void {
    this.persistentDialog = true;
    this.page.on("dialog", (d) => {
      void (action === "accept" ? d.accept() : d.dismiss()).catch(() => {});
    });
  }

  /** The single visible element whose accessible name matches `description`, or null (none / ambiguous — never guess among many). */
  private async locateUnique(description: string) {
    const t = description.replace(/\b(the|a|an|field|input|button|link|box|textbox|dropdown|select|icon)\b/gi, " ").replace(/\s+/g, " ").trim() || description;
    const candidates = [
      this.page.getByLabel(t, { exact: false }),
      this.page.getByPlaceholder(t, { exact: false }),
      this.page.getByRole("textbox", { name: t }),
    ];
    for (const c of candidates) {
      const vis = c.filter({ visible: true });
      if ((await vis.count()) === 1) return vis.first();
    }
    return null;
  }

  async clickByDescription(description: string): Promise<boolean> {
    const loc = await this.locateUnique(description);
    if (!loc) return false;
    await loc.click({ timeout: ACTION_TIMEOUT_MS() });
    return true;
  }

  async fillByDescription(description: string, value: string): Promise<boolean> {
    const loc = await this.locateUnique(description);
    if (!loc) return false;
    await loc.fill(value, { timeout: ACTION_TIMEOUT_MS() });
    return true;
  }

  async isVisibleByDescription(description: string): Promise<boolean> {
    return (await this.locateUnique(description)) !== null;
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

  async storageState(): Promise<unknown> {
    return this.context.storageState();
  }

  async saveTrace(path: string): Promise<void> {
    try {
      await this.context.tracing.stop({ path });
    } catch {
      // tracing wasn't started (no --trace) — nothing to save
    }
  }

  async screenshot(path: string): Promise<void> {
    await this.page.screenshot({ path, fullPage: true });
  }

  async runAxe(): Promise<A11yViolation[]> {
    let axeSource: string;
    try {
      // axe-core is a CJS `export =` module: under ESM dynamic import its object
      // (with `.source`) lands on `.default`. Fall back to the namespace itself.
      const mod = (await import("axe-core")) as unknown as { source?: string; default?: { source?: string } };
      axeSource = mod.default?.source ?? mod.source ?? "";
      if (!axeSource) throw new Error("axe-core loaded but its source was empty");
    } catch (err) {
      throw new WindupError(`--a11y needs axe-core installed as a dev dependency (npm i -D axe-core)${err instanceof Error && !/Cannot find/.test(err.message) ? ` — ${err.message}` : ""}`);
    }
    await this.page.addScriptTag({ content: axeSource }); // defines window.axe
    return this.page.evaluate(async () => {
      const axe = (window as unknown as { axe: { run: (ctx: Document, opts: object) => Promise<{ violations: Array<{ id: string; impact?: string; help: string; nodes: unknown[] }> }> } }).axe;
      const r = await axe.run(document, { resultTypes: ["violations"] });
      return r.violations.map((v) => ({ id: v.id, impact: v.impact ?? "n/a", help: v.help, nodes: v.nodes.length }));
    });
  }

  async waitForIdle(timeoutMs: number): Promise<void> {
    // "networkidle" = no in-flight requests for 500ms — the SPA-friendly "the
    // data loaded" signal. Best-effort: apps with persistent connections
    // (websocket/polling) never go idle, so swallow the timeout and move on.
    await this.page.waitForLoadState("networkidle", { timeout: timeoutMs }).catch(() => {});
  }

  async seedStorage(seed: { localStorage?: Record<string, string>; sessionStorage?: Record<string, string>; origin?: string }): Promise<void> {
    // addInitScript runs before the page's own scripts on every navigation, so
    // the app sees the seeded values on load. The "only if absent" guard means
    // it seeds on first visit but never overwrites the app's later mutations
    // (e.g. a cart the scenario then edits through the UI). Storage is
    // origin-scoped by the browser; `origin` further restricts which pages seed.
    await this.context.addInitScript(
      (data: { ls: Record<string, string>; ss: Record<string, string>; origin?: string }) => {
        if (data.origin && location.origin !== data.origin) return;
        try {
          for (const [k, v] of Object.entries(data.ls)) if (localStorage.getItem(k) === null) localStorage.setItem(k, v);
          for (const [k, v] of Object.entries(data.ss)) if (sessionStorage.getItem(k) === null) sessionStorage.setItem(k, v);
        } catch {
          // storage can be unavailable (sandboxed/opaque origin) — seeding is best-effort
        }
      },
      { ls: seed.localStorage ?? {}, ss: seed.sessionStorage ?? {}, origin: seed.origin },
    );
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

/**
 * New isolated session (fresh context+page) on the warm engine. Pass
 * `storageState` (a prior session snapshot) to seed cookies/localStorage into
 * the fresh context — restoring auth without re-running the login flow.
 */
export async function launchBrowser(opts: { storageState?: unknown; trace?: boolean } = {}): Promise<Browser> {
  const browser = await getEngine();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    // Playwright accepts the storageState object directly; typed loosely at our boundary.
    ...(opts.storageState ? { storageState: opts.storageState as BrowserContextOptions["storageState"] } : {}),
  });
  if (opts.trace) {
    try {
      await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    } catch {
      // tracing unsupported on this engine build — the run proceeds without it
    }
  }
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
