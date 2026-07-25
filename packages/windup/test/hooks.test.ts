import { existsSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { runHooks } from "../src/hooks.js";
import { createContext, setContext } from "../src/context.js";

describe("setup/teardown hooks", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "windup-hooks-"));
    setContext(createContext(root));
  });
  afterAll(() => setContext(createContext()));

  it("undefined commands are a no-op", async () => {
    expect(await runHooks("setup", undefined, "s")).toEqual({ ok: true });
  });

  it("runs a command in the project root and reports success", async () => {
    const res = await runHooks("setup", "echo ready > marker.txt", "s");
    expect(res.ok).toBe(true);
    expect(existsSync(path.join(root, "marker.txt"))).toBe(true);
    expect(readFileSync(path.join(root, "marker.txt"), "utf8")).toContain("ready");
  });

  it("runs multiple commands in order", async () => {
    const res = await runHooks("teardown", ["echo a > a.txt", "echo b > b.txt"], "s");
    expect(res.ok).toBe(true);
    expect(existsSync(path.join(root, "a.txt"))).toBe(true);
    expect(existsSync(path.join(root, "b.txt"))).toBe(true);
  });

  it("a failing command returns ok:false with the command and its output", async () => {
    const res = await runHooks("teardown", "exit 3", "s");
    expect(res.ok).toBe(false);
    expect(res.error).toContain("teardown command failed");
    expect(res.error).toContain("exit 3");
  });
});
