import { exec } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { WindupConfig } from "./config.js";
import { getContext } from "./context.js";

const pexec = promisify(exec);
export type ResolverSpec = NonNullable<WindupConfig["resolve"]>[string];

/** Fetch the raw source output for a resolver (author-declared; never LLM-specified). */
async function fetchSource(source: ResolverSpec["source"]): Promise<string> {
  const root = getContext().paths.root;
  switch (source.kind) {
    case "cmd": {
      if (!source.command) throw new Error("resolve cmd: missing `command`");
      const { stdout } = await pexec(source.command, { cwd: root, env: process.env, timeout: 20_000, windowsHide: true });
      return stdout;
    }
    case "http": {
      if (!source.url) throw new Error("resolve http: missing `url`");
      const res = await fetch(source.url, { method: source.method ?? "GET", headers: source.headers, body: source.body });
      return res.text();
    }
    case "fn": {
      if (!source.module) throw new Error("resolve fn: missing `module`");
      const mod = (await import(path.resolve(root, source.module))) as Record<string, unknown>;
      const fn = source.export ? mod[source.export] : (mod.default ?? mod);
      if (typeof fn !== "function") throw new Error(`resolve fn: ${source.module} export "${source.export ?? "default"}" is not a function`);
      return String(await (fn as () => unknown)());
    }
    default:
      throw new Error(`resolve: unknown source kind "${(source as { kind: string }).kind}"`);
  }
}

/** Pull the value out of the raw output: regex (group 1 or whole match) or a dot-path into JSON. Empty string = "not yet". */
export function extractValue(raw: string, spec?: ResolverSpec["extract"]): string {
  if (!spec) return raw.trim();
  if (spec.regex) {
    const m = new RegExp(spec.regex).exec(raw);
    return m ? (m[1] ?? m[0]).trim() : "";
  }
  if (spec.json) {
    let cur: unknown;
    try {
      cur = JSON.parse(raw);
    } catch {
      return "";
    }
    for (const key of spec.json.split(".")) {
      if (cur == null || typeof cur !== "object") return "";
      cur = (cur as Record<string, unknown>)[key];
    }
    return cur == null ? "" : String(cur);
  }
  return raw.trim();
}

/**
 * Resolve a dynamic value, polling until it appears (default 30s / 1s). Used for
 * OTP codes, magic-link URLs, etc. — values only known at run time. The returned
 * value is ephemeral: callers must never persist or log it.
 */
export async function runResolver(name: string, spec: ResolverSpec): Promise<string> {
  const timeout = spec.poll?.timeout_ms ?? 30_000;
  const interval = spec.poll?.interval_ms ?? 1_000;
  const deadline = Date.now() + timeout;
  let lastErr = "";
  for (;;) {
    try {
      const value = extractValue(await fetchSource(spec.source), spec.extract);
      if (value) return value;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
    if (Date.now() >= deadline) {
      throw new Error(`resolve "${name}" did not produce a value within ${timeout}ms${lastErr ? ` (last error: ${lastErr})` : ""}`);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}
