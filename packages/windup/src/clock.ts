export interface ClockConfig {
  now?: string | number;
  timezone?: string;
}

/** Validates `config.clock` (returns human-readable errors, empty when ok). */
export function validateClock(clock: unknown): string[] {
  if (clock === undefined) return [];
  if (typeof clock !== "object" || clock === null) return ["config.clock must be an object { now?, timezone? }"];
  const c = clock as ClockConfig;
  const errors: string[] = [];
  if (c.now !== undefined && frozenNowMs(c) === null) {
    errors.push(`config.clock.now must be an ISO date string or epoch milliseconds (got ${JSON.stringify(c.now)})`);
  }
  if (c.timezone !== undefined && typeof c.timezone !== "string") {
    errors.push("config.clock.timezone must be an IANA timezone string (e.g. America/Sao_Paulo)");
  }
  return errors;
}

/** The fixed instant `config.clock.now` pins to, in epoch ms — or null when unset/unparseable. */
export function frozenNowMs(clock: { now?: string | number } | undefined): number | null {
  if (!clock || clock.now === undefined) return null;
  if (typeof clock.now === "number") return Number.isFinite(clock.now) ? clock.now : null;
  const t = Date.parse(clock.now);
  return Number.isNaN(t) ? null : t;
}

/**
 * The page-side script that pins `Date` and `Date.now()` to a fixed instant.
 * Returned as a plain interpolated STRING (not a function) so no build-time
 * transform can rewrite it — `addInitScript(fn)` serializes a function via
 * `.toString()`, and a downleveled `class extends` drags in a helper that
 * doesn't exist in the page. Frozen, not moving — deterministic for
 * "today"-style assertions; overrides construction with and without `new`.
 */
export function clockInitScript(fixed: number): string {
  return `(() => {
    var _D = Date;
    function FrozenDate() {
      if (!(this instanceof FrozenDate)) return new _D(${fixed}).toString();
      return arguments.length ? new (Function.prototype.bind.apply(_D, [null].concat([].slice.call(arguments))))() : new _D(${fixed});
    }
    FrozenDate.prototype = _D.prototype;
    Object.setPrototypeOf(FrozenDate, _D);
    FrozenDate.now = function () { return ${fixed}; };
    globalThis.Date = FrozenDate;
  })();`;
}
