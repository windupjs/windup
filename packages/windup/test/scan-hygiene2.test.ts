import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { createContext, setContext } from "../src/context.js";
import { runScan } from "../src/scan/scan.js";
import { SiteMapStore } from "../src/sitemap.js";
import type { AssistCaller } from "../src/scan/assist.js";

const FIXTURE = path.resolve(import.meta.dirname, "fixtures", "react-router-app");

async function setup(): Promise<{ root: string; mapFile: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "windup-h2-"));
  await cp(FIXTURE, root, { recursive: true });
  const mapFile = path.join(root, ".windup", "site-map.json");
  process.env.WINDUP_CACHE_DIR = path.join(root, ".windup", "cache");
  setContext({
    config: { ...DEFAULT_CONFIG, framework: "react-router", scan: { root: ".", llmAssist: { enabled: true, maxCalls: 5 } } },
    paths: { ...createContext(root).paths, mapFile, runsDir: path.join(root, ".windup", "runs") },
  });
  return { root, mapFile };
}

const fakeCaller = (counter: { calls: number }): AssistCaller => async () => {
  counter.calls += 1;
  return { text: JSON.stringify({ routes: [{ path: "/inferida", elements: ["button id=x"] }] }), tokens: { input: 100, output: 20 } };
};

describe("scan v0.8.1: assist cache, pruning and anti-barrel", () => {
  it("assist does not pay again for unchanged files; re-analyzes when the content changes", async () => {
    const { root } = await setup();
    const counter = { calls: 0 };
    await runScan({ assistCaller: fakeCaller(counter) });
    const firstCalls = counter.calls;
    expect(firstCalls).toBeGreaterThan(0);

    await runScan({ assistCaller: fakeCaller(counter) });
    expect(counter.calls).toBe(firstCalls); // nothing changed → zero new calls

    await writeFile(path.join(root, "src", "dynamicRoutes.tsx"), `import { createBrowserRouter } from "react-router-dom";\nexport const r = createBrowserRouter([]); // changed\n`);
    await runScan({ assistCaller: fakeCaller(counter) });
    expect(counter.calls).toBe(firstCalls + 1); // only the changed file re-analyzed

    setContext(createContext());
  }, 30_000);

  it("full scan prunes static nodes of routes removed from the code", async () => {
    const { root, mapFile } = await setup();
    await runScan({ assist: false });
    let store = await SiteMapStore.load(mapFile);
    const before = store.pageCount;

    await rm(path.join(root, "src", "pages", "Settings.tsx"));
    const app = await readFile(path.join(root, "src", "App.tsx"), "utf8");
    await writeFile(path.join(root, "src", "App.tsx"), app.replace(/<Route path="\/settings"[^/]*\/>/, "").replace(/import \{ Settings \}[^\n]*\n/, ""));

    await runScan({ assist: false });
    store = await SiteMapStore.load(mapFile);
    expect(store.pageCount).toBe(before - 1);
    expect(store.sliceForPrompt("sig:x", "settings tema theme", 8000)).not.toContain("**/settings");

    setContext(createContext());
  }, 30_000);

  it("anti-barrel: a route does not inherit elements from the other pages imported by the router file", async () => {
    const { mapFile } = await setup();
    await runScan({ assist: false });
    const raw = JSON.parse(await readFile(mapFile, "utf8"));
    const dashboard = Object.values(raw.pages).find((p: any) => p.url_pattern === "**/dashboard") as any;
    expect(dashboard).toBeDefined();
    const joined = dashboard.interactive.join("\n");
    expect(joined).toContain("dashboard-refresh");     // its own element
    expect(joined).not.toContain("login-email");       // does NOT inherit from router.tsx→Login
    expect(joined).not.toContain("report-export");     // nor from the router's other imports

    setContext(createContext());
  }, 30_000);
});
