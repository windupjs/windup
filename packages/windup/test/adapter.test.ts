/**
 * P5: cenários windup como testes nativos do vitest — este arquivo É o
 * critério: o report do runner lista cada cenário como um teste.
 * Filtrado ao login (cacheado → replay ~1s, zero LLM).
 */
import { windupSuite } from "../src/adapters/vitest.js";

await windupSuite({ filter: (id) => id === "saucedemo-login", name: "windup e2e" });
