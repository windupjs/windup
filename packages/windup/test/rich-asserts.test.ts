import { describe, expect, it } from "vitest";
import { verify } from "../src/verifier.js";
import type { Browser } from "../src/browser.js";
import type { Expect } from "../src/types.js";

/** A minimal fake exposing only what the new expect kinds read. */
function fakeBrowser(state: {
  text?: Record<string, string>;
  counts?: Record<string, number>;
  attrs?: Record<string, Record<string, string>>;
  hidden?: Set<string>;
}): Browser {
  return {
    url: () => "http://x/",
    async textContent(sel: string) { return state.text?.[sel] ?? ""; },
    async count(sel: string) { return state.counts?.[sel] ?? 0; },
    async getAttribute(sel: string, name: string) { return state.attrs?.[sel]?.[name] ?? null; },
    async waitForHidden(sel: string) { return state.hidden?.has(sel) ?? false; },
    async waitForVisible() { return true; },
  } as unknown as Browser;
}

const T = 200; // short timeout so failing polls return fast

describe("verify() — richer assertions", () => {
  it("text_contains: passes on substring, fails otherwise", async () => {
    const b = fakeBrowser({ text: { "#s": "Order is Active now" } });
    expect((await verify(b, { text_contains: { selector: "#s", text: "Active" } }, T)).ok).toBe(true);
    const bad = await verify(b, { text_contains: { selector: "#s", text: "Cancelled" } }, T);
    expect(bad.ok).toBe(false);
    expect(bad.failed_condition).toMatch(/text_contains: #s expected to contain "Cancelled"/);
  });

  it("count: equals / min / max", async () => {
    const b = fakeBrowser({ counts: { ".row": 3 } });
    expect((await verify(b, { count: { selector: ".row", equals: 3 } }, T)).ok).toBe(true);
    expect((await verify(b, { count: { selector: ".row", min: 1, max: 5 } }, T)).ok).toBe(true);
    const bad = await verify(b, { count: { selector: ".row", equals: 2 } }, T);
    expect(bad.ok).toBe(false);
    expect(bad.failed_condition).toMatch(/count: \.row expected =2, got 3/);
  });

  it("not_visible: passes when hidden, fails when still visible", async () => {
    const b = fakeBrowser({ hidden: new Set(["#gone"]) });
    expect((await verify(b, { not_visible: "#gone" }, T)).ok).toBe(true);
    const bad = await verify(b, { not_visible: "#here" }, T);
    expect(bad.ok).toBe(false);
    expect(bad.failed_condition).toMatch(/not_visible: #here is still visible/);
  });

  it("attribute: exact match", async () => {
    const b = fakeBrowser({ attrs: { "#email": { "aria-invalid": "false" } } });
    expect((await verify(b, { attribute: { selector: "#email", name: "aria-invalid", value: "false" } }, T)).ok).toBe(true);
    const bad = await verify(b, { attribute: { selector: "#email", name: "aria-invalid", value: "true" } }, T);
    expect(bad.ok).toBe(false);
    expect(bad.failed_condition).toMatch(/attribute: #email\[aria-invalid\] expected "true", got "false"/);
  });

  it("all conditions AND together; empty expect passes trivially", async () => {
    const b = fakeBrowser({ text: { "#s": "ok" }, counts: { ".r": 1 } });
    const combo: Expect = { text_contains: { selector: "#s", text: "ok" }, count: { selector: ".r", equals: 1 } };
    expect((await verify(b, combo, T)).ok).toBe(true);
    expect((await verify(b, {}, T)).ok).toBe(true);
  });
});
