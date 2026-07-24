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
