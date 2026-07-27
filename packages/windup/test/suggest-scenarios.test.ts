import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { suggestScenarios } from "../src/suggest-scenarios.js";
import { createContext, setContext, getContext } from "../src/context.js";
import type { LlmClient } from "../src/llm.js";

let root: string, dir: string, mapFile: string;

async function map(patterns: string[]): Promise<void> {
  const rec: Record<string, unknown> = {};
  patterns.forEach((pattern, i) => {
    rec[`p${i}`] = { urls_seen: [], url_pattern: pattern, title: "", interactive: ["button id=go"], source: "static", first_seen: "", last_seen: "", seen_count: 1 };
  });
  await writeFile(mapFile, JSON.stringify({ map_version: "0.1", last_scan_sha: null, transitions: [], pages: rec }));
}
const scenario = (id: string, startPath: string) =>
  writeFile(path.join(dir, `${id}.json`), JSON.stringify({ scenario_id: id, start_url: `http://x.test${startPath}`, task: "open and verify" }));

/** A fake LLM that authors a scenario for whatever route path the instruction names. */
function fakeClient(): LlmClient & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    provider: "google",
    model: "fake-model",
    prompts,
    async generate({ prompt }) {
      prompts.push(prompt);
      const m = prompt.match(/route `([^`]+)`/);
      const p = m ? m[1] : "/x";
      const id = `test${p.replace(/\W+/g, "-")}`;
      const text = JSON.stringify({ scenario_id: id, start_url: p, task: `Open ${p} and verify the primary result is visible on the page after acting.` });
      return { text, tokens: { input: 1000, output: 200 }, truncated: false };
    },
  };
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "windup-suggest-"));
  dir = path.join(root, "e2e");
  mapFile = path.join(root, ".windup/map/site-map.json");
  setContext(createContext(root, { scenariosDir: "e2e" }));
  await mkdir(dir, { recursive: true });
  await mkdir(path.dirname(mapFile), { recursive: true });
  process.env.WINDUP_BASE_URL = "http://x.test";
});
afterAll(() => { setContext(createContext()); delete process.env.WINDUP_BASE_URL; });

describe("windup suggest-scenarios", () => {
  it("authors a scenario only for UNCOVERED routes", async () => {
    await map(["**/contacts", "**/deals", "**/reports"]);
    await scenario("contacts-list", "/contacts"); // /deals and /reports are uncovered
    const client = fakeClient();
    const r = await suggestScenarios({ client });
    expect(r.uncovered).toBe(2);
    expect(r.generated).toHaveLength(2);
    expect(r.planned.sort()).toEqual(["/deals", "/reports"]);
    // it did NOT author for the covered /contacts route
    expect(client.prompts.some((p) => p.includes("`/contacts`"))).toBe(false);
    // files landed on disk
    const files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
    expect(files.length).toBe(3); // the original + 2 new
    // spend recorded as authoring in the ledger
    const runs = (await readdir(getContext().paths.runsDir)).filter((f) => f.startsWith("authoring-"));
    expect(runs.length).toBe(2);
  });

  it("respects --limit", async () => {
    await map(["**/a", "**/b", "**/c"]);
    const r = await suggestScenarios({ limit: 1, client: fakeClient() });
    expect(r.uncovered).toBe(3);
    expect(r.attempted).toBe(1);
    expect(r.generated).toHaveLength(1);
  });

  it("--dry-run lists routes without calling the LLM or writing files", async () => {
    await map(["**/a", "**/b"]);
    const client = fakeClient();
    const r = await suggestScenarios({ dryRun: true, client });
    expect(r.dry_run).toBe(true);
    expect(r.planned.sort()).toEqual(["/a", "/b"]);
    expect(r.generated).toHaveLength(0);
    expect(client.prompts).toHaveLength(0); // no LLM call
    expect((await readdir(dir)).filter((f) => f.endsWith(".json"))).toHaveLength(0); // nothing written
  });

  it("reports an empty map", async () => {
    await map([]);
    const r = await suggestScenarios({ client: fakeClient() });
    expect(r.empty_map).toBe(true);
  });
});
