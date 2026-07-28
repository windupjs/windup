import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runInit } from "../src/init.js";

describe("windup init — versionable plan cache by default (#14)", () => {
  it("writes an internal .windup/.gitignore that ignores only the ephemeral/sensitive dirs", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "windup-init-"));
    await runInit(cwd);
    const gi = await readFile(path.join(cwd, ".windup", ".gitignore"), "utf8");
    // state (auth cookies), runs (ledger), reports are ignored…
    expect(gi).toMatch(/^state\/$/m);
    expect(gi).toMatch(/^runs\/$/m);
    expect(gi).toMatch(/^reports\/$/m);
    // …but the plan cache and site map are NOT ignored (they're the committed artifact) — no ignore LINE for them.
    expect(gi).not.toMatch(/^cache\/?$/m);
    expect(gi).not.toMatch(/^map\/?$/m);
  });

  it("does NOT add a blanket .windup/ to the root .gitignore (that would hide the cache)", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "windup-init-"));
    await writeFile(path.join(cwd, ".gitignore"), "node_modules\n");
    await runInit(cwd);
    const root = await readFile(path.join(cwd, ".gitignore"), "utf8");
    expect(root).not.toMatch(/^\.windup\/?$/m);
  });
});
