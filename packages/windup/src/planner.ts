import { GoogleGenAI } from "@google/genai";
import type { Browser } from "./browser.js";
import { PLAN_GEMINI_SCHEMA, validatePlan } from "./schema.js";
import type { Plan, Scenario } from "./types.js";
import { PlanGenerationError, type PlanGeneration, type Planner } from "./runner.js";

/** Orçamento de contexto de página: ~8k tokens ≈ 32k chars (doc 03). */
const PAGE_CONTEXT_MAX_CHARS = 32_000;
const MODEL = (process.env.LLM_MODEL ?? "google/gemini-2.5-flash").replace(/^google\//, "");

function buildPrompt(scenario: Scenario, pageTree: string, interactive: string[], failureContext?: string): string {
  // Princípio do doc 07: ZERO conhecimento de site hardcoded no prompt.
  // Conhecimento site-específico só entra por hints do autor do cenário.
  const hintsSection = scenario.hints?.length
    ? `\n# Dicas fornecidas pelo autor do cenário\n${scenario.hints.join("\n")}\n`
    : "";
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
- Para a página inicial, use APENAS seletores CSS de elementos presentes no contexto acima \
(prefira #id). Para páginas seguintes, que você não está vendo, infira seletores prováveis \
a partir da tarefa e das convenções comuns da web (ids/names semânticos, data-test). \
Prefira seletores estáveis.
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

LEMBRETE FINAL: a última ação do plano DEVE conter o campo "expect" comprovando a tarefa cumprida.
${hintsSection}${failureContext ? `\n# Contexto de falha anterior (evite repetir o erro)\n${failureContext}\n` : ""}
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

  private async callGemini(ai: GoogleGenAI, prompt: string, seed: number) {
    return ai.models.generateContent({
      model: MODEL,
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: PLAN_GEMINI_SCHEMA,
        // Planejar é transcrição de tarefa em ações, não raciocínio longo:
        // thinking desligado corta ~10x de latência e custo no flash.
        thinkingConfig: { thinkingBudget: 0 },
        // Um plano de 30 ações cabe em ~3k tokens; o teto limita o custo
        // de gerações degeneradas (observado: 65k tokens num run).
        maxOutputTokens: 8192,
        // temp > 0 de propósito: com temp 0 a degeneração (loop até
        // MAX_TOKENS) fica determinística por prompt — jitter + seeds
        // distintos por tentativa escapam da bacia degenerada.
        temperature: 0.3,
        seed,
      },
    });
  }

  async generate(scenario: Scenario, browser: Browser, failureContext?: string): Promise<PlanGeneration> {
    const ai = this.client();
    await browser.goto(scenario.start_url);
    // Espera o app renderizar antes do snapshot (SPA: load não basta).
    await waitForAnyInteractive(browser);
    const pageTree = (await browser.snapshotTree()).slice(0, PAGE_CONTEXT_MAX_CHARS);
    const interactive = await browser.interactiveElements();
    const startSig = await browser.pageSignature();

    const tokens = { input: 0, output: 0 };
    let llmCalls = 0;
    let lastErrors: string[] = [];
    let prompt = buildPrompt(scenario, pageTree, interactive, failureContext);

    // Dois níveis de retry, de natureza diferente:
    // - semântico (doc 03): plano reprovado na validação → 1 retry com o erro no prompt;
    // - transiente: o flash com structured output às vezes degenera (loop de
    //   tokens até truncar em MAX_TOKENS) de forma não-determinística, com a
    //   MESMA entrada que noutras vezes funciona. Isso é patologia de API, não
    //   erro do plano — re-chama com outro seed, até 3x por tentativa semântica.
    for (let attempt = 1; attempt <= 2; attempt++) {
      let plan: Plan | null = null;
      let rawText = "";

      for (let apiTry = 1; apiTry <= 3 && !plan; apiTry++) {
        let response;
        try {
          response = await this.callGemini(ai, prompt, attempt * 10 + apiTry);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (/fetch failed|ECONN|ENOTFOUND|ETIMEDOUT|429|500|503/i.test(message)) {
            lastErrors = [`falha de rede/quota na chamada ao Gemini: ${message}`];
            await new Promise((r) => setTimeout(r, apiTry * 2000));
            continue;
          }
          throw err;
        }
        llmCalls += 1;
        tokens.input += response.usageMetadata?.promptTokenCount ?? 0;
        tokens.output += response.usageMetadata?.candidatesTokenCount ?? 0;

        const finishReason = response.candidates?.[0]?.finishReason;
        if (process.env.LOG_LEVEL === "debug") {
          const text = response.text ?? "";
          console.error(
            `[planner] tentativa ${attempt}.${apiTry}: finishReason=${finishReason} out_tokens=${response.usageMetadata?.candidatesTokenCount} thoughts=${response.usageMetadata?.thoughtsTokenCount} len=${text.length} tail=${JSON.stringify(text.slice(-120))}`,
          );
        }
        if (finishReason === "MAX_TOKENS") {
          lastErrors = ["resposta degenerada/truncada (MAX_TOKENS) — falha transiente da API"];
          continue;
        }
        try {
          rawText = response.text ?? "";
          plan = normalizeActions(sanitizePlan(JSON.parse(rawText))) as Plan;
        } catch {
          lastErrors = ["resposta não era JSON válido — falha transiente da API"];
        }
      }

      if (plan) {
        const validation = validatePlan(plan);
        if (validation.ok) {
          plan.task = scenario.task;
          plan.generated_by = { model: MODEL, at: new Date().toISOString() };
          return { plan, llm_calls: llmCalls, model: MODEL, planning_mode: "full", tokens, semantic_retries: attempt - 1, start_sig: startSig };
        }
        lastErrors = validation.errors;
        if (process.env.LOG_LEVEL === "debug") {
          console.error(`[planner] tentativa ${attempt} inválida: ${lastErrors.join("; ")}\n${JSON.stringify(plan, null, 2)}`);
        }
      }

      // 1 retry semântico com a mensagem de erro no prompt (doc 03); 2ª falha aborta.
      // Retry CURTO de propósito: plano anterior + erros. Reenviar o prompt
      // inteiro com o aviso de erro em cima fazia o flash degenerar (divagação
      // em maiúsculas dentro do JSON até estourar MAX_TOKENS).
      prompt = `Você gerou o plano de ações JSON abaixo para a tarefa "${scenario.task}", mas ele é INVÁLIDO.

# Plano anterior
${plan ? JSON.stringify(plan, null, 2) : rawText.slice(0, 4000)}

# Erros de validação a corrigir
${lastErrors.join("\n")}

# Regras
- click/fill/wait_for exigem target.selector e target.description; goto exige url.
- fill exige value OU value_ref (exatamente um); não use campos vazios nem campos que não se aplicam.
- A ÚLTIMA ação deve ter o campo "expect" (selector e/ou url) comprovando a tarefa cumprida.
- scenario_id "${scenario.scenario_id}", start_url "${scenario.start_url}", plan_version "0.1".

Devolva o plano completo corrigido. Responda APENAS com o JSON do plano.`;
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
      // "undefined"/"null" literais são artefatos do modelo para "não se aplica".
      if (value === "" || value === null || value === undefined || value === "undefined" || value === "null") continue;
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
  // Ids são contabilidade interna (nada os referencia): renumerar é sempre
  // seguro e elimina toda uma classe de reprovação ("1", "step-2", "action3"...).
  (plan.actions as Record<string, unknown>[]).forEach((action, i) => {
    if (action !== null && typeof action === "object") action.id = `a${i + 1}`;
  });

  // O modelo às vezes expressa a verificação final como wait_for em vez de
  // expect (ou vice-versa). wait_for(X) ≡ expect.selector X — normaliza nos
  // dois sentidos sem mudar o significado.
  const last = plan.actions[plan.actions.length - 1] as Record<string, unknown> | undefined;
  if (last && last.type === "wait_for") {
    const target = (last.target ?? null) as { selector?: string } | null;
    const expect = (last.expect ?? null) as { selector?: string } | null;
    if (!expect?.selector && target?.selector) {
      last.expect = { ...(expect ?? {}), selector: target.selector };
    } else if (expect?.selector && !target?.selector) {
      last.target = { selector: expect.selector, description: "elemento aguardado na verificação final" };
    }
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
