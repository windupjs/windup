import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildManifestSection } from "../src/planner.js";
import { createContext, setContext } from "../src/context.js";
import { DEFAULT_CONFIG } from "../src/config.js";

let root: string;
beforeEach(async () => {
  // isolated root: a dogfood windup.credentials.json in the cwd must not
  // leak accounts into these "empty context" assertions
  root = await mkdtemp(path.join(tmpdir(), "windup-manifest-"));
});
afterAll(() => setContext(createContext()));

describe("project manifest in the prompt (E4)", () => {
  it("no context in the config → empty section", () => {
    setContext(createContext(root, { config: { ...DEFAULT_CONFIG, context: undefined } }));
    expect(buildManifestSection()).toBe("");
  });

  it("empty context → empty section", () => {
    setContext(createContext(root, { config: { ...DEFAULT_CONFIG, context: {} } }));
    expect(buildManifestSection()).toBe("");
  });

  it("renders conventions, credentials (with the value_ref instruction) and vocabulary", () => {
    setContext(
      createContext(root, {
        config: {
          ...DEFAULT_CONFIG,
          context: {
            conventions: ["every interactive element has data-test"],
            credentials: { admin: { user: "ENV:ADMIN_USER", password: "ENV:ADMIN_PASSWORD" } },
            vocabulary: { pedido: "Order entity, /orders screen" },
          },
        },
      }),
    );
    const section = buildManifestSection();
    expect(section).toContain("# Project manifest");
    expect(section).toContain("data-test");
    expect(section).toContain('account "admin"');
    expect(section).toContain("ENV:ADMIN_PASSWORD");
    expect(section).toContain("value_ref");
    expect(section).toContain('"pedido"');
  });

  it("respects the 4k chars cap", () => {
    setContext(
      createContext(root, {
        config: { ...DEFAULT_CONFIG, context: { conventions: Array.from({ length: 500 }, (_, i) => `convention ${i} ${"x".repeat(50)}`) } },
      }),
    );
    expect(buildManifestSection().length).toBeLessThanOrEqual(4_100);
  });
});

describe("invented-password guard (inventedPasswordFills)", () => {
  const plan = (value: string) => ({
    plan_version: "0.1" as const, scenario_id: "s", start_url: "/",
    actions: [
      { id: "a1", type: "fill" as const, target: { selector: "#email", description: "e-mail field" }, value: "kallef@x.com" },
      { id: "a2", type: "fill" as const, target: { selector: "#password", description: "password field" }, value },
    ],
  });

  it("a password that does not come from the task/hints/manifest is suspicious; the provided one is not", async () => {
    const { inventedPasswordFills } = await import("../src/planner.js");
    setContext(createContext(root, { config: { ...DEFAULT_CONFIG, context: {} } }));
    const scenario = { scenario_id: "s", task: "sign in with kallef@x.com and password ka211189" };
    expect(inventedPasswordFills(plan("password123"), scenario)).toEqual(["a2"]);
    expect(inventedPasswordFills(plan("ka211189"), scenario)).toEqual([]);
    // a signup with a fictitious password quoted in the task is legitimate
    const signup = { scenario_id: "s", task: "create an account filling in the password Abc123! and confirm" };
    expect(inventedPasswordFills(plan("Abc123!"), signup)).toEqual([]);
  });
});
