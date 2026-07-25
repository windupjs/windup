import { exec } from "node:child_process";
import { promisify } from "node:util";
import { getContext } from "./context.js";
import { progress } from "./progress.js";

const pexec = promisify(exec);

/**
 * Per-scenario setup / teardown hooks (SPEC: idempotency).
 *
 * A replay re-runs the SAME cached plan with the SAME values, which is perfect
 * for idempotent flows (edit-to-a-fixed-value, toggle-and-check) but breaks a
 * pure CREATE whose resource has a non-reusable unique key: the first run
 * creates it, every replay violates the constraint. `setup`/`teardown` run
 * shell commands OUTSIDE the cached plan (so they run on every replay) — use
 * them for DB cleanup (hard-delete what the test created), fixtures, or an
 * HTTP reset. They are the user's own trusted commands (like a test's
 * beforeEach/afterEach), run in the project root with the process env.
 */
export type HookCommands = string | string[] | undefined;

export interface HookResult {
  ok: boolean;
  error?: string;
}

export async function runHooks(kind: "setup" | "teardown", commands: HookCommands, scenarioId: string): Promise<HookResult> {
  if (!commands) return { ok: true };
  const list = (Array.isArray(commands) ? commands : [commands]).map((c) => c.trim()).filter(Boolean);
  const cwd = getContext().paths.root;
  for (const cmd of list) {
    progress(scenarioId, `${kind}: ${cmd}`);
    try {
      await pexec(cmd, { cwd, timeout: 120_000, env: process.env, windowsHide: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `${kind} command failed — ${cmd}\n${message.split("\n").slice(0, 6).join("\n")}` };
    }
  }
  return { ok: true };
}
