import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Browser, RawPageElement } from "../src/browser.js";
import { executePlan, readySelectorsFor } from "../src/executor.js";
import { createContext, setContext } from "../src/context.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { Plan } from "../src/types.js";

/** Minimal Browser stub that records the order of waitForVisible selectors. */
class FakeBrowser implements Browser {
  waited: string[] = [];
  private _url: string;
  constructor(url: string, private readonly visibleReturns: (sel: string) => boolean = () => true) {
    this._url = url;
  }
  url(): string { return this._url; }
  async goto(u: string): Promise<void> { this._url = u; }
  async waitForVisible(sel: string): Promise<boolean> { this.waited.push(sel); return this.visibleReturns(sel); }
  async click(): Promise<void> {}
  async fill(): Promise<void> {}
  armDialog(): void {}
  async isVisible(): Promise<boolean> { return true; }
  async inputValue(): Promise<string> { return ""; }
  async snapshotTree(): Promise<string> { return ""; }
  async interactiveElements(): Promise<string[]> { return ["btn"]; }
  async interactiveElementsRaw(): Promise<RawPageElement[]> { return [{ tag: "button" } as RawPageElement]; }
  async pageSignature(): Promise<string> { return "sig"; }
  async title(): Promise<string> { return ""; }
  async close(): Promise<void> {}
}

const plan = (start_url: string): Plan => ({
  plan_version: "0.1", scenario_id: "s", start_url,
  actions: [{ id: "a1", type: "wait_for", target: { selector: "#add", description: "add button" }, timeout_ms: 5000 }],
});

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "windup-ready-")); });
afterAll(() => setContext(createContext()));

describe("readiness signals per route glob (#4)", () => {
  it("readySelectorsFor matches globs against the URL path (leading-slash tolerant)", () => {
    setContext(createContext(root, { config: { ...DEFAULT_CONFIG, readySignals: { "**/workspace/**": ["#app-ready", "#nav"], "**/reports/**": "#grid" } } }));
    expect(readySelectorsFor("http://x/workspace/contacts")).toEqual(["#app-ready", "#nav"]);
    expect(readySelectorsFor("http://x/reports/q3")).toEqual(["#grid"]);
    expect(readySelectorsFor("http://x/settings")).toEqual([]);
  });

  it("waits for the route's readiness selector BEFORE the first action", async () => {
    setContext(createContext(root, { config: { ...DEFAULT_CONFIG, readySignals: { "**/workspace/**": "#app-ready" } } }));
    const b = new FakeBrowser("about:blank");
    await executePlan(b, plan("http://x/workspace/contacts"));
    expect(b.waited).toEqual(["#app-ready", "#add"]); // readiness gate, then a1
  });

  it("no gate when the route matches no glob", async () => {
    setContext(createContext(root, { config: { ...DEFAULT_CONFIG, readySignals: { "**/workspace/**": "#app-ready" } } }));
    const b = new FakeBrowser("about:blank");
    await executePlan(b, plan("http://x/settings"));
    expect(b.waited).toEqual(["#add"]); // only the action's own wait
  });

  it("best-effort: a readiness signal that never shows warns but does not fail the run", async () => {
    setContext(createContext(root, { config: { ...DEFAULT_CONFIG, readySignals: { "**/workspace/**": "#never" } } }));
    const b = new FakeBrowser("about:blank", (sel) => sel !== "#never"); // #never times out
    const result = await executePlan(b, plan("http://x/workspace/contacts"));
    expect(result.ok).toBe(true);
    expect(b.waited[0]).toBe("#never");
  });
});
