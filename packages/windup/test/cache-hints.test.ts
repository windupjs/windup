import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getCached, saveCached, scenarioSig } from "../src/cache.js";
import { createContext, setContext } from "../src/context.js";
import type { Plan, Scenario } from "../src/types.js";

const scenario = (over: Partial<Scenario> = {}): Scenario => ({
  scenario_id: "listing",
  start_url: "https://app.test/list",
  task: "Open the list and verify the first row appears.",
  ...over,
} as Scenario);

const plan: Plan = {
  plan_version: "0.1", scenario_id: "listing", start_url: "https://app.test/list",
  task: "Open the list and verify the first row appears.",
  actions: [{ id: "a1", type: "wait_for", target: { selector: "#row", description: "row" }, expect: { selector: "#row" }, timeout_ms: 5000 }],
} as never;

beforeEach(async () => setContext(createContext(await mkdtemp(path.join(tmpdir(), "windup-hints-")))));
afterAll(() => setContext(createContext()));

describe("editing hints invalidates the cache (#3)", () => {
  it("hits when nothing changed", async () => {
    await saveCached(scenario(), plan);
    expect(await getCached(scenario())).not.toBeNull();
  });

  it("MISSES when only the hints array changed — the planner must run again", async () => {
    await saveCached(scenario({ hints: ["old hint"] }), plan);
    expect(await getCached(scenario({ hints: ["old hint"] }))).not.toBeNull();
    expect(await getCached(scenario({ hints: ["a completely different hint"] }))).toBeNull();
    expect(await getCached(scenario({ hints: [] }))).toBeNull();
    expect(await getCached(scenario())).toBeNull(); // hints removed entirely
  });

  it("misses when hint ORDER changes (order reaches the prompt verbatim)", async () => {
    await saveCached(scenario({ hints: ["one", "two"] }), plan);
    expect(await getCached(scenario({ hints: ["two", "one"] }))).toBeNull();
  });

  it("misses when atomic_steps flips (it changes the prompt)", async () => {
    await saveCached(scenario(), plan);
    expect(await getCached(scenario({ atomic_steps: true }))).toBeNull();
  });

  it("still HITS when a runtime-only field changes — editing those must not cost a re-plan", async () => {
    await saveCached(scenario(), plan);
    expect(await getCached(scenario({ tags: ["smoke"] }))).not.toBeNull();
    expect(await getCached(scenario({ on_dialog: "accept" }))).not.toBeNull();
    expect(await getCached(scenario({ quarantine: true }))).not.toBeNull();
    expect(await getCached(scenario({ network: [{ url: "/api", status: 500 }] }))).not.toBeNull();
  });

  it("an entry written before this field existed still hits (no forced paid re-plan on upgrade)", async () => {
    await saveCached(scenario({ hints: ["x"] }), plan);
    // Simulate a pre-1.5.0 entry: same file, but the key carries no scenario_sig.
    const { readFile, writeFile } = await import("node:fs/promises");
    const { cacheDir } = await import("../src/cache.js");
    const file = path.join(cacheDir(), "listing.json");
    const entry = JSON.parse(await readFile(file, "utf8")) as { key: Record<string, unknown> };
    delete entry.key.scenario_sig;
    await writeFile(file, JSON.stringify(entry));
    expect(await getCached(scenario({ hints: ["totally different"] }))).not.toBeNull();
  });
});

describe("scenarioSig", () => {
  it("is stable for equal input and differs on a hint edit", () => {
    expect(scenarioSig(scenario({ hints: ["a"] }))).toBe(scenarioSig(scenario({ hints: ["a"] })));
    expect(scenarioSig(scenario({ hints: ["a"] }))).not.toBe(scenarioSig(scenario({ hints: ["b"] })));
  });
});
