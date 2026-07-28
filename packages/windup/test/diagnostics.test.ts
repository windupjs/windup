import { describe, expect, it } from "vitest";
import { classifyConsoleError, matchesIgnore, effectiveFailOn, resourceStatus } from "../src/diagnostics.js";
import { stubMatchesUrl } from "../src/network.js";

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

describe("stubMatchesUrl — exclude a stubbed endpoint's console error (method-agnostic)", () => {
  const rules = [{ url: "v1/passports", method: "GET", status: 500 }];
  it("matches by URL regardless of method (a console error carries no method)", () => {
    expect(stubMatchesUrl(rules, "https://api.test/rest/v1/passports?select=*")).toBe(true);
  });
  it("does not match an unrelated URL", () => {
    expect(stubMatchesUrl(rules, "https://api.test/rest/v1/orders")).toBe(false);
  });
});

describe("resourceStatus — HTTP status from the Chromium message", () => {
  it("extracts the status", () => {
    expect(resourceStatus("Failed to load resource: the server responded with a status of 404 ()")).toBe(404);
    expect(resourceStatus("Failed to load resource: the server responded with a status of 500 ()")).toBe(500);
  });
  it("is undefined when there is no status (e.g. a JS error)", () => {
    expect(resourceStatus("Uncaught TypeError: x is not a function")).toBeUndefined();
  });
});

describe("effectiveFailOn — scenario merged over global", () => {
  const g = { consoleErrors: true, resourceErrors: true, http5xx: true, ignore: ["gravatar.com"] };
  it("scenario boolean wins, ignore lists concatenate", () => {
    expect(effectiveFailOn({ resourceErrors: false, ignore: ["passports?select="] }, g)).toEqual({
      consoleErrors: true, resourceErrors: false, http5xx: true, ignore: ["gravatar.com", "passports?select="],
    });
  });
  it("returns the global unchanged when the scenario has no failOn", () => {
    expect(effectiveFailOn(undefined, g)).toBe(g);
  });
  it("global ignore is preserved even when the scenario omits ignore", () => {
    expect(effectiveFailOn({ http5xx: false }, g)).toEqual({ consoleErrors: true, resourceErrors: true, http5xx: false, ignore: ["gravatar.com"] });
  });
});
