import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { WindupError } from "../src/errors.js";
import { loadScenario } from "../src/scenario.js";
import { createContext, setContext } from "../src/context.js";

describe("user-facing errors (graceful failure)", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "windup-errors-"));
    setContext(createContext(root));
  });
  afterAll(() => setContext(createContext()));

  it("WindupError carries a clean name for the CLI to print without a stack hint", () => {
    const e = new WindupError("something actionable");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("WindupError");
    expect(e.message).toBe("something actionable");
  });

  it("a missing scenario throws a WindupError with an actionable message (not a raw error)", async () => {
    await expect(loadScenario("does-not-exist")).rejects.toBeInstanceOf(WindupError);
    await expect(loadScenario("does-not-exist")).rejects.toThrow(/not found.*windup new/s);
  });
});
