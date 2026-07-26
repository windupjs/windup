import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { runDoctor } from "../src/doctor.js";
import { createContext, setContext } from "../src/context.js";

let root: string, dir: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "windup-doctor-"));
  dir = path.join(root, "e2e");
  setContext(createContext(root, { scenariosDir: "e2e" }));
  await mkdir(dir, { recursive: true });
  process.env.WINDUP_BASE_URL = "http://x.test";
});
afterAll(() => { setContext(createContext()); delete process.env.WINDUP_BASE_URL; });

const check = (checks: Awaited<ReturnType<typeof runDoctor>>, name: string) => checks.find((c) => c.name === name)!;

describe("windup doctor (preflight)", () => {
  it("reports valid scenarios as ok", async () => {
    await writeFile(path.join(dir, "a.json"), JSON.stringify({ scenario_id: "a", start_url: "http://x.test/", task: "open and verify" }));
    const checks = await runDoctor();
    expect(check(checks, "scenarios").status).toBe("ok");
    expect(check(checks, "scenarios").detail).toMatch(/1 valid/);
  });

  it("fails when a scenario is invalid", async () => {
    await writeFile(path.join(dir, "bad.json"), JSON.stringify({ scenario_id: "bad" })); // missing task
    const checks = await runDoctor();
    expect(check(checks, "scenarios").status).toBe("fail");
  });

  it("warns when the site map is empty (scan first)", async () => {
    await writeFile(path.join(dir, "a.json"), JSON.stringify({ scenario_id: "a", start_url: "http://x.test/", task: "open and verify" }));
    const checks = await runDoctor();
    expect(check(checks, "site map").status).toBe("warn");
  });
});
