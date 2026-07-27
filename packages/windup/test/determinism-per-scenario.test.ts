import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { effectiveNetwork } from "../src/network.js";
import { effectiveClock } from "../src/clock.js";
import { loadScenario } from "../src/scenario.js";
import { createContext, setContext } from "../src/context.js";
import type { NetworkRule } from "../src/config.js";

describe("effectiveNetwork — merge scenario over global (scenario wins)", () => {
  const g: NetworkRule[] = [{ url: "/api/list", status: 200 }, { url: "/api/other", status: 200 }];
  const s: NetworkRule[] = [{ url: "/api/list", status: 500 }];

  it("puts scenario rules first so they win on overlapping URLs, global falls through", () => {
    const eff = effectiveNetwork(s, g);
    expect(eff).toEqual([{ url: "/api/list", status: 500 }, { url: "/api/list", status: 200 }, { url: "/api/other", status: 200 }]);
    expect(eff![0]).toBe(s[0]); // scenario rule is matched first
  });
  it("returns the global rules unchanged when the scenario declares none", () => {
    expect(effectiveNetwork(undefined, g)).toBe(g);
    expect(effectiveNetwork([], g)).toBe(g);
  });
  it("returns just the scenario rules when there is no global config", () => {
    expect(effectiveNetwork(s, undefined)).toEqual(s);
  });
  it("is undefined when neither side declares network", () => {
    expect(effectiveNetwork(undefined, undefined)).toBeUndefined();
  });
});

describe("effectiveClock — field-wise merge (scenario fields win)", () => {
  it("overrides each field, falling back to the global value", () => {
    expect(effectiveClock({ now: "2020-01-01" }, { timezone: "UTC" })).toEqual({ now: "2020-01-01", timezone: "UTC" });
    expect(effectiveClock({ now: "2020-01-01", timezone: "America/Sao_Paulo" }, { now: "1999-12-31", timezone: "UTC" })).toEqual({ now: "2020-01-01", timezone: "America/Sao_Paulo" });
  });
  it("returns the global clock unchanged when the scenario declares none", () => {
    const gc = { now: "2020-01-01" };
    expect(effectiveClock(undefined, gc)).toBe(gc);
  });
  it("is undefined when neither side declares a clock", () => {
    expect(effectiveClock(undefined, undefined)).toBeUndefined();
  });
});

describe("loadScenario — per-scenario network/clock validation", () => {
  let root: string;
  const write = async (id: string, body: object) => {
    const dir = path.join(root, "e2e", "scenarios");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `${id}.json`), JSON.stringify(body));
  };
  beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "windup-det-")); setContext(createContext(root)); });
  afterAll(() => setContext(createContext()));

  it("accepts a valid per-scenario network + clock", async () => {
    await write("ok", { scenario_id: "ok", start_url: "https://app.test/", task: "do it and verify", network: [{ url: "/api/list", status: 500 }], clock: { now: "2020-01-01T00:00:00Z", timezone: "UTC" } });
    const sc = await loadScenario("ok");
    expect(sc.network).toEqual([{ url: "/api/list", status: 500 }]);
    expect(sc.clock).toEqual({ now: "2020-01-01T00:00:00Z", timezone: "UTC" });
  });
  it("rejects an invalid network rule with a scenario-flavoured message", async () => {
    await write("bad-net", { scenario_id: "bad-net", task: "t and verify", network: [{ url: "", status: 999 }] });
    await expect(loadScenario("bad-net")).rejects.toThrow(/scenario "bad-net":.*"network"/);
  });
  it("rejects an invalid clock", async () => {
    await write("bad-clk", { scenario_id: "bad-clk", task: "t and verify", clock: { now: "not-a-date" } });
    await expect(loadScenario("bad-clk")).rejects.toThrow(/scenario "bad-clk":.*"clock"/);
  });
});
