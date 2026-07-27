import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { A11yViolation, Browser, RawPageElement } from "../src/browser.js";
import { executePlan } from "../src/executor.js";
import { createContext, setContext } from "../src/context.js";
import type { Plan } from "../src/types.js";

/** Fake where the plan's SELECTOR never resolves, but the label fallback can. */
class LabelBrowser implements Browser {
  clicked: string[] = [];
  constructor(private readonly byDescWorks: boolean) {}
  url(): string { return "http://x/form"; }
  async goto(): Promise<void> {}
  async waitForVisible(selector: string): Promise<boolean> { return selector === "#saved"; } // target selector misses; the expect() postcondition is visible
  async waitForIdle(): Promise<void> {}
  async click(): Promise<void> {}
  async fill(): Promise<void> {}
  armDialog(): void {}
  setDialogHandler(): void {}
  async clickByDescription(d: string): Promise<boolean> { if (this.byDescWorks) { this.clicked.push(d); return true; } return false; }
  async fillByDescription(): Promise<boolean> { return this.byDescWorks; }
  async isVisibleByDescription(): Promise<boolean> { return this.byDescWorks; }
  async isVisible(): Promise<boolean> { return true; } // expect() verify passes; the point is the action recovery
  async inputValue(): Promise<string> { return ""; }
  async textContent(): Promise<string> { return ""; }
  async count(): Promise<number> { return 0; }
  async getAttribute(): Promise<string | null> { return null; }
  async waitForHidden(): Promise<boolean> { return true; }
  consoleErrors(): string[] { return []; }
  failedResponses(): { url: string; status: number; method: string }[] { return []; }
  async snapshotTree(): Promise<string> { return ""; }
  async interactiveElements(): Promise<string[]> { return []; }
  async interactiveElementsRaw(): Promise<RawPageElement[]> { return [{ tag: "input" } as RawPageElement]; }
  async pageSignature(): Promise<string> { return "sig"; }
  async title(): Promise<string> { return ""; }
  async storageState(): Promise<unknown> { return { cookies: [], origins: [] }; }
  async seedStorage(): Promise<void> {}
  async runAxe(): Promise<A11yViolation[]> { return []; }
  async saveTrace(): Promise<void> {}
  async screenshot(): Promise<void> {}
  async close(): Promise<void> {}
}

const plan = (): Plan => ({
  plan_version: "0.1", scenario_id: "s", start_url: "http://x/form",
  actions: [{ id: "a1", type: "click", target: { selector: "#measurementId", description: "Measurement ID" }, expect: { selector: "#saved" }, timeout_ms: 500 }],
});

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "windup-label-")); setContext(createContext(root)); });
afterAll(() => setContext(createContext()));

describe("accessibility label fallback (#2.2)", () => {
  it("recovers a wrong-selector target by its accessible name, and notes it", async () => {
    const b = new LabelBrowser(true);
    const res = await executePlan(b, plan());
    expect(b.clicked).toEqual(["Measurement ID"]); // acted via the label fallback
    expect(res.actions[0].note).toMatch(/found "Measurement ID" by label/);
    expect(res.actions[0].status).toBe("passed");
  });

  it("fails with an a11y-flavoured message when neither selector nor label resolves", async () => {
    const b = new LabelBrowser(false);
    const res = await executePlan(b, plan());
    expect(res.ok).toBe(false);
    expect(res.failure?.message).toMatch(/no single field matches "Measurement ID".*accessible label \(a11y gap\)/);
  });
});
