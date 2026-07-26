import { describe, expect, it } from "vitest";
import { matchRule, validateNetwork } from "../src/network.js";
import { frozenNowMs, validateClock } from "../src/clock.js";
import type { NetworkRule } from "../src/config.js";

describe("config.network — validateNetwork", () => {
  it("accepts well-formed rules", () => {
    expect(validateNetwork([{ url: "/api/orders", json: [] }, { url: "**/slow", status: 500 }, { url: "/x", abort: true }])).toEqual([]);
    expect(validateNetwork(undefined)).toEqual([]);
  });
  it("rejects malformed rules", () => {
    expect(validateNetwork({} as unknown)).toHaveLength(1); // not an array
    expect(validateNetwork([{ url: "" }])[0]).toMatch(/url must be a non-empty string/);
    expect(validateNetwork([{ url: "/x", status: 999 }])[0]).toMatch(/status must be an HTTP status/);
    expect(validateNetwork([{ url: "/x", abort: true, status: 500 }])[0]).toMatch(/abort.*cannot be combined/);
  });
});

describe("config.network — matchRule (first match wins, method + url)", () => {
  const rules: NetworkRule[] = [
    { url: "/api/orders", method: "POST", status: 201 },
    { url: "**/api/orders", json: [] },
    { url: "static-substring" },
  ];
  it("matches by substring and by glob", () => {
    expect(matchRule(rules, "https://app/api/orders", "GET")).toBe(rules[1]); // POST rule skipped, glob matches
    expect(matchRule(rules, "https://app/api/orders", "post")).toBe(rules[0]); // method case-insensitive, first wins
    expect(matchRule(rules, "https://app/x/static-substring/y", "GET")).toBe(rules[2]);
  });
  it("returns null when nothing matches", () => {
    expect(matchRule(rules, "https://app/other", "GET")).toBeNull();
  });
});

describe("config.clock — validateClock / frozenNowMs", () => {
  it("parses ISO and epoch-ms `now`", () => {
    expect(frozenNowMs({ now: "2026-01-01T00:00:00.000Z" })).toBe(Date.parse("2026-01-01T00:00:00.000Z"));
    expect(frozenNowMs({ now: 1735689600000 })).toBe(1735689600000);
    expect(frozenNowMs(undefined)).toBeNull();
    expect(frozenNowMs({})).toBeNull();
  });
  it("validates shape", () => {
    expect(validateClock({ now: "2026-01-01", timezone: "America/Sao_Paulo" })).toEqual([]);
    expect(validateClock(undefined)).toEqual([]);
    expect(validateClock("nope" as unknown)[0]).toMatch(/must be an object/);
    expect(validateClock({ now: "not-a-date" })[0]).toMatch(/ISO date string or epoch/);
    expect(validateClock({ timezone: 5 as unknown })[0]).toMatch(/timezone must be an IANA/);
  });
});
