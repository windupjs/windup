import { describe, expect, it } from "vitest";
import { classifyConsoleError, matchesIgnore } from "../src/diagnostics.js";

describe("classifyConsoleError — resource 4xx vs JS/CSP", () => {
  it("classifies a Chromium resource load failure as 'resource'", () => {
    expect(classifyConsoleError("Failed to load resource: the server responded with a status of 404 ()")).toBe("resource");
    expect(classifyConsoleError("Failed to load resource: net::ERR_NAME_NOT_RESOLVED")).toBe("resource");
  });
  it("classifies uncaught exceptions, console.error and CSP violations as 'js'", () => {
    expect(classifyConsoleError("Uncaught TypeError: x is not a function")).toBe("js");
    expect(classifyConsoleError("Refused to load the stylesheet 'https://fonts.googleapis.com/…' because it violates the following Content Security Policy directive")).toBe("js");
    expect(classifyConsoleError("some app console.error text")).toBe("js");
  });
});

describe("matchesIgnore — message OR url", () => {
  const ignore = ["gravatar.com", "analytics"];
  it("matches against the originating URL even when the message is the generic resource string", () => {
    // The real bug: the console text has no URL, so message-only matching never silenced it.
    expect(matchesIgnore(ignore, "Failed to load resource: the server responded with a status of 404 ()", "https://www.gravatar.com/avatar/abc?d=404")).toBe(true);
  });
  it("matches against the message too", () => {
    expect(matchesIgnore(ignore, "analytics beacon blocked", undefined)).toBe(true);
  });
  it("does not match unrelated errors", () => {
    expect(matchesIgnore(ignore, "Uncaught TypeError", "https://app.test/main.js")).toBe(false);
  });
  it("treats an undefined url safely", () => {
    expect(matchesIgnore(ignore, "Uncaught TypeError", undefined)).toBe(false);
  });
  it("empty ignore list matches nothing", () => {
    expect(matchesIgnore([], "anything", "https://gravatar.com")).toBe(false);
  });
});
