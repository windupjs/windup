import { afterAll, describe, expect, it } from "vitest";
import { buildManifestSection } from "../src/planner.js";
import { createContext, setContext } from "../src/context.js";
import { DEFAULT_CONFIG } from "../src/config.js";

afterAll(() => setContext(createContext()));

describe("manifesto do projeto no prompt (E4)", () => {
  it("sem context na config → seção vazia", () => {
    setContext(createContext(process.cwd(), { config: { ...DEFAULT_CONFIG, context: undefined } }));
    expect(buildManifestSection()).toBe("");
  });

  it("context vazio → seção vazia", () => {
    setContext(createContext(process.cwd(), { config: { ...DEFAULT_CONFIG, context: {} } }));
    expect(buildManifestSection()).toBe("");
  });

  it("renderiza convenções, credenciais (com instrução de value_ref) e vocabulário", () => {
    setContext(
      createContext(process.cwd(), {
        config: {
          ...DEFAULT_CONFIG,
          context: {
            conventions: ["todo elemento interativo tem data-test"],
            credentials: { admin: { user: "ENV:ADMIN_USER", password: "ENV:ADMIN_PASSWORD" } },
            vocabulary: { pedido: "entidade Order, tela /orders" },
          },
        },
      }),
    );
    const section = buildManifestSection();
    expect(section).toContain("# Manifesto do projeto");
    expect(section).toContain("data-test");
    expect(section).toContain('conta "admin"');
    expect(section).toContain("ENV:ADMIN_PASSWORD");
    expect(section).toContain("value_ref");
    expect(section).toContain('"pedido"');
  });

  it("respeita o cap de 4k chars", () => {
    setContext(
      createContext(process.cwd(), {
        config: { ...DEFAULT_CONFIG, context: { conventions: Array.from({ length: 500 }, (_, i) => `convenção ${i} ${"x".repeat(50)}`) } },
      }),
    );
    expect(buildManifestSection().length).toBeLessThanOrEqual(4_100);
  });
});
