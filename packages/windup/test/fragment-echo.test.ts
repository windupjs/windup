import { describe, expect, it } from "vitest";
import { dropFragmentEchoes } from "../src/planner.js";
import type { Fragment, Plan } from "../src/types.js";

const LOGIN_FRAGMENT: Fragment = {
  fragment_id: "login",
  description: "Login padrão",
  actions: [
    { id: "a1", type: "fill", target: { selector: "#user", description: "usuário" }, value_ref: "ENV:U" },
    { id: "a2", type: "fill", target: { selector: "#password", description: "senha" }, value_ref: "ENV:P" },
    { id: "a3", type: "click", target: { selector: "#login-button", description: "entrar" } },
  ],
  postcondition: { selector: ".inventory_list" },
};

function plan(actions: Plan["actions"]): Plan {
  return { plan_version: "0.1", scenario_id: "s", start_url: "/", actions };
}

describe("dropFragmentEchoes (eco de fragmento pós-use)", () => {
  it("descarta a cauda do fragmento repetida logo após o use, preservando o expect final", () => {
    const p = plan([
      { id: "a1", type: "use", use: "login" },
      { id: "a2", type: "fill", target: { selector: "#password", description: "senha" } },
      { id: "a3", type: "click", target: { selector: "#login-button", description: "entrar" }, expect: { url: "**/inventory.html" } },
    ]);
    const result = dropFragmentEchoes(p, [LOGIN_FRAGMENT]);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toMatchObject({ id: "a1", type: "use", expect: { url: "**/inventory.html" } });
  });

  it("para na primeira ação que não duplica o fragmento (o resto do plano fica intacto)", () => {
    const p = plan([
      { id: "a1", type: "use", use: "login" },
      { id: "a2", type: "click", target: { selector: "#login-button", description: "eco" } },
      { id: "a3", type: "click", target: { selector: "#add-to-cart", description: "produto" }, expect: { selector: ".cart-badge" } },
    ]);
    const result = dropFragmentEchoes(p, [LOGIN_FRAGMENT]);
    expect(result.actions.map((a) => a.target?.selector ?? a.use)).toEqual(["login", "#add-to-cart"]);
    expect(result.actions[1].id).toBe("a2");
  });

  it("repetição legítima longe do use não é tocada; plano sem eco volta idêntico", () => {
    const p = plan([
      { id: "a1", type: "use", use: "login" },
      { id: "a2", type: "click", target: { selector: "#add-to-cart", description: "produto" } },
      { id: "a3", type: "click", target: { selector: "#login-button", description: "de novo, legítimo" }, expect: { selector: "x" } },
    ]);
    expect(dropFragmentEchoes(p, [LOGIN_FRAGMENT]).actions).toHaveLength(3);
  });

  it("use de fragmento desconhecido é ignorado (invalidação fica a cargo do expand)", () => {
    const p = plan([
      { id: "a1", type: "use", use: "inexistente" },
      { id: "a2", type: "click", target: { selector: "#login-button", description: "x" }, expect: { selector: "y" } },
    ]);
    expect(dropFragmentEchoes(p, [LOGIN_FRAGMENT]).actions).toHaveLength(2);
  });
});
