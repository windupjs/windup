import { describe, expect, it } from "vitest";
import { checkClaudeReadiness, isReady, readinessLine, type CommandResult, type Runner } from "../src/claude-cli.js";

/** A runner that replies per command from a scripted map (key: "cmd arg0 arg1..."). */
function scriptedRunner(replies: Record<string, Partial<CommandResult>>): Runner {
  return async (cmd, args) => {
    const key = [cmd, ...args].join(" ");
    const reply = replies[key];
    if (!reply) throw new Error(`unscripted command: ${key}`);
    return { stdout: "", stderr: "", code: 0, ...reply };
  };
}

const VERSION = "claude --version";
const STATUS = "claude auth status --json";

describe("checkClaudeReadiness", () => {
  it("CLI not on PATH (ENOENT on --version) → installed: false", async () => {
    const r = await checkClaudeReadiness(scriptedRunner({ [VERSION]: { code: null, errorCode: "ENOENT" } }));
    expect(r).toEqual({ installed: false, version: null, auth: null });
  });

  it("installed + logged in → parses email, plan and method from --json", async () => {
    const r = await checkClaudeReadiness(
      scriptedRunner({
        [VERSION]: { stdout: "2.1.204 (Claude Code)\n" },
        [STATUS]: { stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "qa@acme.dev", subscriptionType: "max" }) },
      }),
    );
    expect(r.installed).toBe(true);
    expect(r.version).toBe("2.1.204");
    expect(r.auth).toEqual({ loggedIn: true, authMethod: "claude.ai", email: "qa@acme.dev", subscriptionType: "max" });
    expect(isReady(r)).toBe(true);
  });

  it("installed but logged out → installed: true, loggedIn: false, not ready", async () => {
    const r = await checkClaudeReadiness(
      scriptedRunner({ [VERSION]: { stdout: "2.1.204 (Claude Code)" }, [STATUS]: { stdout: JSON.stringify({ loggedIn: false }) } }),
    );
    expect(r.installed).toBe(true);
    expect(r.auth?.loggedIn).toBe(false);
    expect(isReady(r)).toBe(false);
  });

  it("unparseable status (older CLI shape) → treated as not logged in, not ready", async () => {
    const r = await checkClaudeReadiness(
      scriptedRunner({ [VERSION]: { stdout: "1.0.0" }, [STATUS]: { stdout: "You are not logged in.\n", code: 1 } }),
    );
    expect(r.installed).toBe(true);
    expect(r.auth).toEqual({ loggedIn: false });
    expect(isReady(r)).toBe(false);
  });

  it("--version fails but the binary exists → still probes auth (version null, not a false 'uninstalled')", async () => {
    const r = await checkClaudeReadiness(
      scriptedRunner({ [VERSION]: { code: 1, stderr: "boom" }, [STATUS]: { stdout: JSON.stringify({ loggedIn: true, email: "x@y.z" }) } }),
    );
    expect(r.installed).toBe(true);
    expect(r.version).toBeNull();
    expect(r.auth?.loggedIn).toBe(true);
  });
});

describe("readinessLine", () => {
  it("not installed → points at `windup claude login`", () => {
    expect(readinessLine({ installed: false, version: null, auth: null })).toMatch(/not installed.*windup claude login/);
  });

  it("installed, logged out → shows version and points at login", () => {
    expect(readinessLine({ installed: true, version: "2.1.204", auth: { loggedIn: false } })).toMatch(/installed \(v2\.1\.204\), not logged in.*windup claude login/);
  });

  it("ready → shows account and plan", () => {
    const line = readinessLine({ installed: true, version: "2.1.204", auth: { loggedIn: true, email: "qa@acme.dev", subscriptionType: "max" } });
    expect(line).toMatch(/ready — qa@acme\.dev \(max plan\)/);
  });

  it("ready without a subscriptionType → falls back to auth method", () => {
    const line = readinessLine({ installed: true, version: "2.1.204", auth: { loggedIn: true, email: "qa@acme.dev", authMethod: "console" } });
    expect(line).toMatch(/ready — qa@acme\.dev \(console\)/);
  });
});
