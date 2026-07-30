import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ensureEnvrc, listProfiles, profileConfigDir, profileSlug } from "../src/claude-cli.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), "windup-profile-")); });

describe("profileSlug / profileConfigDir (account profiles)", () => {
  it("slugifies a name and never escapes the home dir", () => {
    expect(profileSlug("Acme Corp")).toBe("acme-corp");
    expect(profileSlug("Empresa Ação")).toBe("empresa-acao");
    // a traversal attempt collapses to a plain slug — the name becomes a dir name
    expect(profileSlug("../../etc/passwd")).toBe("etc-passwd");
    expect(profileConfigDir("Acme Corp", "/home/k")).toBe("/home/k/.claude-acme-corp");
    expect(profileConfigDir("../../etc", "/home/k")).toBe("/home/k/.claude-etc");
  });

  it("rejects a name with nothing usable in it", () => {
    expect(() => profileConfigDir("///", "/home/k")).toThrow(/invalid profile name/);
  });
});

describe("ensureEnvrc (binds a project to a profile, never clobbers)", () => {
  it("creates .envrc when absent", async () => {
    const r = ensureEnvrc(dir, "/home/k/.claude-acme");
    expect(r.outcome).toBe("created");
    expect(await readFile(r.file, "utf8")).toBe('export CLAUDE_CONFIG_DIR="/home/k/.claude-acme"\n');
  });

  it("appends to an existing .envrc, preserving its other exports", async () => {
    await writeFile(path.join(dir, ".envrc"), "export DATABASE_URL=postgres://x\n");
    const r = ensureEnvrc(dir, "/home/k/.claude-acme");
    expect(r.outcome).toBe("appended");
    const body = await readFile(r.file, "utf8");
    expect(body).toContain("export DATABASE_URL=postgres://x"); // untouched
    expect(body).toContain('export CLAUDE_CONFIG_DIR="/home/k/.claude-acme"');
  });

  it("is idempotent when already bound to the same profile", async () => {
    ensureEnvrc(dir, "/home/k/.claude-acme");
    const again = ensureEnvrc(dir, "/home/k/.claude-acme");
    expect(again.outcome).toBe("already");
    const body = await readFile(again.file, "utf8");
    expect(body.match(/CLAUDE_CONFIG_DIR/g)).toHaveLength(1); // not duplicated
  });

  it("reports a conflict (changing nothing) when another profile is already bound", async () => {
    ensureEnvrc(dir, "/home/k/.claude-acme");
    const before = await readFile(path.join(dir, ".envrc"), "utf8");
    const r = ensureEnvrc(dir, "/home/k/.claude-globex");
    expect(r.outcome).toBe("conflict");
    expect(r.existing).toContain(".claude-acme");
    expect(await readFile(r.file, "utf8")).toBe(before); // file untouched
  });

  it("handles an unquoted existing line pointing at the same dir", async () => {
    await writeFile(path.join(dir, ".envrc"), "export CLAUDE_CONFIG_DIR=/home/k/.claude-acme\n");
    expect(ensureEnvrc(dir, "/home/k/.claude-acme").outcome).toBe("already");
  });

  it("replace (--force) rebinds only that line, keeping every other export", async () => {
    await writeFile(path.join(dir, ".envrc"), 'export DATABASE_URL=postgres://x\nexport CLAUDE_CONFIG_DIR="/home/k/.claude-acme"\nexport OTHER=1\n');
    const r = ensureEnvrc(dir, "/home/k/.claude-globex", { replace: true });
    expect(r.outcome).toBe("replaced");
    expect(r.existing).toContain(".claude-acme"); // reports what it replaced
    const body = await readFile(r.file, "utf8");
    expect(body).toContain('export CLAUDE_CONFIG_DIR="/home/k/.claude-globex"');
    expect(body).not.toContain(".claude-acme");
    expect(body).toContain("export DATABASE_URL=postgres://x"); // untouched
    expect(body).toContain("export OTHER=1");
    expect(body.match(/CLAUDE_CONFIG_DIR/g)).toHaveLength(1); // rebound, not duplicated
  });

  it("replace on a fresh/absent binding behaves like create/append", async () => {
    expect(ensureEnvrc(dir, "/home/k/.claude-acme", { replace: true }).outcome).toBe("created");
    expect(ensureEnvrc(dir, "/home/k/.claude-acme", { replace: true }).outcome).toBe("already");
  });
});

describe("listProfiles", () => {
  it("lists ~/.claude-<slug> dirs as profile names, sorted", async () => {
    await mkdir(path.join(dir, ".claude-globex"), { recursive: true });
    await mkdir(path.join(dir, ".claude-acme"), { recursive: true });
    await mkdir(path.join(dir, ".claude"), { recursive: true });      // the default profile: not named
    await mkdir(path.join(dir, "unrelated"), { recursive: true });
    expect(listProfiles(dir)).toEqual(["acme", "globex"]);
  });

  it("returns [] when the home dir can't be read", () => {
    expect(listProfiles(path.join(dir, "does-not-exist"))).toEqual([]);
  });
});
