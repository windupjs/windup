import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getContext } from "./context.js";

/**
 * Credenciais de teste sem segredo em arquivo commitado:
 *
 * - VALORES vivem no `.env.local` (gitignored; em CI, viram secrets com os
 *   mesmos nomes de variável);
 * - o MAPEAMENTO conta → nomes de ENV vive em `windup.credentials.json`
 *   (commitável — não contém nenhum valor) e é mesclado ao manifesto
 *   (`context.credentials`) na criação do contexto;
 * - cenários e planos referenciam a conta pelo nome / `value_ref: "ENV:X"`;
 *   o valor real só é resolvido pelo executor, em runtime — nunca entra no
 *   cache, no prompt de planejamento nem no git.
 *
 * Alimentado pelo `windup secret set` e pela autoria (`windup new`, que
 * registra automaticamente credenciais literais detectadas na instrução).
 */

export const CREDENTIALS_FILE = "windup.credentials.json";

export interface CredentialsFile {
  $comment?: string;
  accounts: Record<string, Record<string, string>>;
}

export function credentialsFilePath(root = getContext().paths.root): string {
  return path.join(root, CREDENTIALS_FILE);
}

/** Mapeamento commitado (sem valores). Tolerante a arquivo ausente/corrompido. */
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

/** Nome de conta a partir de um e-mail (parte local) ou "default". */
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
  /** campo → nome da ENV (ex.: password → WINDUP_ADMIN_PASSWORD). */
  envs: Record<string, string>;
}

/**
 * Registra uma conta: valores no .env.local (garantindo o gitignore),
 * mapeamento no windup.credentials.json e no manifesto do contexto ATUAL
 * (para o registro valer imediatamente no mesmo processo).
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
    // vale já neste processo (autoria registra e planeja/valida em seguida)
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
