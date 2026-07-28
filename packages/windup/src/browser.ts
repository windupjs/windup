import { chromium, firefox, webkit, type Browser as PWBrowser, type BrowserContext, type BrowserContextOptions, type BrowserType, type Page } from "playwright-core";
import { clockInitScript, frozenNowMs, type ClockConfig } from "./clock.js";
import { getContext } from "./context.js";
import { resolveDeviceContext } from "./device.js";
import { WindupError } from "./errors.js";
import { matchRule, stubMatchesUrl } from "./network.js";
import { classifyConsoleError, matchesIgnore, resourceStatus } from "./diagnostics.js";
import type { NetworkRule } from "./config.js";
import { VITALS_INIT_SCRIPT } from "./vitals.js";
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
  /** Visible text content of the first visible match (empty string if none). */
  textContent(selector: string): Promise<string>;
  /** How many elements match the selector (all matches, visible or not). */
  count(selector: string): Promise<number>;
  /** An attribute value on the first visible match (null if absent). */
  getAttribute(selector: string, name: string): Promise<string | null>;
  /** Wait until the selector is absent/hidden (frame-safe). false on timeout. */
  waitForHidden(selector: string, timeoutMs: number): Promise<boolean>;
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
  /** Console errors + uncaught page exceptions observed since launch (for config.failOn / --fail-on-console / --fail-on-resource), each with its originating URL and a `js`/`resource` kind. Excludes anything matching failOn.ignore (by message OR url). */
  consoleErrors(): ConsoleError[];
  /** 5xx responses observed since launch, excluding config.network stubs and failOn.ignore (for --fail-on-5xx). */
  failedResponses(): FailedResponse[];
  /** Final-page web vitals (navigation timing + FCP + observed LCP/CLS). LCP/CLS are 0/null unless observers were injected at launch. */
  webVitals(): Promise<import("./vitals.js").WebVitals>;
  /** Install the interactive recorder (`windup record`): a floating toolbar + capture listeners that report each interaction. Call BEFORE the first goto. */
  startRecording(onEvent: (e: import("./record.js").RecordEvent) => void): Promise<void>;
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

export interface FailedResponse {
  url: string;
  status: number;
  method: string;
}

export interface ConsoleError {
  /** The console/exception text (e.g. "Failed to load resource: the server responded with a status of 404 ()"). */
  message: string;
  /** The URL the error originated from — the failing resource for a resource error, the script for a JS exception. Absent for `pageerror` (no location). */
  url?: string;
  /** `resource` = a sub-resource that failed to load (img/font/script/xhr — the noisy 4xx kind); `js` = a JS exception, console.error, or CSP/other page error. */
  kind: "js" | "resource";
}

const ACTION_TIMEOUT_MS = () => Number.parseInt(process.env.WINDUP_ACTION_TIMEOUT_MS ?? "10000", 10) || 10_000;

class PlaywrightSession implements Browser {
  constructor(
    private readonly context: BrowserContext,
    private readonly page: Page,
    /** Effective network stubs for THIS session (scenario merged over config) — captureDiagnostics uses these to exclude deliberately-stubbed 5xx / resource errors. */
    private readonly network?: NetworkRule[],
    /** Effective failOn.ignore for THIS session (scenario merged over config) — captureDiagnostics silences these by message or url. */
    private readonly ignore?: string[],
  ) {}

  private readonly consoleErrs: ConsoleError[] = [];
  private readonly failedResps: FailedResponse[] = [];

  /**
   * Attach passive listeners for console errors, uncaught exceptions and 5xx
   * responses. Called once at launch. A 5xx that config.network stubbed (a
   * deliberate test of the error state) is excluded, as is anything matching
   * failOn.ignore — matched against the message AND the originating URL, so a
   * resource 404 (whose console text is the generic "Failed to load resource …"
   * with no URL in it) can still be silenced by its host. `requestfailed` is
   * intentionally NOT listened to — a config.network `abort` triggers it, which
   * would be a false positive.
   */
  captureDiagnostics(): void {
    const cfg = (() => { try { return getContext().config; } catch { return undefined; } })();
    const ignore = this.ignore ?? cfg?.failOn?.ignore ?? []; // effective (scenario + config) ignore for this session
    const ignored = (...parts: Array<string | undefined>) => matchesIgnore(ignore, ...parts);
    const stubs = this.network; // effective (scenario + config) rules for this session
    const isStub = (url: string, method: string) => Boolean(stubs?.length && matchRule(stubs, url, method));
    const isStubbedUrl = (url: string | undefined) => Boolean(url && stubs?.length && stubMatchesUrl(stubs, url));
    this.page.on("console", (m) => {
      if (m.type() !== "error") return;
      const message = m.text();
      const url = m.location()?.url || undefined;
      if (ignored(message, url)) return;
      if (isStubbedUrl(url)) return; // a deliberately-stubbed endpoint (global OR per-scenario) is not a real failure
      const status = resourceStatus(message);
      this.consoleErrs.push({ message, url, kind: classifyConsoleError(message), ...(status !== undefined ? { status } : {}) });
    });
    this.page.on("pageerror", (e) => {
      if (ignored(e.message)) return;
      this.consoleErrs.push({ message: e.message, kind: "js" });
    });
    this.page.on("response", (r) => {
      const status = r.status();
      if (status < 500) return;
      const url = r.url();
      const method = r.request().method();
      if (isStub(url, method) || ignored(url)) return;
      this.failedResps.push({ url, status, method });
    });
  }

  consoleErrors(): ConsoleError[] {
    return this.consoleErrs;
  }

  failedResponses(): FailedResponse[] {
    return this.failedResps;
  }

  async webVitals(): Promise<import("./vitals.js").WebVitals> {
    const { READ_VITALS_SCRIPT } = await import("./vitals.js");
    return this.page.evaluate(READ_VITALS_SCRIPT) as Promise<import("./vitals.js").WebVitals>;
  }

  async startRecording(onEvent: (e: import("./record.js").RecordEvent) => void): Promise<void> {
    const { RECORD_INIT_SCRIPT } = await import("./record.js");
    // The exposed binding + init script must be in place BEFORE navigation so the
    // injected listeners can call back on the very first page.
    await this.context.exposeBinding("__windupRecord", (_src, ev) => onEvent(ev as import("./record.js").RecordEvent));
    await this.context.addInitScript(RECORD_INIT_SCRIPT);
  }

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

  async textContent(selector: string): Promise<string> {
    return (await this.visible(selector).textContent({ timeout: ACTION_TIMEOUT_MS() })) ?? "";
  }

  async count(selector: string): Promise<number> {
    // Raw locator (no visible filter): a count assertion means "how many match".
    return this.page.locator(selector).count();
  }

  async getAttribute(selector: string, name: string): Promise<string | null> {
    return this.visible(selector).getAttribute(name, { timeout: ACTION_TIMEOUT_MS() });
  }

  async waitForHidden(selector: string, timeoutMs: number): Promise<boolean> {
    try {
      // "hidden" resolves when the element is hidden OR detached — the negative of visible.
      await this.page.locator(selector).first().waitFor({ state: "hidden", timeout: timeoutMs });
      return true;
    } catch {
      return false;
    }
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
export async function launchBrowser(opts: { storageState?: unknown; trace?: boolean; network?: NetworkRule[]; clock?: ClockConfig; ignore?: string[] } = {}): Promise<Browser> {
  const browser = await getEngine();
  const cfg = currentConfig();
  // Per-scenario network/clock (already merged over config by the caller) win; else the global config.
  const network = opts.network ?? cfg?.network;
  const clock = opts.clock ?? cfg?.clock;
  // config.device / --device — a Playwright device preset (viewport, UA, scale, mobile/touch).
  const device = resolveDeviceContext(); // throws on an unknown preset name
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    // Playwright accepts the storageState object directly; typed loosely at our boundary.
    ...(opts.storageState ? { storageState: opts.storageState as BrowserContextOptions["storageState"] } : {}),
    ...(clock?.timezone ? { timezoneId: clock.timezone } : {}),
    ...(device ?? {}), // device viewport/UA overrides the default
  });
  // config.clock / scenario.clock — freeze Date/now before any page script (every navigation).
  const nowMs = frozenNowMs(clock);
  if (nowMs !== null) await context.addInitScript(clockInitScript(nowMs));
  // --web-vitals / config.budgets — observe LCP+CLS from the first paint (every navigation).
  if (process.env.WINDUP_WEB_VITALS === "1" || cfg?.budgets) await context.addInitScript(VITALS_INIT_SCRIPT);
  // config.network / scenario.network — deterministic stubs for matched requests; author-declared, never cached.
  if (network?.length) {
    const rules = network;
    await context.route("**/*", async (route) => {
      const req = route.request();
      const rule = matchRule(rules, req.url(), req.method());
      if (!rule) return route.continue();
      if (rule.abort) return route.abort();
      const body = rule.json !== undefined ? JSON.stringify(rule.json) : rule.body ?? "";
      const contentType = rule.contentType ?? (rule.json !== undefined ? "application/json" : "text/plain");
      return route.fulfill({ status: rule.status ?? 200, contentType, headers: rule.headers, body });
    });
  }
  if (opts.trace) {
    try {
      await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    } catch {
      // tracing unsupported on this engine build — the run proceeds without it
    }
  }
  const page = await context.newPage();
  const session = new PlaywrightSession(context, page, network, opts.ignore);
  session.captureDiagnostics(); // passive console/5xx listeners for config.failOn / --fail-on-*
  return session;
}

/** The active windup config, or undefined when no context is set (e.g. isolated unit tests). */
function currentConfig(): import("./config.js").WindupConfig | undefined {
  try {
    return getContext().config;
  } catch {
    return undefined;
  }
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
