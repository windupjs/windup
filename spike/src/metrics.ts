import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RunMetrics } from "./types.js";

export const RUNS_DIR = path.resolve(import.meta.dirname, "..", "runs");

/**
 * Preço por 1M de tokens do gemini-2.5-flash (USD).
 * Preços mudam — manter a data. Última conferência: tabela vigente desde 2026-07-02.
 */
export const PRICING = {
  model: "gemini-2.5-flash",
  inputPerMTokens: 0.3,
  outputPerMTokens: 2.5,
  asOf: "2026-07-02",
} as const;

export function estimateCostUsd(tokens: { input: number; output: number }): number {
  const cost =
    (tokens.input / 1_000_000) * PRICING.inputPerMTokens +
    (tokens.output / 1_000_000) * PRICING.outputPerMTokens;
  return Number(cost.toFixed(6));
}

export async function writeRunMetrics(metrics: RunMetrics): Promise<string> {
  await mkdir(RUNS_DIR, { recursive: true });
  const timestamp = metrics.started_at.replace(/[:.]/g, "-");
  const file = path.join(RUNS_DIR, `${timestamp}-${metrics.scenario_id}.json`);
  await writeFile(file, JSON.stringify(metrics, null, 2));
  return file;
}
