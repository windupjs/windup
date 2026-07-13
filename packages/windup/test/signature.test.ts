import { describe, expect, it } from "vitest";
import { computeSignature, type RawElement } from "../src/signature.js";

const loginPage: RawElement[] = [
  { tag: "input", id: "user-name", name: "user-name", dataTest: "username", type: "text" },
  { tag: "input", id: "password", name: "password", dataTest: "password", type: "password" },
  { tag: "input", id: "login-button", name: "login-button", dataTest: "login-button", type: "submit" },
];

describe("computeSignature (E1)", () => {
  it("same page → same sig", () => {
    expect(computeSignature(loginPage)).toBe(computeSignature([...loginPage]));
  });

  it("is insensitive to element order", () => {
    expect(computeSignature(loginPage)).toBe(computeSignature([...loginPage].reverse()));
  });

  it("is insensitive to repeated elements (N identical cards)", () => {
    expect(computeSignature(loginPage)).toBe(computeSignature([...loginPage, loginPage[0]]));
  });

  it("is case-insensitive", () => {
    const upper = loginPage.map((e) => ({ ...e, id: e.id?.toUpperCase() }));
    expect(computeSignature(loginPage)).toBe(computeSignature(upper));
  });

  it("an extra element → different sig", () => {
    const altered = [...loginPage, { tag: "button", id: "novo-botao" }];
    expect(computeSignature(loginPage)).not.toBe(computeSignature(altered));
  });

  it("changed id → different sig", () => {
    const altered = loginPage.map((e) => (e.id === "login-button" ? { ...e, id: "login-button-v2" } : e));
    expect(computeSignature(loginPage)).not.toBe(computeSignature(altered));
  });

  it("sig:<16 hex> format", () => {
    expect(computeSignature(loginPage)).toMatch(/^sig:[0-9a-f]{16}$/);
  });

  it("an empty page has a stable sig", () => {
    expect(computeSignature([])).toBe(computeSignature([]));
  });
});
