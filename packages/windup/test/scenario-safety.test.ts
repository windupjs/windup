import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { assertSafeScenarioId, loadScenario } from "../src/scenario.js";
import { createContext, setContext } from "../src/context.js";

let root: string, dir: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "windup-safety-"));
  dir = path.join(root, "e2e");
  setContext(createContext(root, { scenariosDir: "e2e" }));
  await mkdir(dir, { recursive: true });
  process.env.WINDUP_BASE_URL = "http://x.test";
});
afterAll(() => { setContext(createContext()); delete process.env.WINDUP_BASE_URL; });

describe("scenario id path-traversal guard", () => {
  it("accepts a normal id and a subfolder id", () => {
    expect(() => assertSafeScenarioId("checkout")).not.toThrow();
    expect(() => assertSafeScenarioId("auth/login")).not.toThrow();
  });

  it("rejects `..` segments and absolute paths", () => {
    for (const bad of ["../etc/passwd", "a/../../b", "..", "/etc/hosts", "auth/../../x"]) {
      expect(() => assertSafeScenarioId(bad), bad).toThrow(/invalid scenario id/);
    }
  });

  it("loadScenario refuses a traversing lookup id", async () => {
    await expect(loadScenario("../../evil")).rejects.toThrow(/invalid scenario id/);
  });

  it("loadScenario refuses a file whose scenario_id field traverses (untrusted project)", async () => {
    // a committed scenario whose id would write a cache entry outside .windup
    await writeFile(path.join(dir, "evil.json"), JSON.stringify({ scenario_id: "../../../../tmp/pwned", task: "x".repeat(20), start_url: "/" }));
    await expect(loadScenario("evil")).rejects.toThrow(/invalid scenario id/);
  });
});
