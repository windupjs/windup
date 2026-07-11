import { GoogleGenAI } from "@google/genai";
import type { Browser } from "./browser.js";
import { PLAN_GEMINI_SCHEMA, validatePlan } from "./schema.js";
import type { Plan, Scenario } from "./types.js";
import { PlanGenerationError, type PlanGeneration, type Planner } from "./runner.js";

/** Orçamento de contexto de página: ~8k tokens ≈ 32k chars (doc 03). */
const PAGE_CONTEXT_MAX_CHARS = 32_000;
const MODEL = (process.env.LLM_MODEL ?? "google/gemini-2.5-flash").replace(/^google\//, "");

function buildPrompt(scenario: Scenario, pageTree: string, interactive: string[], failureContext?: string): string {
  return `Você é um planejador de automação de testes em browser. Gere um plano de ações JSON \
que cumpra a tarefa abaixo. O plano será executado de forma DETERMINÍSTICA, ação por ação, \
sem nenhuma inteligência em tempo de execução — os seletores precisam estar exatos.

# Tarefa
${scenario.task}

# URL inicial
${scenario.start_url}
(o executor já navega para essa URL antes da primeira ação; não inclua um goto para ela)

# Contexto da página inicial (árvore de acessibilidade)
${pageTree}

# Elementos interativos da página inicial (tag id=... name=... data-test=... type=...)
${interactive.join("\n")}

# Regras
- scenario_id deve ser exatamente "${scenario.scenario_id}"; start_url exatamente "${scenario.start_url}"; plan_version "0.1".
- ids das ações sequenciais: a1, a2, a3...
- Use APENAS seletores CSS de elementos presentes no contexto acima (prefira #id). \
Para páginas seguintes à inicial, que você não está vendo, use os seletores CONVENCIONAIS \
do site conforme a tarefa (o saucedemo usa ids estáveis como #checkout, #continue, #finish, \
#first-name, #last-name, #postal-code, botões #add-to-cart-<nome-do-produto-em-kebab-case>, \
link do carrinho .shopping_cart_link).
- Toda ação click/fill/wait_for exige target.selector E target.description (descrição humana do elemento).
- fill usa "value" com o texto literal — exceto quando a tarefa mandar usar uma referência \
de ambiente; nesse caso use "value_ref": "ENV:NOME_DA_VARIAVEL" e NÃO inclua "value".
- Ações que causam navegação devem ter "expect" com "url" (glob, ex.: "**/inventory.html") \
e/ou "selector" da página de destino. A ÚLTIMA ação do plano OBRIGATORIAMENTE tem "expect" \
que comprove que a tarefa foi cumprida.
- timeout_ms: 5000 para ações simples, 10000 para navegações.
- O plano é dados, não programa: sem condicionais, sem loops.
${failureContext ? `\n# Contexto de falha anterior (evite repetir o erro)\n${failureContext}\n` : ""}
Responda somente com o JSON do plano.`;
}

/**
 * Única fronteira com o LLM (doc 03): 1 chamada por cache miss,
 * +1 retry se a validação falhar, com a mensagem de erro no prompt.
 */
export class GeminiPlanner implements Planner {
  private readonly ai: GoogleGenAI;

  constructor() {
    const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    if (!apiKey) {
      throw new Error("GOOGLE_GENERATIVE_AI_API_KEY não definida (necessária para planejar; replays de cache não usam LLM)");
    }
    this.ai = new GoogleGenAI({ apiKey });
  }

  async generate(scenario: Scenario, browser: Browser, failureContext?: string): Promise<PlanGeneration> {
    await browser.goto(scenario.start_url);
    // Espera o app renderizar antes do snapshot (SPA: load não basta).
    await waitForAnyInteractive(browser);
    const pageTree = (await browser.snapshotTree()).slice(0, PAGE_CONTEXT_MAX_CHARS);
    const interactive = await browser.interactiveElements();

    const tokens = { input: 0, output: 0 };
    let llmCalls = 0;
    let lastErrors: string[] = [];
    let prompt = buildPrompt(scenario, pageTree, interactive, failureContext);

    for (let attempt = 1; attempt <= 2; attempt++) {
      const response = await this.ai.models.generateContent({
        model: MODEL,
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: PLAN_GEMINI_SCHEMA,
        },
      });
      llmCalls += 1;
      tokens.input += response.usageMetadata?.promptTokenCount ?? 0;
      tokens.output += response.usageMetadata?.candidatesTokenCount ?? 0;

      let plan: Plan | null = null;
      try {
        plan = JSON.parse(response.text ?? "") as Plan;
      } catch {
        lastErrors = ["resposta não é JSON válido"];
      }

      if (plan) {
        const validation = validatePlan(plan);
        if (validation.ok) {
          plan.task = scenario.task;
          plan.generated_by = { model: MODEL, at: new Date().toISOString() };
          return { plan, llm_calls: llmCalls, model: MODEL, planning_mode: "full", tokens };
        }
        lastErrors = validation.errors;
      }

      // 1 retry com a mensagem de erro no prompt (doc 03); 2ª falha aborta.
      prompt = `${prompt}\n\n# ERRO na tentativa anterior — corrija e gere o plano novamente\n${lastErrors.join("\n")}`;
    }

    throw new PlanGenerationError(
      `plano inválido após retry: ${lastErrors.join("; ")}`,
      tokens,
      llmCalls,
    );
  }
}

async function waitForAnyInteractive(browser: Browser, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const els = await browser.interactiveElements();
    if (els.length > 0) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}
