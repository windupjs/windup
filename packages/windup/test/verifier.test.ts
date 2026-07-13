import { describe, expect, it } from "vitest";
import { urlMatches } from "../src/verifier.js";
import { resolveValue } from "../src/executor.js";
import type { Action } from "../src/types.js";

describe("urlMatches", () => {
  it("matches the **/inventory.html glob against a full URL", () => {
    expect(urlMatches("https://www.saucedemo.com/inventory.html", "**/inventory.html")).toBe(true);
  });

  it("ignores the query string", () => {
    expect(urlMatches("https://www.saucedemo.com/inventory.html?x=1", "**/inventory.html")).toBe(true);
  });

  it("does not match a different page", () => {
    expect(urlMatches("https://www.saucedemo.com/cart.html", "**/inventory.html")).toBe(false);
  });

  it("matches an exact URL without a glob", () => {
    expect(urlMatches("https://www.saucedemo.com/", "https://www.saucedemo.com/")).toBe(true);
  });

  it("matches a pattern written as a bare path against the pathname", () => {
    expect(urlMatches("https://opensource-demo.orangehrmlive.com/web/index.php/dashboard/index", "/web/index.php/dashboard/index")).toBe(true);
    expect(urlMatches("https://x.com/a/b", "/outro/caminho")).toBe(false);
  });
});

describe("resolveValue", () => {
  const base: Action = { id: "a1", type: "fill", target: { selector: "#x", description: "x" } };

  it("uses the literal value when present", () => {
    expect(resolveValue({ ...base, value: "abc" })).toBe("abc");
  });

  it("resolves value_ref ENV:*", () => {
    process.env.SPIKE_TEST_SECRET = "s3cret";
    expect(resolveValue({ ...base, value_ref: "ENV:SPIKE_TEST_SECRET" })).toBe("s3cret");
    delete process.env.SPIKE_TEST_SECRET;
  });

  it("fails if the variable does not exist", () => {
    expect(() => resolveValue({ ...base, value_ref: "ENV:SPIKE_NAO_EXISTE" })).toThrow(/is not set/);
  });
});
