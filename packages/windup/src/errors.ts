/**
 * User-facing error: its message is already actionable, so the CLI prints it
 * plainly without the "re-run with WINDUP_DEBUG=1" stack-trace hint. Use this
 * for expected failure modes (missing scenario, missing config, bad flag) —
 * NOT for bugs, which should surface their stack under WINDUP_DEBUG.
 */
export class WindupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WindupError";
  }
}
