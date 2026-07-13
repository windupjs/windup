import { describe, expect, it } from "vitest";
import { dropFragmentEchoes } from "../src/planner.js";
import type { Fragment, Plan } from "../src/types.js";

const LOGIN_FRAGMENT: Fragment = {
  fragment_id: "login",
  description: "Standard login",
  actions: [
    { id: "a1", type: "fill", target: { selector: "#user", description: "username" }, value_ref: "ENV:U" },
    { id: "a2", type: "fill", target: { selector: "#password", description: "password" }, value_ref: "ENV:P" },
    { id: "a3", type: "click", target: { selector: "#login-button", description: "sign in" } },
  ],
  postcondition: { selector: ".inventory_list" },
};

function plan(actions: Plan["actions"]): Plan {
  return { plan_version: "0.1", scenario_id: "s", start_url: "/", actions };
}

describe("dropFragmentEchoes (fragment echo after use)", () => {
  it("drops the fragment tail repeated right after the use, preserving the final expect", () => {
    const p = plan([
      { id: "a1", type: "use", use: "login" },
      { id: "a2", type: "fill", target: { selector: "#password", description: "password" } },
      { id: "a3", type: "click", target: { selector: "#login-button", description: "sign in" }, expect: { url: "**/inventory.html" } },
    ]);
    const result = dropFragmentEchoes(p, [LOGIN_FRAGMENT]);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toMatchObject({ id: "a1", type: "use", expect: { url: "**/inventory.html" } });
  });

  it("stops at the first action that does not duplicate the fragment (the rest of the plan stays intact)", () => {
    const p = plan([
      { id: "a1", type: "use", use: "login" },
      { id: "a2", type: "click", target: { selector: "#login-button", description: "echo" } },
      { id: "a3", type: "click", target: { selector: "#add-to-cart", description: "product" }, expect: { selector: ".cart-badge" } },
    ]);
    const result = dropFragmentEchoes(p, [LOGIN_FRAGMENT]);
    expect(result.actions.map((a) => a.target?.selector ?? a.use)).toEqual(["login", "#add-to-cart"]);
    expect(result.actions[1].id).toBe("a2");
  });

  it("a legitimate repetition far from the use is untouched; a plan without echoes comes back identical", () => {
    const p = plan([
      { id: "a1", type: "use", use: "login" },
      { id: "a2", type: "click", target: { selector: "#add-to-cart", description: "product" } },
      { id: "a3", type: "click", target: { selector: "#login-button", description: "again, legitimate" }, expect: { selector: "x" } },
    ]);
    expect(dropFragmentEchoes(p, [LOGIN_FRAGMENT]).actions).toHaveLength(3);
  });

  it("use of an unknown fragment is ignored (invalidation is up to expand)", () => {
    const p = plan([
      { id: "a1", type: "use", use: "inexistente" },
      { id: "a2", type: "click", target: { selector: "#login-button", description: "x" }, expect: { selector: "y" } },
    ]);
    expect(dropFragmentEchoes(p, [LOGIN_FRAGMENT]).actions).toHaveLength(2);
  });
});
