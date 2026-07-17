import { spawn } from "node:child_process";

/**
 * Ergonomics for the `claude` CLI that `--llm claude-code` drives (SPEC §3,
 * llm.ts). The provider needs two things in place: the CLI installed and logged
 * into the developer's Claude plan. This module detects that state and guides
 * the fix — `windup claude status` / `windup claude login` — so onboarding is a
 * command, not a doc to follow.
 *
 * The heavy lifting stays in Anthropic's own CLI (`claude auth login/status`):
 * we only orchestrate it. The OAuth flow is a browser sign-in on the user's
 * account — we launch it, the human authorizes. `claude auth status --json`
 * gives a clean, local, machine-readable readiness probe (no quota spent).
 */

export const CLAUDE_PKG = "@anthropic-ai/claude-code";
export const INSTALL_CMD = `npm i -g ${CLAUDE_PKG}`;

export interface ClaudeAuth {
  loggedIn: boolean;
  /** "claude.ai" (subscription) | "console" (API billing) | … */
  authMethod?: string;
  email?: string;
  /** "max" | "pro" | … (subscription plans). */
  subscriptionType?: string;
}

export interface ClaudeReadiness {
  installed: boolean;
  version: string | null;
  /** null when the CLI is absent or its status could not be read. */
  auth: ClaudeAuth | null;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number | null;
  /** Set when the process could not be spawned at all (e.g. "ENOENT" = not on PATH). */
  errorCode?: string;
}

/** Runs a command capturing output; never rejects (spawn failures come back as errorCode). Injectable for tests. */
export type Runner = (cmd: string, args: string[]) => Promise<CommandResult>;

export const defaultRunner: Runner = (cmd, args) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err: NodeJS.ErrnoException) => resolve({ stdout, stderr, code: null, errorCode: err.code }));
    child.on("close", (code) => resolve({ stdout, stderr, code }));
  });

/** Runs a command with inherited stdio (the user sees/drives it) — for the interactive login and install. */
export function runInteractive(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

/** Probes whether the `claude` CLI is installed and logged in. Local + instant; safe to call from `windup status`. */
export async function checkClaudeReadiness(run: Runner = defaultRunner): Promise<ClaudeReadiness> {
  const ver = await run("claude", ["--version"]);
  if (ver.errorCode === "ENOENT") return { installed: false, version: null, auth: null };
  // "2.1.204 (Claude Code)" → "2.1.204"
  const version = ver.code === 0 ? ver.stdout.trim().split(/\s+/)[0] || null : null;

  const status = await run("claude", ["auth", "status", "--json"]);
  if (status.errorCode === "ENOENT") return { installed: false, version, auth: null };
  let auth: ClaudeAuth | null;
  try {
    const j = JSON.parse(status.stdout) as Record<string, unknown>;
    auth = {
      loggedIn: j.loggedIn === true,
      authMethod: typeof j.authMethod === "string" ? j.authMethod : undefined,
      email: typeof j.email === "string" ? j.email : undefined,
      subscriptionType: typeof j.subscriptionType === "string" ? j.subscriptionType : undefined,
    };
  } catch {
    // Unparseable (older CLI / logged-out shape): installed, but not usable yet.
    auth = { loggedIn: false };
  }
  return { installed: true, version, auth };
}

/** true only when a plan can actually be generated (CLI present and logged in). */
export function isReady(r: ClaudeReadiness): boolean {
  return r.installed && r.auth?.loggedIn === true;
}

/** One-line human summary for `windup claude status` and `windup status`. */
export function readinessLine(r: ClaudeReadiness): string {
  if (!r.installed) return `claude CLI: not installed — run \`windup claude login\` (installs it, then signs you in)`;
  if (!r.auth?.loggedIn) return `claude CLI: installed${r.version ? ` (v${r.version})` : ""}, not logged in — run \`windup claude login\``;
  const plan = r.auth.subscriptionType ? `${r.auth.subscriptionType} plan` : r.auth.authMethod ?? "logged in";
  return `claude CLI: ready — ${r.auth.email ?? "logged in"} (${plan})`;
}
