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

describe("resolução de start URL por ambiente", () => {
  it("relativo resolve contra a baseUrl da config", () => {
    withBase("http://localhost:8082");
    expect(resolveStartUrl("/precos")).toBe("http://localhost:8082/precos");
  });

  it("ausente vira '/' na baseUrl", () => {
    withBase("http://localhost:8082");
    expect(resolveStartUrl(undefined)).toBe("http://localhost:8082/");
  });

  it("WINDUP_BASE_URL sobrescreve a config", () => {
    withBase("http://localhost:8082");
    process.env.WINDUP_BASE_URL = "https://staging.exemplo.com";
    expect(resolveStartUrl("/precos")).toBe("https://staging.exemplo.com/precos");
  });

  it("override REBASEIA até URL absoluta do cenário (preserva path+query)", () => {
    withBase(undefined);
    process.env.WINDUP_BASE_URL = "https://staging.exemplo.com";
    expect(resolveStartUrl("http://localhost:8080/login?cadastro=1")).toBe("https://staging.exemplo.com/login?cadastro=1");
  });

  it("absoluta sem override permanece", () => {
    withBase("http://localhost:8082");
    expect(resolveStartUrl("http://outra:9999/x")).toBe("http://outra:9999/x");
  });

  it("relativo sem nenhuma base é erro claro", () => {
    withBase(undefined);
    expect(() => resolveStartUrl("/precos")).toThrow(/base URL/);
  });
});

describe("startPath (identidade do cache entre ambientes)", () => {
  it("portas/hosts diferentes, mesma identidade", () => {
    expect(startPath("http://localhost:8080/precos")).toBe(startPath("https://staging.exemplo.com/precos"));
  });
  it("querystring faz parte da identidade", () => {
    expect(startPath("http://a/x?y=1")).not.toBe(startPath("http://a/x"));
  });
});
