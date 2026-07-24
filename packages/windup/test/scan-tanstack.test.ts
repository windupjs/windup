import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { indexTanstackRoutes, toUrlPattern } from "../src/scan/tanstack-router.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "tanstack-app");

describe("TanStack Router indexer", () => {
  it("toUrlPattern handles the conventions", () => {
    expect(toUrlPattern("/")).toBe("/");
    expect(toUrlPattern("/workspace/loja/aparencia")).toBe("/workspace/loja/aparencia");
    expect(toUrlPattern("workspace.loja.aparencia")).toBe("/workspace/loja/aparencia"); // dot-notation
    expect(toUrlPattern("/loja/$companySlug/checkout/pagamento")).toBe("/loja/:companySlug/checkout/pagamento");
    expect(toUrlPattern("/_authenticated/_company/manager/companies")).toBe("/manager/companies"); // pathless
    expect(toUrlPattern("/posts/$postId")).toBe("/posts/:postId");
    expect(toUrlPattern("/posts/index")).toBe("/posts"); // index marker
    expect(toUrlPattern("posts_.$postId")).toBe("/posts/:postId"); // opt-out underscore
    expect(toUrlPattern("/$")).toBe("/*"); // splat
    expect(toUrlPattern("/__root")).toBeNull();
  });

  it("indexes the fixture with dot-notation, params, pathless layouts, and skips __root", async () => {
    const routes = await indexTanstackRoutes(fixture);
    const paths = routes.map((r) => r.route).sort();
    expect(paths).toEqual([
      "/",
      "/dashboard",
      "/loja/:companySlug/checkout/pagamento",
      "/manager/companies",
      "/posts/:postId",
      "/workspace/loja/aparencia",
      "/workspace/vendas",
    ]);
    // __root is not a URL
    expect(paths).not.toContain(null);
    // each route points at its source file
    const aparencia = routes.find((r) => r.route === "/workspace/loja/aparencia");
    expect(aparencia?.files[0]).toMatch(/workspace\.loja\.aparencia\.tsx$/);
  });
});
