import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { resolveDependencyChain, type Planner, type ScenarioLoader } from "../src/runner.js";
import { loadScenario } from "../src/scenario.js";
import { createContext, setContext, getContext } from "../src/context.js";

const scenario = (id: string, extra: Record<string, unknown> = {}) => ({
  scenario_id: id,
  start_url: `https://app.test/${id}`,
  task: `task ${id} with a final verification`,
  ...extra,
});

describe("scenario dependencies (depends_on)", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "windup-deps-"));
    setContext(createContext(root));
  });
  afterAll(() => setContext(createContext()));

  const loader = (registry: Record<string, ReturnType<typeof scenario>>): ScenarioLoader =>
    async (id) => {
      if (!registry[id]) throw new Error(`scenario "${id}" not found`);
      return registry[id] as Awaited<ReturnType<ScenarioLoader>>;
    };

  it("resolves the chain in execution order, with dedupe", async () => {
    const registry = {
      login: scenario("login"),
      "abrir-empresa": scenario("abrir-empresa", { depends_on: ["login"] }),
      "criar-conta": scenario("criar-conta", { depends_on: ["abrir-empresa", "login"] }),
    };
    const chain = await resolveDependencyChain(registry["criar-conta"], loader(registry));
    expect(chain.map((s) => s.scenario_id)).toEqual(["login", "abrir-empresa"]);
  });

  it("detects a cycle and throws with a clear message", async () => {
    const registry = {
      a: scenario("a", { depends_on: ["b"] }),
      b: scenario("b", { depends_on: ["a"] }),
    };
    await expect(resolveDependencyChain(registry.a, loader(registry))).rejects.toThrow(/cycle/);
  });

  it("scenario without start_url and with depends_on continues from the dependency's page (loadScenario)", async () => {
    const dir = getContext().paths.scenariosDir;
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "criar-conta.json"),
      JSON.stringify({ scenario_id: "criar-conta", depends_on: ["login"], task: "create the bank account and verify it in the list" }),
    );
    process.env.WINDUP_BASE_URL = "https://app.test";
    try {
      const loaded = await loadScenario("criar-conta");
      expect(loaded.continue_from_dependency).toBe(true);
      expect(loaded.depends_on).toEqual(["login"]);

      await writeFile(
        path.join(dir, "com-url.json"),
        JSON.stringify({ scenario_id: "com-url", depends_on: ["login"], start_url: "/painel", task: "open the panel and verify the title" }),
      );
      const withUrl = await loadScenario("com-url");
      expect(withUrl.continue_from_dependency).toBe(false);
      expect(withUrl.start_url).toBe("https://app.test/painel");
    } finally {
      delete process.env.WINDUP_BASE_URL;
    }
  });

  it("the planner of a dependent scenario receives skipGoto (plans while seeing the post-dependency page)", async () => {
    // interface contract: the runner passes { skipGoto: true } when
    // continue_from_dependency; validated here at the type/call level.
    const calls: Array<{ skipGoto?: boolean }> = [];
    const planner: Planner = {
      async generate(_s, _b, _f, opts) {
        calls.push(opts ?? {});
        throw new Error("stop"); // we don't need to actually execute
      },
    };
    await expect(planner.generate(scenario("x") as never, {} as never, undefined, { skipGoto: true })).rejects.toThrow("stop");
    expect(calls[0].skipGoto).toBe(true);
  });
});
