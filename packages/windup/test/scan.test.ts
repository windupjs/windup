import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractElements, formatElement } from "../src/scan/extract.js";
import { collectRouteSources, indexNextRoutes } from "../src/scan/nextjs.js";
import { createContext, setContext } from "../src/context.js";
import { SiteMapStore } from "../src/sitemap.js";
import { runScan } from "../src/scan/scan.js";
import { DEFAULT_CONFIG } from "../src/config.js";

const FIXTURE = path.resolve(import.meta.dirname, "fixtures", "next-app");

describe("indexNextRoutes (P2 layer 1)", () => {
  it("detects all convention-based routes (app + pages), ignoring api and groups", async () => {
    const routes = (await indexNextRoutes(FIXTURE)).map((r) => r.route).sort();
    // P2 criterion: ≥ 90% of the convention-based routes — in the fixture, 7/7 (100%).
    expect(routes).toEqual(["/", "/checkout", "/dashboard/settings", "/legacy", "/login", "/products", "/products/:id"]);
  });

  it("collects the route's composite sources (local and @/ imports)", async () => {
    const routes = await indexNextRoutes(FIXTURE);
    const home = routes.find((r) => r.route === "/")!;
    const files = await collectRouteSources(home, FIXTURE);
    expect(files.some((f) => f.endsWith("Hero.tsx"))).toBe(true);
  });
});

describe("extractElements (P2 layer 2)", () => {
  it("extracts id/name/data-test(id)/type/aria/placeholder from JSX", () => {
    const source = `
      <input id="email" name="email" type="email" data-testid="login-email" placeholder="Your e-mail" />
      <button type="submit" data-testid="login-submit">Sign in</button>
      <a href="/x">A link with text counts (the label is an identifiable trait)</a>
      <a href="/y"></a>
    `;
    const lines = extractElements(source).map(formatElement);
    expect(lines).toHaveLength(4); // href is an identifiable trait too
    expect(lines[0]).toContain("data-test=login-email");
    expect(lines[0]).toContain("id=email");
    expect(lines[1]).toContain("text=Sign in");
    expect(lines[2]).toContain("text=A link with text");
    expect(lines[3]).toContain("href=/y");
  });

  it("accepts attributes with JSX braces around string literals", () => {
    const lines = extractElements(`<button data-testid={"buy"} aria-label={'Buy'}>Go</button>`).map(formatElement);
    expect(lines[0]).toContain("data-test=buy");
    expect(lines[0]).toContain("aria-label=Buy");
  });
});

describe("runScan (P2 integration)", () => {
  it("populates the map with static nodes and the slice offers them by term matching", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "windup-scan-"));
    process.env.WINDUP_CACHE_DIR = path.join(dataDir, "cache");
    setContext({
      config: { ...DEFAULT_CONFIG, framework: "next", scan: { root: "." } },
      paths: {
        ...createContext(FIXTURE).paths,
        mapFile: path.join(dataDir, "site-map.json"),
      },
    });

    const summary = await runScan();
    expect(summary.framework).toBe("next");
    expect(summary.routes).toBe(7);
    expect(summary.elements).toBeGreaterThan(8);

    const store = await SiteMapStore.load(path.join(dataDir, "site-map.json"));
    expect(store.pageCount).toBe(7);
    const slice = store.sliceForPrompt("sig:desconhecida", "log in with e-mail and password", 8000);
    expect(slice).toContain("**/login");
    expect(slice).toContain("data-test=login-submit");
    expect(slice).toContain("detected in the source code");

    setContext(createContext());
  });
});

describe("extractElements with design-system components (shadcn/MUI)", () => {
  it("reads <Input>, <Button>, <Link to>, <Label htmlFor> as semantic elements", () => {
    const source = `
      <Label htmlFor="email" className={x}>E-mail</Label>
      <Input id="email" type="email" placeholder="you@corp.com" />
      <Button type="submit" data-testid="login-go">Sign in</Button>
      <Link to="/dashboard" className="nav">Dashboard</Link>
      <Switch id="dark-mode" />
    `;
    const lines = extractElements(source).map(formatElement);
    expect(lines.some((l) => l.startsWith("label") && l.includes("for=email") && l.includes("text=E-mail"))).toBe(true);
    expect(lines.some((l) => l.startsWith("input id=email") && l.includes("type=email"))).toBe(true);
    expect(lines.some((l) => l.startsWith("button") && l.includes("data-test=login-go"))).toBe(true);
    expect(lines.some((l) => l.startsWith("a") && l.includes("href=/dashboard") && l.includes("text=Dashboard"))).toBe(true);
    expect(lines.some((l) => l.startsWith("input id=dark-mode"))).toBe(true);
  });
});
