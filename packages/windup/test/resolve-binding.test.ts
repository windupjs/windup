import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Browser, RawPageElement } from "../src/browser.js";
import { executePlan, resolveValue } from "../src/executor.js";
import { createContext, setContext } from "../src/context.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { validatePlan } from "../src/schema.js";
import type { Plan } from "../src/types.js";

/** Fake browser that records what got typed into each field. */
class RecordingBrowser implements Browser {
  fills: Array<{ selector: string; value: string }> = [];
  url(): string { return "http://x/checkout"; }
  async goto(): Promise<void> {}
  async waitForVisible(): Promise<boolean> { return true; }
  async waitForIdle(): Promise<void> {}
  async click(): Promise<void> {}
  async fill(selector: string, value: string): Promise<void> { this.fills.push({ selector, value }); }
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
  async startRecording(): Promise<void> {}
  async snapshotTree(): Promise<string> { return ""; }
  async interactiveElements(): Promise<string[]> { return ["x"]; }
  async interactiveElementsRaw(): Promise<RawPageElement[]> { return [{ tag: "input" } as RawPageElement]; }
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
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "windup-bind-")); });
afterAll(() => setContext(createContext()));

const plan = (fillValue: Partial<{ value: string; value_ref: string }>): Plan => ({
  plan_version: "0.1", scenario_id: "s", start_url: "http://x/checkout",
  actions: [{ id: "a1", type: "fill", target: { selector: "input#otp", description: "otp" }, ...fillValue, timeout_ms: 5000 }],
});

const withResolver = () => ({
  ...DEFAULT_CONFIG,
  resolve: { otp_code: { source: { kind: "cmd" as const, command: "echo 246810" }, extract: { regex: "(\\d+)" } } },
  resolveFields: { "#otp": "otp_code" },
});

describe("deterministic field → resolver binding (config.resolveFields)", () => {
  it("a bound field is filled from the resolver even when the plan put a LITERAL there", async () => {
    setContext(createContext(root, { config: withResolver() }));
    const b = new RecordingBrowser();
    await executePlan(b, plan({ value: "000000" })); // the LLM's wrong literal
    expect(b.fills).toEqual([{ selector: "input#otp", value: "246810" }]); // resolver won
  });

  it("also overrides a mis-named value_ref on a bound field", async () => {
    setContext(createContext(root, { config: withResolver() }));
    const b = new RecordingBrowser();
    await executePlan(b, plan({ value_ref: "OTP_CODE" })); // uppercase — would otherwise fail
    expect(b.fills[0].value).toBe("246810");
  });

  it("an UNBOUND field still uses the plan's value_ref, with name normalization", async () => {
    const ctx = { resolvers: { otp_code: { source: { kind: "cmd" as const, command: "echo 999" }, extract: { regex: "(\\d+)" } } }, vars: new Map<string, string>() };
    // OTP_CODE / otp-code both normalize to the declared otp_code
    expect(await resolveValue({ id: "a", type: "fill", value_ref: "OTP_CODE" }, ctx)).toBe("999");
    expect(await resolveValue({ id: "a", type: "fill", value_ref: "otp-code" }, ctx)).toBe("999");
  });
});

describe("schema tolerates the LLM's value_ref casing/dashes", () => {
  const base = { plan_version: "0.1", scenario_id: "s", start_url: "http://x/", actions: [{ id: "a1", type: "fill", target: { selector: "#o", description: "o" }, expect: { selector: "#done" } }] };
  it("accepts OTP_CODE and otp-code (normalized later), still rejects junk", () => {
    expect(validatePlan({ ...base, actions: [{ ...base.actions[0], value_ref: "OTP_CODE" }] }).ok).toBe(true);
    expect(validatePlan({ ...base, actions: [{ ...base.actions[0], value_ref: "otp-code" }] }).ok).toBe(true);
    expect(validatePlan({ ...base, actions: [{ ...base.actions[0], value_ref: "has spaces!" }] }).ok).toBe(false);
  });
});
