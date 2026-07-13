import type { Browser } from "./browser.js";
import { createLlmClient, type LlmClient } from "./llm.js";
import { estimateCostUsd } from "./metrics.js";
import type { RunMetrics, Scenario } from "./types.js";

/**
 * Resumo pós-execução (`windup run --summary`): a LLM relata em prosa curta
 * o que o teste fez, os RESULTADOS CONCRETOS observados na página final
 * (preços, mensagens, valores — citados literalmente) e as dificuldades.
 *
 * Opt-in de propósito: replays continuam com zero chamada de LLM por padrão
 * (CI não paga por prosa); o resumo é para o humano em modo debug/leitura.
 * O custo da chamada entra nas métricas do run (campo summary) e no ledger.
 */
export interface RunSummary {
  text: string;
  model: string;
  provider: string;
  tokens: { input: number; output: number };
  est_cost_usd: number;
}

const SNAPSHOT_MAX_CHARS = 8_000;
const FINDINGS_MAX_ACTIONS = 40;

/** Exportada para teste. */
export function buildSummaryPrompt(
  scenario: Scenario,
  metrics: RunMetrics,
  finalUrl: string,
  finalSnapshot: string,
): string {
  const planActions = (metrics.plan?.actions ?? [])
    .slice(0, FINDINGS_MAX_ACTIONS)
    .map((a) => `- ${a.id} ${a.type}${a.target ? ` "${a.target.description}" (${a.target.selector})` : ""}${a.use ? ` fragmento:${a.use}` : ""}${a.expect ? ` [verifica: ${JSON.stringify(a.expect)}]` : ""}`)
    .join("\n");
  const executed = metrics.actions
    .slice(0, FINDINGS_MAX_ACTIONS)
    .map((a) => `- ${a.id}: ${a.status} (${a.duration_ms}ms + ${a.verify_ms}ms de verificação)`)
    .join("\n");
  const anomalies: string[] = [];
  if (metrics.cache === "invalidated") anomalies.push("o plano cacheado falhou e foi re-planejado do zero durante este run");
  if (metrics.sig_mismatch) anomalies.push("a estrutura da página inicial mudou desde que o plano foi gerado (sig_mismatch)");
  if ((metrics.plan_semantic_retries ?? 0) > 0) anomalies.push(`o planejador precisou de ${metrics.plan_semantic_retries} retry semântico`);
  const slow = metrics.actions.filter((a) => a.duration_ms + a.verify_ms > 5000).map((a) => a.id);
  if (slow.length) anomalies.push(`ações lentas (>5s): ${slow.join(", ")}`);

  return `Você é um engenheiro de QA relatando o resultado de um teste E2E que acabou de ser executado por automação determinística.

# Tarefa do teste
${scenario.task}

# Resultado
${metrics.result === "passed" ? "PASSOU" : `FALHOU${metrics.failure ? ` — [${metrics.failure.kind}] na ação ${metrics.failure.action_id ?? "?"}: ${metrics.failure.message}` : ""}`}

# Plano executado
${planActions || "(indisponível)"}

# Execução (tempos e status por ação)
${executed || "(nenhuma ação executada)"}
${anomalies.length ? `\n# Anomalias\n${anomalies.map((a) => `- ${a}`).join("\n")}\n` : ""}
# Página final (URL: ${finalUrl})
${finalSnapshot || "(snapshot indisponível)"}

# O que escrever
Um resumo CURTO (3 a 6 frases, prosa direta, sem markdown e sem listas), no MESMO idioma da tarefa, cobrindo:
1. O que o teste fez e o desfecho (passou/falhou e por quê).
2. Os RESULTADOS CONCRETOS observados na página final que respondem à tarefa — cite valores, preços, textos e mensagens LITERALMENTE como aparecem (ex.: nomes e preços de planos/produtos). Não invente: só o que está no snapshot.
3. Dificuldades ou anomalias, se houver (falha, lentidão, re-planejamento). Se não houver, não mencione.

Responda somente com o resumo.`;
}

export async function generateRunSummary(
  scenario: Scenario,
  metrics: RunMetrics,
  browser: Browser,
  client?: LlmClient,
): Promise<RunSummary> {
  const llm = client ?? createLlmClient();
  let finalUrl = "";
  let snapshot = "";
  try {
    finalUrl = await browser.url();
    snapshot = (await browser.snapshotTree()).slice(0, SNAPSHOT_MAX_CHARS);
  } catch {
    // browser pode ter morrido (falha de rede): o resumo segue só com o plano/execução
  }
  const prompt = buildSummaryPrompt(scenario, metrics, finalUrl, snapshot);
  const response = await llm.generate({ prompt, maxOutputTokens: 1024, temperature: 0.3 });
  const text = response.text.trim();
  if (!text) throw new Error("empty summary from the LLM");
  return {
    text,
    model: llm.model,
    provider: llm.provider,
    tokens: response.tokens,
    est_cost_usd: estimateCostUsd(response.tokens, llm.model),
  };
}
