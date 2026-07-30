import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

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

/**
 * ACCOUNT PROFILES (`windup claude login --profile <name>`).
 *
 * The claude CLI's login is GLOBAL: the token lives in one config dir (default
 * `~/.claude`), so every project plans on whichever account signed in last —
 * a problem when you hold a personal plan plus one per client. The CLI reads
 * `CLAUDE_CONFIG_DIR`, and each dir keeps an INDEPENDENT session, so a profile
 * is just "a config dir per account" plus a per-project binding (`.envrc`).
 * Windup only orchestrates that; the auth itself stays in Anthropic's CLI.
 */

/** Filename-safe profile slug — non-alphanumerics collapse to `-`, so a name can never traverse paths. */
export function profileSlug(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/** Config dir for a profile: `~/.claude-<slug>` (the default `~/.claude` stays the unnamed profile). */
export function profileConfigDir(name: string, home: string = homedir()): string {
  const slug = profileSlug(name);
  if (!slug) throw new Error(`invalid profile name "${name}" — use letters/digits (e.g. --profile acme)`);
  return path.join(home, `.claude-${slug}`);
}

export type EnvrcOutcome = "created" | "appended" | "already" | "conflict" | "replaced";
export interface EnvrcResult {
  outcome: EnvrcOutcome;
  file: string;
  /** On "conflict"/"replaced": the CLAUDE_CONFIG_DIR line that was already there, pointing elsewhere. */
  existing?: string;
}

/**
 * Binds a project directory to a profile by exporting CLAUDE_CONFIG_DIR in its
 * `.envrc` (direnv). NEVER clobbers by accident: it appends when the file exists
 * without the var, and reports a `conflict` (changing nothing) when the var is
 * already there pointing elsewhere. `replace` (the CLI's `--force`) rebinds that
 * line instead — an explicit "yes, switch this project's account".
 */
export function ensureEnvrc(cwd: string, configDir: string, opts: { replace?: boolean } = {}): EnvrcResult {
  const file = path.join(cwd, ".envrc");
  const line = `export CLAUDE_CONFIG_DIR="${configDir}"`;
  if (!existsSync(file)) {
    writeFileSync(file, `${line}\n`, { mode: 0o644 });
    return { outcome: "created", file };
  }
  const current = readFileSync(file, "utf8");
  const existing = current.split("\n").find((l) => /^\s*export\s+CLAUDE_CONFIG_DIR=/.test(l))?.trim();
  if (existing) {
    // Same target (quoted or not) = nothing to do; a different one needs --force.
    const points = existing.replace(/^\s*export\s+CLAUDE_CONFIG_DIR=/, "").replace(/^["']|["']$/g, "").trim();
    if (points === configDir) return { outcome: "already", file };
    if (!opts.replace) return { outcome: "conflict", file, existing };
    // Rebind in place: only that line changes, every other export is preserved.
    const rebound = current.split("\n").map((l) => (/^\s*export\s+CLAUDE_CONFIG_DIR=/.test(l) ? line : l)).join("\n");
    writeFileSync(file, rebound);
    return { outcome: "replaced", file, existing };
  }
  appendFileSync(file, `${current.endsWith("\n") || current === "" ? "" : "\n"}${line}\n`);
  return { outcome: "appended", file };
}

/** Named profiles that exist on this machine (`~/.claude-<slug>` dirs). */
export function listProfiles(home: string = homedir()): string[] {
  try {
    return readdirSync(home)
      .filter((f) => f.startsWith(".claude-"))
      .map((f) => f.slice(".claude-".length))
      .filter(Boolean)
      .sort();
  } catch {
    return [];
  }
}
