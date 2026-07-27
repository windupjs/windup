import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Browser, RawPageElement } from "../src/browser.js";
import { executePlan, forbiddenViolation } from "../src/executor.js";
import { createContext, setContext } from "../src/context.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { Action, Plan } from "../src/types.js";

class FakeBrowser implements Browser {
  private _url: string;
  constructor(url: string) { this._url = url; }
  url(): string { return this._url; }
  async goto(u: string): Promise<void> { this._url = u; }
  async waitForVisible(): Promise<boolean> { return true; }
  async waitForIdle(): Promise<void> {}
  async click(): Promise<void> {}
  async fill(): Promise<void> {}
  armDialog(): void {}
  async isVisible(): Promise<boolean> { return true; }
  async inputValue(): Promise<string> { return ""; }
  async textContent(): Promise<string> { return ""; }
  async count(): Promise<number> { return 0; }
  async getAttribute(): Promise<string | null> { return null; }
  async waitForHidden(): Promise<boolean> { return true; }
  consoleErrors(): string[] { return []; }
  failedResponses(): { url: string; status: number; method: string }[] { return []; }
  async webVitals(): Promise<import("../src/vitals.js").WebVitals> { return { ttfb_ms: null, fcp_ms: null, lcp_ms: null, dcl_ms: null, load_ms: null, cls: null }; }
  async snapshotTree(): Promise<string> { return ""; }
  async interactiveElements(): Promise<string[]> { return ["x"]; }
  async interactiveElementsRaw(): Promise<RawPageElement[]> { return [{ tag: "button" } as RawPageElement]; }
  async pageSignature(): Promise<string> { return "sig"; }
  async title(): Promise<string> { return ""; }
  async storageState(): Promise<unknown> { return { cookies: [], origins: [] }; }
  async seedStorage(): Promise<void> {}
  async runAxe(): Promise<import("../src/browser.js").A11yViolation[]> { return []; }
  async saveTrace(): Promise<void> {}
  async screenshot(): Promise<void> {}
  setDialogHandler(): void {}
  async clickByDescription(): Promise<boolean> { return false; }
  async fillByDescription(): Promise<boolean> { return false; }
  async isVisibleByDescription(): Promise<boolean> { return false; }
  async close(): Promise<void> {}
}

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "windup-forbid-")); });
afterAll(() => setContext(createContext()));

const action = (over: Partial<Action>): Action => ({ id: "a1", type: "click", target: { selector: "#x", description: "x" }, ...over } as Action);

describe("forbiddenViolation (config.forbid)", () => {
  it("blocks a forbidden selector (substring) and a forbidden URL (glob)", () => {
    setContext(createContext(root, { config: { ...DEFAULT_CONFIG, forbid: { selectors: ["#change-password"], urls: ["**/account/password"] } } }));
    expect(forbiddenViolation(action({ target: { selector: "button#change-password-submit", description: "" } }), "http://x/settings")).toMatch(/forbidden selector/);
    expect(forbiddenViolation(action({ type: "goto", url: "http://x/account/password" }), "http://x/settings")).toMatch(/forbidden URL/);
    expect(forbiddenViolation(action({}), "http://x/account/password")).toMatch(/forbidden URL/); // current page is forbidden
    expect(forbiddenViolation(action({}), "http://x/dashboard")).toBeNull();
  });

  it("no forbid config → never blocks", () => {
    setContext(createContext(root, { config: { ...DEFAULT_CONFIG } }));
    expect(forbiddenViolation(action({ target: { selector: "#change-password", description: "" } }), "http://x/account/password")).toBeNull();
  });
});

describe("executePlan aborts on a forbidden action", () => {
  const plan = (sel: string): Plan => ({
    plan_version: "0.1", scenario_id: "s", start_url: "http://x/settings",
    actions: [{ id: "a1", type: "click", target: { selector: sel, description: "danger" }, timeout_ms: 5000 }],
  });

  it("returns a `forbidden` failure instead of clicking", async () => {
    setContext(createContext(root, { config: { ...DEFAULT_CONFIG, forbid: { selectors: ["#delete-account"] } } }));
    const res = await executePlan(new FakeBrowser("http://x/settings"), plan("#delete-account"));
    expect(res.ok).toBe(false);
    expect(res.failure?.kind).toBe("forbidden");
    expect(res.failure?.action_id).toBe("a1");
  });

  it("allows a safe action through", async () => {
    setContext(createContext(root, { config: { ...DEFAULT_CONFIG, forbid: { selectors: ["#delete-account"] } } }));
    const res = await executePlan(new FakeBrowser("http://x/settings"), plan("#save-draft"));
    expect(res.ok).toBe(true);
  });
});
