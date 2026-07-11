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
e/ou "selector" da página de destino. A ÚLTIMA ação do plano OBRIGATORIAMENTE tem o campo "expect" \
que comprove que a tarefa foi cumprida — a verificação final é o "expect" da última ação, \
NÃO uma ação wait_for extra.
- timeout_ms: 5000 para ações simples, 10000 para navegações.
- NÃO inclua campos que não se aplicam à ação — jamais use string vazia como valor. \
click não tem value/value_ref/url. O campo "url" da ação existe SÓ em goto (destino de navegação). \
URL esperada após a ação vai em expect.url (aceita glob).
- O plano é dados, não programa: sem condicionais, sem loops.

# Exemplo do formato (login simples — adapte à tarefa real)
{
  "plan_version": "0.1",
  "scenario_id": "exemplo",
  "start_url": "https://exemplo.com",
  "actions": [
    { "id": "a1", "type": "fill", "target": { "selector": "#user", "description": "campo de usuário" }, "value": "fulano", "timeout_ms": 5000 },
    { "id": "a2", "type": "fill", "target": { "selector": "#pass", "description": "campo de senha" }, "value_ref": "ENV:MINHA_SENHA", "timeout_ms": 5000 },
    { "id": "a3", "type": "click", "target": { "selector": "#entrar", "description": "botão de entrar" }, "expect": { "url": "**/home.html", "selector": ".lista" }, "timeout_ms": 10000 }
  ]
}
${failureContext ? `\n# Contexto de falha anterior (evite repetir o erro)\n${failureContext}\n` : ""}
Responda somente com o JSON do plano.`;
}

/**
 * Única fronteira com o LLM (doc 03): 1 chamada por cache miss,
 * +1 retry se a validação falhar, com a mensagem de erro no prompt.
 */
export class GeminiPlanner implements Planner {
  // Preguiçoso de propósito: replays de cache nunca planejam, então não
  // devem exigir a chave do Gemini.
  private ai: GoogleGenAI | null = null;

  private client(): GoogleGenAI {
    if (!this.ai) {
      const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      if (!apiKey) {
        throw new Error("GOOGLE_GENERATIVE_AI_API_KEY não definida (necessária para planejar; replays de cache não usam LLM)");
      }
      this.ai = new GoogleGenAI({ apiKey });
    }
    return this.ai;
  }

  async generate(scenario: Scenario, browser: Browser, failureContext?: string): Promise<PlanGeneration> {
    const ai = this.client();
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
      const response = await ai.models.generateContent({
        model: MODEL,
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: PLAN_GEMINI_SCHEMA,
          // Planejar é transcrição de tarefa em ações, não raciocínio longo:
          // thinking desligado corta ~10x de latência e custo no flash.
          thinkingConfig: { thinkingBudget: 0 },
        },
      });
      llmCalls += 1;
      tokens.input += response.usageMetadata?.promptTokenCount ?? 0;
      tokens.output += response.usageMetadata?.candidatesTokenCount ?? 0;

      let plan: Plan | null = null;
      try {
        plan = normalizeActions(sanitizePlan(JSON.parse(response.text ?? ""))) as Plan;
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
        if (process.env.LOG_LEVEL === "debug") {
          console.error(`[planner] tentativa ${attempt} inválida: ${lastErrors.join("; ")}\n${JSON.stringify(plan, null, 2)}`);
        }
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

/**
 * O structured output do Gemini tende a preencher campos opcionais com "" em
 * vez de omiti-los. Remove recursivamente strings vazias, nulls e objetos que
 * ficarem vazios, antes da validação (o Ajv continua sendo a autoridade).
 */
export function sanitizePlan(data: unknown): unknown {
  if (Array.isArray(data)) return data.map(sanitizePlan);
  if (data !== null && typeof data === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      if (value === "" || value === null || value === undefined) continue;
      const cleaned = sanitizePlan(value);
      if (cleaned !== null && typeof cleaned === "object" && !Array.isArray(cleaned) && Object.keys(cleaned).length === 0) continue;
      result[key] = cleaned;
    }
    return result;
  }
  return data;
}

/**
 * Remove campos que não se aplicam ao tipo da ação (o flash tende a vazá-los:
 * ex. "url" ou "value" numa ação click). Não altera a lógica do plano — só
 * descarta ruído que o executor ignoraria e o schema reprovaria.
 */
export function normalizeActions(data: unknown): unknown {
  if (data === null || typeof data !== "object" || !("actions" in data)) return data;
  const plan = data as { actions?: unknown };
  if (!Array.isArray(plan.actions)) return data;
  for (const action of plan.actions as Record<string, unknown>[]) {
    if (action === null || typeof action !== "object") continue;
    switch (action.type) {
      case "click":
      case "wait_for":
        delete action.value;
        delete action.value_ref;
        delete action.url;
        break;
      case "fill":
        delete action.url;
        if (action.value !== undefined && action.value_ref !== undefined) delete action.value_ref;
        break;
      case "goto":
        delete action.value;
        delete action.value_ref;
        break;
    }
  }
  // O modelo às vezes expressa a verificação final como wait_for em vez de
  // expect. wait_for(X) ≡ expect.selector X — normaliza sem mudar o sentido.
  const last = plan.actions[plan.actions.length - 1] as Record<string, unknown> | undefined;
  if (
    last &&
    last.type === "wait_for" &&
    last.expect === undefined &&
    typeof last.target === "object" &&
    last.target !== null &&
    "selector" in last.target
  ) {
    last.expect = { selector: (last.target as { selector: string }).selector };
  }
  return data;
}

async function waitForAnyInteractive(browser: Browser, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const els = await browser.interactiveElements();
    if (els.length > 0) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}
