import { afterEach, describe, expect, it, vi } from "vitest";
import { progress, progressStart, verboseEnabled } from "../src/progress.js";

afterEach(() => { delete process.env.WINDUP_VERBOSE; vi.restoreAllMocks(); });

describe("verbose progress", () => {
  it("is a no-op unless WINDUP_VERBOSE=1", () => {
    const spy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(verboseEnabled()).toBe(false);
    progress("login", "planning…");
    expect(spy).not.toHaveBeenCalled();
  });

  it("emits a scenario-prefixed line with elapsed time when enabled", () => {
    process.env.WINDUP_VERBOSE = "1";
    const spy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    progressStart("login");
    progress("login", "planning… (llm: claude-code)");
    expect(spy).toHaveBeenCalledTimes(1);
    const line = spy.mock.calls[0][0] as string;
    expect(line).toContain("login");
    expect(line).toContain("planning… (llm: claude-code)");
    expect(line).toMatch(/\(\+\d+\.\d+s\)/);
  });
});

import { streamEnabled, streamEvent } from "../src/progress.js";

describe("NDJSON stream events (--stream)", () => {
  afterEach(() => { delete process.env.WINDUP_STREAM; });
  it("is a no-op unless WINDUP_STREAM=1", () => {
    const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    expect(streamEnabled()).toBe(false);
    streamEvent("login", "run:start");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
  it("emits one valid JSON line per event with scenario + event + data", () => {
    process.env.WINDUP_STREAM = "1";
    const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    streamEvent("login", "action", { id: "a1", status: "passed" });
    expect(spy).toHaveBeenCalledTimes(1);
    const line = spy.mock.calls[0][0] as string;
    expect(line.endsWith("\n")).toBe(true);
    const obj = JSON.parse(line);
    expect(obj).toMatchObject({ event: "action", scenario: "login", id: "a1", status: "passed" });
    spy.mockRestore();
  });
});
