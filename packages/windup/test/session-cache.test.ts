import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { dropSnapshot, getSnapshot, saveSnapshot } from "../src/session-cache.js";
import { createContext, setContext } from "../src/context.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "windup-session-"));
  setContext(createContext(root, { scenariosDir: "e2e" }));
});
afterAll(() => setContext(createContext()));

describe("session snapshot cache (feedback #4)", () => {
  const storage = { cookies: [{ name: "sid", value: "abc" }], origins: [] };

  it("save → get round-trips the storageState + url", async () => {
    await saveSnapshot("login", storage, "http://x/dashboard");
    const s = await getSnapshot("login");
    expect(s).not.toBeNull();
    expect(s!.scenario_id).toBe("login");
    expect(s!.url).toBe("http://x/dashboard");
    expect(s!.storage_state).toEqual(storage);
    expect(typeof s!.saved_at).toBe("string");
  });

  it("get returns null when there is no snapshot", async () => {
    expect(await getSnapshot("never-saved")).toBeNull();
  });

  it("drop removes the snapshot (fast path falls back to the chain)", async () => {
    await saveSnapshot("login", storage, "http://x/dashboard");
    await dropSnapshot("login");
    expect(await getSnapshot("login")).toBeNull();
  });

  it("path-style scenario ids are flattened to a single file", async () => {
    await saveSnapshot("auth/login", storage, "http://x/");
    expect((await getSnapshot("auth/login"))?.scenario_id).toBe("auth/login");
    await dropSnapshot("auth/login");
    expect(await getSnapshot("auth/login")).toBeNull();
  });
});
