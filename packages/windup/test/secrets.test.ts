import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { deriveAccountName, envName, registerCredentials } from "../src/secrets.js";
import { createContext, setContext } from "../src/context.js";

describe("windup secret (credentials without committed secrets)", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "windup-secrets-"));
    setContext(createContext(root));
  });
  afterAll(() => setContext(createContext()));

  it("derives account and ENV names", () => {
    expect(deriveAccountName("kallef@orbitaldev.com.br")).toBe("kallef");
    expect(deriveAccountName(undefined)).toBe("default");
    expect(envName("qa-admin", "password")).toBe("WINDUP_QA_ADMIN_PASSWORD");
  });

  it("registers: values in .env.local (idempotent update), mapping without values, gitignore guaranteed", async () => {
    registerCredentials("admin", { user: "a@b.com", password: "s3gr3d0" });
    registerCredentials("admin", { password: "novo" }); // updates the same key

    const env = await readFile(path.join(root, ".env.local"), "utf8");
    expect(env).toContain("WINDUP_ADMIN_USER=a@b.com");
    expect(env).toContain("WINDUP_ADMIN_PASSWORD=novo");
    expect(env.match(/WINDUP_ADMIN_PASSWORD=/g)).toHaveLength(1);
    expect(process.env.WINDUP_ADMIN_PASSWORD).toBe("novo");

    const mapping = JSON.parse(await readFile(path.join(root, "windup.credentials.json"), "utf8"));
    expect(mapping.accounts.admin).toEqual({ user: "ENV:WINDUP_ADMIN_USER", password: "ENV:WINDUP_ADMIN_PASSWORD" });
    expect(JSON.stringify(mapping)).not.toContain("s3gr3d0");
    expect(await readFile(path.join(root, ".gitignore"), "utf8")).toContain(".env.local");
  });

  it("createContext merges windup.credentials.json into the manifest (explicit config wins)", async () => {
    await writeFile(
      path.join(root, "windup.credentials.json"),
      JSON.stringify({ accounts: { qa: { user: "ENV:WINDUP_QA_USER" } } }),
    );
    const ctx = createContext(root);
    expect(ctx.config.context?.credentials?.qa).toEqual({ user: "ENV:WINDUP_QA_USER" });
  });
});
