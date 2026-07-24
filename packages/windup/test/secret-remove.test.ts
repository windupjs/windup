import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { registerCredentials, removeCredentials, loadCredentialsFile } from "../src/secrets.js";
import { createContext, setContext } from "../src/context.js";

describe("windup secret remove", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "windup-secret-"));
    setContext(createContext(root));
  });
  afterAll(() => setContext(createContext()));

  it("drops the account from the mapping, its values from .env.local, and leaves other vars intact", async () => {
    // an unrelated var must survive
    await writeFile(path.join(root, ".env.local"), "GOOGLE_GENERATIVE_AI_API_KEY=keep-me\n");
    registerCredentials("admin", { user: "a@x.com", password: "s3cr3t" });
    registerCredentials("qa", { user: "q@x.com", password: "qpass" });

    const removed = removeCredentials("admin");
    expect(removed).not.toBeNull();
    expect(removed!.envs.sort()).toEqual(["WINDUP_ADMIN_PASSWORD", "WINDUP_ADMIN_USER"]);

    // mapping: admin gone, qa kept
    const accounts = loadCredentialsFile(root);
    expect(accounts.admin).toBeUndefined();
    expect(accounts.qa).toBeDefined();

    // .env.local: admin values gone, qa + unrelated var kept
    const env = await readFile(path.join(root, ".env.local"), "utf8");
    expect(env).not.toContain("WINDUP_ADMIN_");
    expect(env).toContain("GOOGLE_GENERATIVE_AI_API_KEY=keep-me");
    expect(env).toContain("WINDUP_QA_PASSWORD=");

    // process.env cleared for the removed account
    expect(process.env.WINDUP_ADMIN_PASSWORD).toBeUndefined();
  });

  it("returns null for an unknown account", () => {
    expect(removeCredentials("ghost")).toBeNull();
  });
});
