import { describe, expect, it } from "vitest";
import { resolveBrowserName } from "../src/browser.js";
import { WindupError } from "../src/errors.js";

describe("browser selection (cross-browser)", () => {
  it("defaults to chromium", () => {
    expect(resolveBrowserName(undefined, undefined)).toBe("chromium");
  });
  it("env (--browser / WINDUP_BROWSER) wins over config", () => {
    expect(resolveBrowserName("firefox", "webkit")).toBe("firefox");
    expect(resolveBrowserName(undefined, "webkit")).toBe("webkit");
  });
  it("is case-insensitive", () => {
    expect(resolveBrowserName("FireFox", undefined)).toBe("firefox");
  });
  it("rejects an unknown browser with a WindupError", () => {
    expect(() => resolveBrowserName("safari", undefined)).toThrow(WindupError);
    expect(() => resolveBrowserName("safari", undefined)).toThrow(/chromium, firefox or webkit/);
  });
});
