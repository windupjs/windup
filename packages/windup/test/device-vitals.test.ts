import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deviceSlug, deviceSuffix, activeDeviceName, resolveDeviceContext } from "../src/device.js";
import { budgetViolations, validateBudgets } from "../src/vitals.js";
import { getCached, saveCached } from "../src/cache.js";
import { createContext, setContext } from "../src/context.js";
import type { Plan, Scenario } from "../src/types.js";

afterEach(() => { delete process.env.WINDUP_DEVICE; setContext(createContext()); });

describe("device presets", () => {
  it("slugifies names and builds a cache suffix", () => {
    expect(deviceSlug("iPhone 14 Pro")).toBe("iphone-14-pro");
    expect(deviceSlug("Pixel 7")).toBe("pixel-7");
    expect(deviceSuffix()).toBe(""); // no device
    process.env.WINDUP_DEVICE = "iPhone 14";
    expect(activeDeviceName()).toBe("iPhone 14");
    expect(deviceSuffix()).toBe("@iphone-14");
  });

  it("resolves a known preset and throws on an unknown one", () => {
    expect(resolveDeviceContext()).toBeNull();
    process.env.WINDUP_DEVICE = "iPhone 14";
    const ctx = resolveDeviceContext();
    expect(ctx).toBeTruthy();
    expect(ctx).toHaveProperty("viewport");
    process.env.WINDUP_DEVICE = "NoSuchDevice 999";
    expect(() => resolveDeviceContext()).toThrow(/unknown device/);
  });

  it("keys the trajectory cache per device — mobile and desktop never collide", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "windup-devcache-"));
    setContext(createContext(root));
    const scenario: Scenario = { scenario_id: "checkout", start_url: "http://x/", task: "t" };
    const plan: Plan = { plan_version: "0.1", scenario_id: "checkout", start_url: "http://x/", task: "t", actions: [{ id: "a1", type: "wait_for", target: { selector: "#x", description: "x" }, expect: { selector: "#x" }, timeout_ms: 5000 }] };

    // desktop (no device)
    await saveCached(scenario, plan);
    expect(await getCached(scenario)).not.toBeNull();

    // mobile slot is empty until saved there
    process.env.WINDUP_DEVICE = "iPhone 14";
    expect(await getCached(scenario)).toBeNull(); // separate trajectory
    await saveCached(scenario, plan);
    expect(await getCached(scenario)).not.toBeNull();

    // back to desktop: still there, untouched by the mobile save
    delete process.env.WINDUP_DEVICE;
    expect(await getCached(scenario)).not.toBeNull();
  });
});

describe("web-vitals budgets", () => {
  const vitals = { ttfb_ms: 100, fcp_ms: 800, lcp_ms: 3000, dcl_ms: 1200, load_ms: 2500, cls: 0.05 };

  it("flags only exceeded budgets", () => {
    expect(budgetViolations(vitals, { lcp_ms: 2500 })[0]).toMatch(/LCP 3000ms > budget 2500ms/);
    expect(budgetViolations(vitals, { lcp_ms: 4000 })).toEqual([]); // within budget
    expect(budgetViolations(vitals, { cls: 0.1 })).toEqual([]);
    expect(budgetViolations(vitals, { cls: 0.01 })[0]).toMatch(/CLS 0.05 > budget 0.01/);
    expect(budgetViolations(vitals, undefined)).toEqual([]);
    expect(budgetViolations(null, { lcp_ms: 1 })).toEqual([]);
  });

  it("ignores a metric that wasn't captured (null)", () => {
    expect(budgetViolations({ ...vitals, lcp_ms: null }, { lcp_ms: 1 })).toEqual([]);
  });

  it("validates the budgets shape", () => {
    expect(validateBudgets({ lcp_ms: 2500, cls: 0.1 })).toEqual([]);
    expect(validateBudgets(undefined)).toEqual([]);
    expect(validateBudgets({ nope: 1 })[0]).toMatch(/unknown key "nope"/);
    expect(validateBudgets({ lcp_ms: -5 })[0]).toMatch(/non-negative/);
  });
});
