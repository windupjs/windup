import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { indexReactRouterRoutes } from "../src/scan/react-router.js";
import { createContext, setContext } from "../src/context.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { runScan } from "../src/scan/scan.js";
import { SiteMapStore } from "../src/sitemap.js";

const FIXTURE = path.resolve(import.meta.dirname, "fixtures", "react-router-app");

describe("indexReactRouterRoutes", () => {
  it("detects object routes, JSX <Route> and lazy imports", async () => {
    const routes = await indexReactRouterRoutes(FIXTURE);
    const paths = routes.map((r) => r.route).sort();
    expect(paths).toEqual(["/about", "/billing", "/dashboard", "/login", "/orders/:id", "/settings"]);
  });

  it("ignores path: keys in non-route configs (menus, API endpoints)", async () => {
    const routes = await indexReactRouterRoutes(FIXTURE);
    const paths = routes.map((r) => r.route);
    expect(paths).not.toContain("/reports/sales");
    expect(paths).not.toContain("/admin/users");
    expect(paths).not.toContain("/api/v1/orders");
  });

  it("links each route to its component file (element/lazy resolution)", async () => {
    const routes = await indexReactRouterRoutes(FIXTURE);
    const byRoute = Object.fromEntries(routes.map((r) => [r.route, r.files]));
    expect(byRoute["/login"].some((f) => f.endsWith("Login.tsx"))).toBe(true);
    expect(byRoute["/dashboard"].some((f) => f.endsWith("Dashboard.tsx"))).toBe(true);
    expect(byRoute["/orders/:id"].some((f) => f.endsWith("OrderDetail.tsx"))).toBe(true);
    expect(byRoute["/settings"].some((f) => f.endsWith("Settings.tsx"))).toBe(true);
  });

  it("resolve a página real dentro de wrappers de layout no element", async () => {
    const routes = await indexReactRouterRoutes(FIXTURE);
    const billing = routes.find((r) => r.route === "/billing")!;
    expect(billing.files.some((f) => f.endsWith("Billing.tsx"))).toBe(true);
    expect(billing.files.some((f) => f.endsWith("Shell.tsx"))).toBe(true);
  });
});

describe("runScan with react-router", () => {
  it("populates the site map and the slice surfaces route elements", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "windup-rr-"));
    process.env.WINDUP_CACHE_DIR = path.join(dataDir, "cache");
    setContext({
      config: { ...DEFAULT_CONFIG, framework: "react-router", scan: { root: "." } },
      paths: { ...createContext(FIXTURE).paths, mapFile: path.join(dataDir, "site-map.json") },
    });

    const summary = await runScan({ assist: false });
    expect(summary.framework).toBe("react-router");
    expect(summary.routes).toBe(6); // + /billing (fixture de wrapper)
    expect(summary.elements).toBeGreaterThan(5);

    const store = await SiteMapStore.load(path.join(dataDir, "site-map.json"));
    const slice = store.sliceForPrompt("sig:unknown", "login with email and password", 8000);
    expect(slice).toContain("**/login");
    expect(slice).toContain("data-test=login-submit");

    setContext(createContext());
  });
});
