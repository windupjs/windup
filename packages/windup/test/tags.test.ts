import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { loadScenario, scenarioTagsById } from "../src/scenario.js";
import { createContext, setContext } from "../src/context.js";

let root: string, dir: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "windup-tags-"));
  dir = path.join(root, "e2e");
  setContext(createContext(root, { scenariosDir: "e2e" }));
  await mkdir(dir, { recursive: true });
  process.env.WINDUP_BASE_URL = "http://x.test";
});
afterAll(() => { setContext(createContext()); delete process.env.WINDUP_BASE_URL; });

const write = (id: string, tags?: unknown) =>
  writeFile(path.join(dir, `${id}.json`), JSON.stringify({ scenario_id: id, start_url: "http://x.test/", task: "open and verify", ...(tags !== undefined ? { tags } : {}) }));

describe("scenario tags (run --all --tag)", () => {
  it("scenarioTagsById maps ids to their tags", async () => {
    await write("a", ["smoke", "checkout"]);
    await write("b", ["checkout"]);
    await write("c"); // no tags
    const tags = await scenarioTagsById();
    expect(tags.get("a")).toEqual(["smoke", "checkout"]);
    expect(tags.get("b")).toEqual(["checkout"]);
    expect(tags.get("c")).toEqual([]);
    // the CLI's OR filter: which ids carry "smoke"?
    const wanted = new Set(["smoke"]);
    const smoke = [...tags.keys()].filter((id) => (tags.get(id) ?? []).some((t) => wanted.has(t)));
    expect(smoke).toEqual(["a"]);
  });

  it("rejects non-string tags", async () => {
    await write("bad", ["smoke", 3]);
    await expect(loadScenario("bad")).rejects.toThrow(/tags.*list of strings/);
  });
});
