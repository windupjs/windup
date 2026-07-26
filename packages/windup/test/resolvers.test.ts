import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { extractValue, runResolver } from "../src/resolvers.js";
import { createContext, setContext } from "../src/context.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "windup-resolve-"));
  setContext(createContext(root));
});
afterAll(() => setContext(createContext()));

describe("extractValue", () => {
  it("regex returns capture group 1 (or the whole match)", () => {
    expect(extractValue("your code is 481902 — expires soon", { regex: "code is (\\d{6})" })).toBe("481902");
    expect(extractValue("abc-123", { regex: "\\d+" })).toBe("123");
    expect(extractValue("nope", { regex: "\\d{6}" })).toBe(""); // no match = "not yet"
  });
  it("json walks a dot-path", () => {
    expect(extractValue(JSON.stringify({ data: { otp: "990011" } }), { json: "data.otp" })).toBe("990011");
    expect(extractValue("{}", { json: "data.otp" })).toBe("");
    expect(extractValue("not json", { json: "x" })).toBe("");
  });
  it("no extract → trimmed raw", () => {
    expect(extractValue("  778899\n")).toBe("778899");
  });
});

describe("runResolver (cmd source + poll)", () => {
  it("runs a shell command and extracts the value", async () => {
    const v = await runResolver("otp", { source: { kind: "cmd", command: "echo 'code: 246810'" }, extract: { regex: "code: (\\d+)" } });
    expect(v).toBe("246810");
  });

  it("times out with a clear error when the value never appears", async () => {
    await expect(
      runResolver("otp", { source: { kind: "cmd", command: "echo ''" }, extract: { regex: "(\\d{6})" }, poll: { timeout_ms: 300, interval_ms: 50 } }),
    ).rejects.toThrow(/did not produce a value within 300ms/);
  });
});
