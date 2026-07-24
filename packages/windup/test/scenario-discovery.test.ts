import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { discoverScenarioIds, loadScenario } from "../src/scenario.js";
import { createContext, setContext } from "../src/context.js";

describe("recursive scenario discovery (organize by folder)", () => {
  let root: string, dir: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "windup-disc-"));
    setContext(createContext(root, { scenariosDir: "e2e/scenarios" }));
    dir = path.join(root, "e2e/scenarios");
    await mkdir(path.join(dir, "contacts"), { recursive: true });
    await mkdir(path.join(dir, "auth"), { recursive: true });
    await writeFile(path.join(dir, "auth", "login.json"), JSON.stringify({ scenario_id: "login", start_url: "https://x.test", task: "log in and verify the dashboard" }));
    // file name differs from scenario_id — identity comes from the field
    await writeFile(path.join(dir, "contacts", "list.json"), JSON.stringify({ scenario_id: "contacts-list", depends_on: ["login"], task: "open contacts and verify the list appears" }));
    await writeFile(path.join(dir, "top-level.json"), JSON.stringify({ scenario_id: "top-level", start_url: "https://x.test", task: "a top-level scenario with a final verification" }));
  });
  afterAll(() => setContext(createContext()));

  it("discovers scenarios in subfolders by scenario_id", async () => {
    const ids = await discoverScenarioIds();
    expect(ids).toEqual(["contacts-list", "login", "top-level"]);
  });

  it("loadScenario resolves a subfolder scenario by its scenario_id (not path)", async () => {
    process.env.WINDUP_BASE_URL = "https://x.test";
    try {
      const s = await loadScenario("contacts-list"); // file is contacts/list.json
      expect(s.scenario_id).toBe("contacts-list");
      expect(s.depends_on).toEqual(["login"]); // depends_on resolves by id across folders
      const dep = await loadScenario("login"); // file is auth/login.json
      expect(dep.scenario_id).toBe("login");
    } finally {
      delete process.env.WINDUP_BASE_URL;
    }
  });

  it("still resolves a top-level scenario by the fast path", async () => {
    process.env.WINDUP_BASE_URL = "https://x.test";
    try {
      expect((await loadScenario("top-level")).scenario_id).toBe("top-level");
    } finally {
      delete process.env.WINDUP_BASE_URL;
    }
  });
});
