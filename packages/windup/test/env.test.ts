import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/env.js";

describe("env loading (.env.local > .env)", () => {
  it(".env.local takes precedence over .env; both load", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "windup-env-"));
    await writeFile(path.join(dir, ".env"), "WINDUP_T_A=from-env\nWINDUP_T_B=only-in-env\n");
    await writeFile(path.join(dir, ".env.local"), "WINDUP_T_A=from-local\nWINDUP_T_C=only-in-local\n");
    loadEnv(dir);
    expect(process.env.WINDUP_T_A).toBe("from-local");
    expect(process.env.WINDUP_T_B).toBe("only-in-env");
    expect(process.env.WINDUP_T_C).toBe("only-in-local");
  });

  it("a variable already present in the process is never overwritten", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "windup-env-"));
    process.env.WINDUP_T_D = "from-process";
    await writeFile(path.join(dir, ".env.local"), "WINDUP_T_D=from-file\n");
    loadEnv(dir);
    expect(process.env.WINDUP_T_D).toBe("from-process");
  });

  it("a directory without env files does not blow up", () => {
    expect(() => loadEnv("/path/that/does/not/exist")).not.toThrow();
  });
});
