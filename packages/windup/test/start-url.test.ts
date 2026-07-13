import { afterEach, describe, expect, it } from "vitest";
import { resolveStartUrl, startPath } from "../src/start-url.js";
import { createContext, setContext } from "../src/context.js";
import { DEFAULT_CONFIG } from "../src/config.js";

const withBase = (baseUrl?: string) =>
  setContext(createContext(process.cwd(), { config: { ...DEFAULT_CONFIG, baseUrl } }));

afterEach(() => {
  delete process.env.WINDUP_BASE_URL;
  setContext(createContext());
});

describe("start URL resolution by environment", () => {
  it("relative resolves against the config baseUrl", () => {
    withBase("http://localhost:8082");
    expect(resolveStartUrl("/precos")).toBe("http://localhost:8082/precos");
  });

  it("absent becomes '/' on the baseUrl", () => {
    withBase("http://localhost:8082");
    expect(resolveStartUrl(undefined)).toBe("http://localhost:8082/");
  });

  it("WINDUP_BASE_URL overrides the config", () => {
    withBase("http://localhost:8082");
    process.env.WINDUP_BASE_URL = "https://staging.exemplo.com";
    expect(resolveStartUrl("/precos")).toBe("https://staging.exemplo.com/precos");
  });

  it("override REBASES even an absolute scenario URL (preserves path+query)", () => {
    withBase(undefined);
    process.env.WINDUP_BASE_URL = "https://staging.exemplo.com";
    expect(resolveStartUrl("http://localhost:8080/login?cadastro=1")).toBe("https://staging.exemplo.com/login?cadastro=1");
  });

  it("absolute without an override stays as is", () => {
    withBase("http://localhost:8082");
    expect(resolveStartUrl("http://outra:9999/x")).toBe("http://outra:9999/x");
  });

  it("relative without any base is a clear error", () => {
    withBase(undefined);
    expect(() => resolveStartUrl("/precos")).toThrow(/base URL/);
  });
});

describe("startPath (cache identity across environments)", () => {
  it("different ports/hosts, same identity", () => {
    expect(startPath("http://localhost:8080/precos")).toBe(startPath("https://staging.exemplo.com/precos"));
  });
  it("the querystring is part of the identity", () => {
    expect(startPath("http://a/x?y=1")).not.toBe(startPath("http://a/x"));
  });
});
