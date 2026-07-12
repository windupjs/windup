import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RunMetrics } from "./types.js";
import { getContext } from "./context.js";

/** Diretório das métricas por execução, resolvido pelo contexto ativo. */
export function runsDir(): string {
  return getContext().paths.runsDir;
}

/**
 * Preço por 1M de tokens (USD), por modelo. Preços mudam — manter a data.
 * Última conferência: 2026-07-12 (ai.google.dev/gemini-api/docs/pricing).
 * Modelo fora da tabela usa o fallback e loga aviso (estimativa, não fatura).
 */
export const PRICING = {
  asOf: "2026-07-12",
  models: {
    "gemini-3.1-flash-lite": { input: 0.25, output: 1.5 },
    "gemini-3.5-flash": { input: 1.5, output: 9.0 },
    "gemini-2.5-flash": { input: 0.3, output: 2.5 },
  } as Record<string, { input: number; output: number }>,
  fallback: { input: 0.3, output: 2.5 },
} as const;

const warned = new Set<string>();

export function estimateCostUsd(tokens: { input: number; output: number }, model?: string | null): number {
  let price = model ? PRICING.models[model] : undefined;
  if (!price) {
    if (model && !warned.has(model)) {
      warned.add(model);
      console.warn(`warning: no price entry for model "${model}" (as of ${PRICING.asOf}) — cost estimated with fallback rates`);
    }
    price = PRICING.fallback;
  }
  const cost = (tokens.input / 1_000_000) * price.input + (tokens.output / 1_000_000) * price.output;
  return Number(cost.toFixed(6));
}

export async function writeRunMetrics(metrics: RunMetrics): Promise<string> {
  await mkdir(runsDir(), { recursive: true });
  const timestamp = metrics.started_at.replace(/[:.]/g, "-");
  const file = path.join(runsDir(), `${timestamp}-${metrics.scenario_id}.json`);
  await writeFile(file, JSON.stringify(metrics, null, 2));
  return file;
}
