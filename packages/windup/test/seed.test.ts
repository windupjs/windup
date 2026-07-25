import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { loadScenario } from "../src/scenario.js";
import { createContext, setContext } from "../src/context.js";

let root: string, dir: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "windup-seed-"));
  setContext(createContext(root, { scenariosDir: "e2e" }));
  dir = path.join(root, "e2e");
  await mkdir(dir, { recursive: true });
  process.env.WINDUP_BASE_URL = "http://x.test";
});
afterAll(() => { setContext(createContext()); delete process.env.WINDUP_BASE_URL; });

const write = (id: string, seed: unknown) =>
  writeFile(path.join(dir, `${id}.json`), JSON.stringify({ scenario_id: id, start_url: "http://x.test/cart", task: "open the cart and verify", seed }));

describe("seed (client-side storage fixtures) validation", () => {
  it("accepts localStorage + sessionStorage string maps and an origin", async () => {
    await write("ok", { localStorage: { cart: "[]" }, sessionStorage: { device: "pos-1" }, origin: "http://x.test" });
    const s = await loadScenario("ok");
    expect(s.seed?.localStorage?.cart).toBe("[]");
    expect(s.seed?.sessionStorage?.device).toBe("pos-1");
  });

  it("rejects non-string values", async () => {
    await write("bad", { localStorage: { cart: 3 } });
    await expect(loadScenario("bad")).rejects.toThrow(/seed/);
  });

  it("rejects a non-object seed", async () => {
    await write("bad2", "cart=1");
    await expect(loadScenario("bad2")).rejects.toThrow(/seed/);
  });
});
