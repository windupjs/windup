import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { computeCoverage } from "../src/coverage.js";
import { createContext, setContext } from "../src/context.js";

let root: string, dir: string, mapFile: string;

async function map(pages: Array<{ pattern: string; source?: string }>): Promise<void> {
  const rec: Record<string, unknown> = {};
  pages.forEach((p, i) => {
    rec[`p${i}`] = { urls_seen: [], url_pattern: p.pattern, title: "", interactive: [], source: p.source ?? "static", first_seen: "", last_seen: "", seen_count: 1 };
  });
  await writeFile(mapFile, JSON.stringify({ map_version: "0.1", last_scan_sha: null, transitions: [], pages: rec }));
}

const scenario = (id: string, startPath: string) =>
  writeFile(path.join(dir, `${id}.json`), JSON.stringify({ scenario_id: id, start_url: `http://x.test${startPath}`, task: "open and verify" }));

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "windup-cov-"));
  dir = path.join(root, "e2e");
  mapFile = path.join(root, ".windup/map/site-map.json");
  setContext(createContext(root, { scenariosDir: "e2e" }));
  await mkdir(dir, { recursive: true });
  await mkdir(path.dirname(mapFile), { recursive: true });
  process.env.WINDUP_BASE_URL = "http://x.test";
});
afterAll(() => { setContext(createContext()); delete process.env.WINDUP_BASE_URL; });

describe("windup coverage (routes × scenarios)", () => {
  it("reports which indexed routes have a scenario and which don't", async () => {
    await map([{ pattern: "**/workspace/contacts" }, { pattern: "**/workspace/deals" }, { pattern: "**/reports" }]);
    await scenario("contacts-list", "/workspace/contacts");
    await scenario("deals-list", "/workspace/deals");
    // no scenario for /reports
    const r = await computeCoverage();
    expect(r.total).toBe(3);
    expect(r.covered).toBe(2);
    expect(r.rate).toBe(0.667);
    expect(r.scenarios_total).toBe(2);
    const uncovered = r.routes.filter((x) => x.scenarios.length === 0).map((x) => x.url_pattern);
    expect(uncovered).toEqual(["**/reports"]);
    const contacts = r.routes.find((x) => x.url_pattern === "**/workspace/contacts");
    expect(contacts?.scenarios).toEqual(["contacts-list"]);
  });

  it("empty map → flagged (scan first)", async () => {
    await map([]);
    await scenario("x", "/x");
    const r = await computeCoverage();
    expect(r.empty_map).toBe(true);
    expect(r.total).toBe(0);
  });

  it("dedupes a route across sources, keeping the most confident", async () => {
    await map([{ pattern: "**/home", source: "static" }, { pattern: "**/home", source: "execution" }]);
    const r = await computeCoverage();
    expect(r.total).toBe(1);
    expect(r.routes[0].source).toBe("execution");
  });
});
