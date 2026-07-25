import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { planPaths, selectAffected, touchesAffected } from "../src/changed.js";
import { createContext, setContext } from "../src/context.js";
import type { CacheEntry, Plan } from "../src/types.js";

const exec = promisify(execFile);

function plan(over: Partial<Plan>): Plan {
  return { plan_version: "0.1", scenario_id: "s", start_url: "http://x.test/", actions: [], ...over };
}

describe("change-impact matching helpers", () => {
  it("planPaths extracts pathnames from start_url + action urls", () => {
    const p = plan({ start_url: "http://app.test/workspace/contacts", actions: [{ id: "a1", type: "goto", url: "/workspace/deals" } as never] });
    expect(planPaths(p).sort()).toEqual(["/workspace/contacts", "/workspace/deals"]);
  });

  it("touchesAffected matches a plan path against a route glob (leading slash tolerant)", () => {
    const p = plan({ start_url: "http://app.test/workspace/contacts" });
    expect(touchesAffected(p, new Set(["**/workspace/contacts"]))).toBe(true);
    expect(touchesAffected(p, new Set(["**/workspace/deals"]))).toBe(false);
    expect(touchesAffected(p, new Set())).toBe(false);
  });
});

describe("selectAffected (incremental --changed/--since)", () => {
  let root: string, cacheDir: string, mapFile: string;

  async function git(...args: string[]): Promise<void> {
    await exec("git", args, { cwd: root });
  }

  async function writeCache(id: string, task: string, startPath: string): Promise<void> {
    const entry: CacheEntry = {
      cache_version: "0.2",
      key: { scenario_id: id, start_url: startPath },
      plan: plan({ scenario_id: id, task, start_url: `http://x.test${startPath}` }),
      status: "active",
      stats: { created_at: "2026-01-01T00:00:00Z", last_replayed_at: null, replay_count: 1, replay_failures: 0, plan_generation: 1 },
    };
    await writeFile(path.join(cacheDir, `${id}.json`), JSON.stringify(entry));
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "windup-changed-"));
    cacheDir = path.join(root, ".windup/cache/trajetorias");
    mapFile = path.join(root, ".windup/map/site-map.json");
    setContext(createContext(root, { scenariosDir: "e2e" }));
    await mkdir(path.join(root, "e2e"), { recursive: true });
    await mkdir(path.join(root, "src/routes"), { recursive: true });
    await mkdir(cacheDir, { recursive: true });
    await mkdir(path.dirname(mapFile), { recursive: true });

    // Two scenarios, each pinned to a distinct route.
    await writeFile(path.join(root, "e2e/contacts.json"), JSON.stringify({ scenario_id: "contacts", start_url: "http://x.test/workspace/contacts", task: "open contacts" }));
    await writeFile(path.join(root, "e2e/deals.json"), JSON.stringify({ scenario_id: "deals", start_url: "http://x.test/workspace/deals", task: "open deals" }));
    await writeCache("contacts", "open contacts", "/workspace/contacts");
    await writeCache("deals", "open deals", "/workspace/deals");

    // Two route source files, indexed in the map.
    await writeFile(path.join(root, "src/routes/contacts.tsx"), "export const contacts = 1;\n");
    await writeFile(path.join(root, "src/routes/deals.tsx"), "export const deals = 1;\n");
    const map = {
      map_version: "0.1", last_scan_sha: null, transitions: [],
      pages: {
        p1: { urls_seen: [], url_pattern: "**/workspace/contacts", title: "", interactive: [], source: "static", first_seen: "", last_seen: "", seen_count: 1, files: [path.join(root, "src/routes/contacts.tsx")] },
        p2: { urls_seen: [], url_pattern: "**/workspace/deals", title: "", interactive: [], source: "static", first_seen: "", last_seen: "", seen_count: 1, files: [path.join(root, "src/routes/deals.tsx")] },
      },
    };
    await writeFile(mapFile, JSON.stringify(map));

    await git("init", "-q");
    await git("config", "user.email", "t@t.test");
    await git("config", "user.name", "t");
    await git("add", "-A");
    await git("commit", "-qm", "base");
  });
  afterAll(() => setContext(createContext()));

  it("no changes → runs nothing", async () => {
    const sel = await selectAffected(["contacts", "deals"], "HEAD");
    expect(sel.run).toEqual([]);
    expect(sel.skipped.sort()).toEqual(["contacts", "deals"]);
  });

  it("a route source change runs only scenarios whose plan touches that route", async () => {
    await writeFile(path.join(root, "src/routes/contacts.tsx"), "export const contacts = 2; // edit\n");
    const sel = await selectAffected(["contacts", "deals"], "HEAD");
    expect(sel.run).toEqual(["contacts"]);
    expect(sel.skipped).toEqual(["deals"]);
  });

  it("a scenario file change always runs that scenario", async () => {
    await writeFile(path.join(root, "e2e/deals.json"), JSON.stringify({ scenario_id: "deals", start_url: "http://x.test/workspace/deals", task: "open deals and verify" }));
    const sel = await selectAffected(["contacts", "deals"], "HEAD");
    expect(sel.run).toEqual(["deals"]);
  });

  it("an unattributed source change is conservative — runs all", async () => {
    await writeFile(path.join(root, "src/shared-util.ts"), "export const x = 1;\n");
    await git("add", "-A"); // untracked files don't show in `git diff HEAD`
    const sel = await selectAffected(["contacts", "deals"], "HEAD");
    expect(sel.run.sort()).toEqual(["contacts", "deals"]);
    expect(sel.reason).toMatch(/not attributed/);
  });
});
