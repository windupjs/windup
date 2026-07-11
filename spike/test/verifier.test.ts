import { describe, expect, it } from "vitest";
import { urlMatches } from "../src/verifier.js";
import { resolveValue } from "../src/executor.js";
import type { Action } from "../src/types.js";

describe("urlMatches", () => {
  it("casa glob **/inventory.html com URL completa", () => {
    expect(urlMatches("https://www.saucedemo.com/inventory.html", "**/inventory.html")).toBe(true);
  });

  it("ignora query string", () => {
    expect(urlMatches("https://www.saucedemo.com/inventory.html?x=1", "**/inventory.html")).toBe(true);
  });

  it("não casa página diferente", () => {
    expect(urlMatches("https://www.saucedemo.com/cart.html", "**/inventory.html")).toBe(false);
  });

  it("casa URL exata sem glob", () => {
    expect(urlMatches("https://www.saucedemo.com/", "https://www.saucedemo.com/")).toBe(true);
  });
});

describe("resolveValue", () => {
  const base: Action = { id: "a1", type: "fill", target: { selector: "#x", description: "x" } };

  it("usa value literal quando presente", () => {
    expect(resolveValue({ ...base, value: "abc" })).toBe("abc");
  });

  it("resolve value_ref ENV:*", () => {
    process.env.SPIKE_TEST_SECRET = "s3cret";
    expect(resolveValue({ ...base, value_ref: "ENV:SPIKE_TEST_SECRET" })).toBe("s3cret");
    delete process.env.SPIKE_TEST_SECRET;
  });

  it("falha se a variável não existe", () => {
    expect(() => resolveValue({ ...base, value_ref: "ENV:SPIKE_NAO_EXISTE" })).toThrow(/não definida/);
  });
});
