import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getContext } from "./context.js";

/**
 * Test credentials with no secret in a committed file:
 *
 * - VALUES live in `.env.local` (gitignored; in CI, they become secrets with
 *   the same variable names);
 * - the account → ENV-name MAPPING lives in `windup.credentials.json`
 *   (committable — contains no values) and is merged into the manifest
 *   (`context.credentials`) at context creation;
 * - scenarios and plans reference the account by name / `value_ref: "ENV:X"`;
 *   the real value is only resolved by the executor, at runtime — it never
 *   enters the cache, the planning prompt or git.
 *
 * Fed by `windup secret set` and by authoring (`windup new`, which
 * automatically registers literal credentials detected in the instruction).
 */

export const CREDENTIALS_FILE = "windup.credentials.json";

export interface CredentialsFile {
  $comment?: string;
  accounts: Record<string, Record<string, string>>;
}

export function credentialsFilePath(root = getContext().paths.root): string {
  return path.join(root, CREDENTIALS_FILE);
}

/** Committed mapping (no values). Tolerant of a missing/corrupted file. */
export function loadCredentialsFile(root: string): Record<string, Record<string, string>> {
  try {
    const parsed = JSON.parse(readFileSync(path.join(root, CREDENTIALS_FILE), "utf8")) as CredentialsFile;
    return parsed.accounts ?? {};
  } catch {
    return {};
  }
}

export function envName(account: string, field: string): string {
  const clean = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return `WINDUP_${clean(account)}_${clean(field)}`;
}

/** Account name from an email (local part) or "default". */
export function deriveAccountName(email?: string): string {
  const local = email?.split("@")[0] ?? "";
  return local.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "default";
}

function upsertEnvLine(file: string, key: string, value: string): void {
  const line = `${key}=${value}`;
  if (!existsSync(file)) {
    writeFileSync(file, `${line}\n`, { mode: 0o600 });
    return;
  }
  const content = readFileSync(file, "utf8");
  const pattern = new RegExp(`^${key}=.*$`, "m");
  if (pattern.test(content)) {
    writeFileSync(file, content.replace(pattern, line));
  } else {
    appendFileSync(file, `${content.endsWith("\n") || content === "" ? "" : "\n"}${line}\n`);
  }
}

function ensureGitignored(root: string, entry: string): void {
  const file = path.join(root, ".gitignore");
  const content = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (content.split("\n").some((l) => l.trim() === entry)) return;
  writeFileSync(file, `${content.endsWith("\n") || content === "" ? content : `${content}\n`}${entry}\n`);
}

export interface RegisteredCredentials {
  account: string;
  /** field → ENV name (e.g. password → WINDUP_ADMIN_PASSWORD). */
  envs: Record<string, string>;
}

/**
 * Registers an account: values in .env.local (ensuring the gitignore),
 * mapping in windup.credentials.json and in the CURRENT context's manifest
 * (so the registration takes effect immediately in the same process).
 */
export function registerCredentials(account: string, fields: Record<string, string>): RegisteredCredentials {
  const ctx = getContext();
  const root = ctx.paths.root;
  const envFile = path.join(root, ".env.local");
  const envs: Record<string, string> = {};

  for (const [field, value] of Object.entries(fields)) {
    const name = envName(account, field);
    envs[field] = name;
    upsertEnvLine(envFile, name, value);
    // takes effect already in this process (authoring registers then plans/validates right after)
    process.env[name] = value;
  }
  ensureGitignored(root, ".env.local");

  const accounts = loadCredentialsFile(root);
  accounts[account] = { ...accounts[account], ...Object.fromEntries(Object.entries(envs).map(([f, n]) => [f, `ENV:${n}`])) };
  const payload: CredentialsFile = {
    $comment: "windup account → ENV-name mapping. No secret values here — commit this file; values live in .env.local (gitignored) or CI secrets with these names.",
    accounts,
  };
  writeFileSync(credentialsFilePath(root), `${JSON.stringify(payload, null, 2)}\n`);

  ctx.config.context = ctx.config.context ?? {};
  ctx.config.context.credentials = { ...ctx.config.context.credentials, [account]: accounts[account] };
  return { account, envs };
}
