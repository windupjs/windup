import path from "node:path";
import { config } from "dotenv";

/**
 * Env loading with the ecosystem convention (Vite/Next): `.env.local`
 * (gitignored secrets) takes precedence over `.env` (often committed).
 * dotenv never overrides variables already present in the process.
 */
export function loadEnv(cwd: string = process.cwd()): void {
  config({
    path: [path.join(cwd, ".env.local"), path.join(cwd, ".env")],
    quiet: true,
  });
}

loadEnv();
