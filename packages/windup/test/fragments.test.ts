import { describe, expect, it } from "vitest";
import { expandPlan, formatCatalog } from "../src/fragments.js";
import { validatePlan } from "../src/schema.js";
import type { Fragment, Plan } from "../src/types.js";

const loginFragment: Fragment = {
  fragment_id: "login-padrao",
  description: "Login padrão",
  actions: [
    { id: "a1", type: "fill", target: { selector: "#user", description: "usuário" }, value: "u" },
    { id: "a2", type: "fill", target: { selector: "#pass", description: "senha" }, value_ref: "ENV:SENHA" },
    { id: "a3", type: "click", target: { selector: "#entrar", description: "entrar" }, expect: { url: "**/home" } },
  ],
  postcondition: { url: "**/home" },
};

const composedPlan: Plan = {
  plan_version: "0.1",
  scenario_id: "composto",
  start_url: "https://x.com",
  actions: [
    { id: "a1", type: "use", use: "login-padrao" },
    { id: "a2", type: "click", target: { selector: "#perfil", description: "perfil" }, expect: { selector: ".dados" } },
  ],
};

describe("expandPlan (E3)", () => {
  it("expande use inline e renumera os ids", () => {
    const expanded = expandPlan(composedPlan, [loginFragment]);
    expect(expanded.actions.map((a) => a.id)).toEqual(["a1", "a2", "a3", "a4"]);
    expect(expanded.actions[0].target?.selector).toBe("#user");
    expect(expanded.actions[3].target?.selector).toBe("#perfil");
  });

  it("não muta o plano original (o cache guarda a referência)", () => {
    expandPlan(composedPlan, [loginFragment]);
    expect(composedPlan.actions).toHaveLength(2);
    expect(composedPlan.actions[0].type).toBe("use");
  });

  it("fragmento desconhecido é erro", () => {
    expect(() => expandPlan(composedPlan, [])).toThrow(/inexistente/);
  });

  it("fragmento aninhando fragmento é erro (profundidade 1)", () => {
    const nested: Fragment = { ...loginFragment, actions: [{ id: "a1", type: "use", use: "outro" }] };
    expect(() => expandPlan(composedPlan, [nested])).toThrow(/profundidade/);
  });
});

describe("validatePlan com use (E3)", () => {
  it("aceita plano com ação use e sem expect na última quando ela é use", () => {
    const plan: Plan = {
      ...composedPlan,
      actions: [
        { id: "a1", type: "click", target: { selector: "#x", description: "x" } },
        { id: "a2", type: "use", use: "login-padrao" },
      ],
    };
    expect(validatePlan(plan).ok).toBe(true);
  });

  it("rejeita use sem o campo use", () => {
    const plan: Plan = { ...composedPlan, actions: [{ id: "a1", type: "use" }] };
    const result = validatePlan(plan);
    expect(result.ok).toBe(false);
    expect(result.errors.join()).toContain("exige o campo use");
  });
});

describe("formatCatalog", () => {
  it("expõe id, descrição e pós-condição — nunca as ações", () => {
    const catalog = formatCatalog([loginFragment]);
    expect(catalog).toContain("login-padrao");
    expect(catalog).toContain("Login padrão");
    expect(catalog).toContain("**/home");
    expect(catalog).not.toContain("#user");
  });
});
