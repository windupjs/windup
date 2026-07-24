/**
 * Verbose progress for `run --verbose` (env WINDUP_VERBOSE=1).
 *
 * Planning with a slow provider (e.g. --llm claude-code) can take minutes with
 * no output — the run looks frozen. Verbose mode emits milestones to stderr as
 * planning and execution advance, each line prefixed with the scenario id and
 * the elapsed time since that scenario started, so slow providers show a
 * heartbeat instead of silence. Off by default; never affects results.
 */

const startedAt = new Map<string, number>();

export function verboseEnabled(): boolean {
  return process.env.WINDUP_VERBOSE === "1";
}

/** (Re)start the elapsed clock for a scenario — called when its run begins. */
export function progressStart(scenarioId: string): void {
  if (verboseEnabled()) startedAt.set(scenarioId, Date.now());
}

/** Emit one milestone line for a scenario (no-op unless verbose). */
export function progress(scenarioId: string, message: string): void {
  if (!verboseEnabled()) return;
  const start = startedAt.get(scenarioId);
  if (start === undefined) {
    startedAt.set(scenarioId, Date.now());
  }
  const elapsed = ((Date.now() - (start ?? Date.now())) / 1000).toFixed(1);
  process.stderr.write(`  ${scenarioId}  ${message}  (+${elapsed}s)\n`);
}
