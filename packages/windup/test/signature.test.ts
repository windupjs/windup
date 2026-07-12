import { describe, expect, it } from "vitest";
import { computeSignature, type RawElement } from "../src/signature.js";

const loginPage: RawElement[] = [
  { tag: "input", id: "user-name", name: "user-name", dataTest: "username", type: "text" },
  { tag: "input", id: "password", name: "password", dataTest: "password", type: "password" },
  { tag: "input", id: "login-button", name: "login-button", dataTest: "login-button", type: "submit" },
];

describe("computeSignature (E1)", () => {
  it("mesma página → mesma sig", () => {
    expect(computeSignature(loginPage)).toBe(computeSignature([...loginPage]));
  });

  it("é insensível à ordem dos elementos", () => {
    expect(computeSignature(loginPage)).toBe(computeSignature([...loginPage].reverse()));
  });

  it("é insensível a elementos repetidos (N cards iguais)", () => {
    expect(computeSignature(loginPage)).toBe(computeSignature([...loginPage, loginPage[0]]));
  });

  it("é insensível a caixa (case)", () => {
    const upper = loginPage.map((e) => ({ ...e, id: e.id?.toUpperCase() }));
    expect(computeSignature(loginPage)).toBe(computeSignature(upper));
  });

  it("elemento a mais → sig diferente", () => {
    const altered = [...loginPage, { tag: "button", id: "novo-botao" }];
    expect(computeSignature(loginPage)).not.toBe(computeSignature(altered));
  });

  it("id trocado → sig diferente", () => {
    const altered = loginPage.map((e) => (e.id === "login-button" ? { ...e, id: "login-button-v2" } : e));
    expect(computeSignature(loginPage)).not.toBe(computeSignature(altered));
  });

  it("formato sig:<16 hex>", () => {
    expect(computeSignature(loginPage)).toMatch(/^sig:[0-9a-f]{16}$/);
  });

  it("página vazia tem sig estável", () => {
    expect(computeSignature([])).toBe(computeSignature([]));
  });
});
