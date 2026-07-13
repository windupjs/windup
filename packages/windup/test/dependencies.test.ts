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
  task: `tarefa ${id} com verificação final`,
  ...extra,
});

describe("dependências de cenários (depends_on)", () => {
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

  it("resolve a cadeia em ordem de execução, com dedupe", async () => {
    const registry = {
      login: scenario("login"),
      "abrir-empresa": scenario("abrir-empresa", { depends_on: ["login"] }),
      "criar-conta": scenario("criar-conta", { depends_on: ["abrir-empresa", "login"] }),
    };
    const chain = await resolveDependencyChain(registry["criar-conta"], loader(registry));
    expect(chain.map((s) => s.scenario_id)).toEqual(["login", "abrir-empresa"]);
  });

  it("detecta ciclo e estoura com mensagem clara", async () => {
    const registry = {
      a: scenario("a", { depends_on: ["b"] }),
      b: scenario("b", { depends_on: ["a"] }),
    };
    await expect(resolveDependencyChain(registry.a, loader(registry))).rejects.toThrow(/cycle/);
  });

  it("cenário sem start_url e com depends_on continua da página da dependência (loadScenario)", async () => {
    const dir = getContext().paths.scenariosDir;
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "criar-conta.json"),
      JSON.stringify({ scenario_id: "criar-conta", depends_on: ["login"], task: "criar a conta bancária e verificar na lista" }),
    );
    process.env.WINDUP_BASE_URL = "https://app.test";
    try {
      const loaded = await loadScenario("criar-conta");
      expect(loaded.continue_from_dependency).toBe(true);
      expect(loaded.depends_on).toEqual(["login"]);

      await writeFile(
        path.join(dir, "com-url.json"),
        JSON.stringify({ scenario_id: "com-url", depends_on: ["login"], start_url: "/painel", task: "abrir o painel e verificar o título" }),
      );
      const withUrl = await loadScenario("com-url");
      expect(withUrl.continue_from_dependency).toBe(false);
      expect(withUrl.start_url).toBe("https://app.test/painel");
    } finally {
      delete process.env.WINDUP_BASE_URL;
    }
  });

  it("planner de cenário dependente recebe skipGoto (planeja vendo a página pós-dependência)", async () => {
    // contrato da interface: o runner repassa { skipGoto: true } quando
    // continue_from_dependency; validado aqui no nível do tipo/chamada.
    const calls: Array<{ skipGoto?: boolean }> = [];
    const planner: Planner = {
      async generate(_s, _b, _f, opts) {
        calls.push(opts ?? {});
        throw new Error("stop"); // não precisamos executar de verdade
      },
    };
    await expect(planner.generate(scenario("x") as never, {} as never, undefined, { skipGoto: true })).rejects.toThrow("stop");
    expect(calls[0].skipGoto).toBe(true);
  });
});
