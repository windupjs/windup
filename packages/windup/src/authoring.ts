import { mkdir, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { getContext } from "./context.js";
import { createLlmClient, type LlmClient } from "./llm.js";
import { estimateCostUsd } from "./metrics.js";
import { buildManifestSection } from "./planner.js";
import { SiteMapStore } from "./sitemap.js";
import { startPath } from "./start-url.js";

/**
 * `windup new` — gerador de cenários (autoria assistida): o autor escreve uma
 * instrução crua ("login com admin e criar uma fatura") e a LLM, atuando como
 * gestor de testes, a transforma num cenário bem escrito — enriquecido com o
 * conhecimento do site (scan/mapa) e o manifesto do projeto (E4).
 *
 * O resultado é um ARQUIVO para o autor revisar e commitar, nunca uma execução:
 * autoria e execução são fases distintas de propósito — o cenário continua
 * sendo conhecimento curado pelo time (doc 07), a LLM só reduz o esforço de
 * escrevê-lo bem.
 */
export interface AuthoredScenario {
  scenario_id: string;
  /** Ausente em cenário dependente: continua da página final do depends_on. */
  start_url?: string;
  task: string;
  hints?: string[];
  depends_on?: string[];
}

export interface AuthoringResult {
  file: string;
  scenario: AuthoredScenario;
  /** Conta registrada automaticamente a partir de credenciais literais da instrução. */
  registered_account?: string;
  llm_calls: number;
  tokens: { input: number; output: number };
  model: string;
  provider: string;
  est_cost_usd: number;
}

const AUTHORING_SCHEMA = {
  type: "object",
  required: ["scenario_id", "start_url", "task"],
  properties: {
    scenario_id: { type: "string" },
    start_url: { type: "string" },
    task: { type: "string" },
    hints: { type: "array", items: { type: "string" } },
  },
};

/** Orçamentos na mesma disciplina do planejador: prompt de tamanho ≈ constante. */
const MAP_BUDGET_CHARS = 8_000;

export function buildAuthoringPrompt(
  instruction: string,
  siteKnowledge: string,
  manifestSection: string,
  existingIds: string[],
  registeredAccount?: string,
): string {
  const knowledgeSection = siteKnowledge
    ? `\n# Conhecimento do site (rotas e elementos reais, vindos de scan e execuções)\nUse APENAS telas/rotas/elementos listados aqui ao detalhar o fluxo; NÃO invente telas que não constam. Se o conhecimento não cobrir parte do fluxo, descreva essa parte em termos do objetivo (sem inventar seletores).\n\n${siteKnowledge}\n`
    : "\n# Conhecimento do site\n(nenhum ainda — descreva o fluxo em termos do objetivo, sem inventar telas ou seletores; sugira ao autor rodar `windup scan`)\n";
  const existingSection = existingIds.length
    ? `\n# Cenários já existentes (o scenario_id novo NÃO pode repetir estes)\n${existingIds.join(", ")}\n`
    : "";
  const credsSection = registeredAccount
    ? `\n# Credenciais registradas\nAs credenciais literais da instrução foram registradas com segurança como a conta "${registeredAccount}" do Manifesto. Na task, refira-se a elas APENAS como "a conta ${registeredAccount}" — NUNCA escreva o e-mail/usuário/senha literais na task nem nas hints.\n`
    : "";
  return `Você é um gestor de testes E2E experiente. Transforme a instrução crua abaixo num cenário de teste bem escrito para o Windup (testes em linguagem natural com execução determinística).

# Instrução crua do autor
${instruction}
${knowledgeSection}${manifestSection}${credsSection}${existingSection}
# O que devolver (JSON)
- "scenario_id": kebab-case, curto e descritivo do fluxo (ex.: "criar-fatura").
- "start_url": path relativo onde o fluxo começa, escolhido EXATAMENTE da lista de rotas conhecidas quando ela existir (nunca invente um path — nem convenções como "/index.html"); "/" na dúvida. Nunca inclua host/porta.
- "task": a instrução reescrita como um fluxo de usuário claro, específico e executável, em prosa passo a passo:
  - cite telas, menus e botões pelos nomes REAIS do conhecimento do site quando existirem;
  - para preenchimento de formulários, especifique valores fictícios CONCRETOS (nomes, e-mails, quantias);
  - se a instrução citar uma conta que exista no Manifesto do projeto (inclusive a conta indicada na seção "Credenciais registradas", se houver), refira-se à conta pelo NOME (ex.: "a conta admin") — NUNCA escreva e-mail/usuário/senha literais na task;
  - a task DEVE terminar dizendo O QUE VERIFICAR: uma condição observável que comprove o sucesso (mensagem exibida, item na lista, URL da tela de destino);
  - escreva a task no MESMO idioma da instrução do autor.
- "hints": OPCIONAL — no máximo 3 dicas de seletores/telas tiradas do conhecimento do site que ajudem o planejador; omita se não agregar.

Responda somente com o JSON do cenário.`;
}

function kebab(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/**
 * Credenciais literais fornecidas na instrução (e-mails e senhas). São
 * insumo do teste: a task gerada TEM que preservá-las, senão o planejador
 * fica sem a senha e inventa uma (visto no dogfood: login silenciosamente
 * errado e falha confusa 3 ações depois). Exportada para teste.
 */
export function literalCredentials(instruction: string): string[] {
  const found = new Set<string>();
  for (const m of instruction.matchAll(/[\w.+-]+@[\w-]+\.[\w.-]+/g)) found.add(m[0]);
  for (const m of instruction.matchAll(/(?:senha|password|pass)\s*[:=]?\s+(\S+)/gi)) found.add(m[1].replace(/[.,;]$/, ""));
  return [...found];
}

function validate(data: unknown, instruction = "", registeredAccount?: string): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const s = data as Partial<AuthoredScenario> | null;
  if (!s || typeof s !== "object") errors.push("resposta não é um objeto JSON");
  else {
    if (!s.scenario_id || typeof s.scenario_id !== "string") errors.push("scenario_id ausente");
    if (!s.task || typeof s.task !== "string" || s.task.trim().length < 20) errors.push("task ausente ou curta demais (reescreva o fluxo completo, terminando com o que verificar)");
    if (!s.start_url || typeof s.start_url !== "string") errors.push("start_url ausente (use um path como \"/\")");
    if (s.hints !== undefined && (!Array.isArray(s.hints) || s.hints.some((h) => typeof h !== "string"))) errors.push("hints deve ser uma lista de strings");
    if (s.task && registeredAccount) {
      const haystack = `${s.task} ${(s.hints ?? []).join(" ")}`;
      for (const cred of literalCredentials(instruction)) {
        if (haystack.includes(cred)) {
          errors.push(`a task/hints contém a credencial literal "${cred}" — as credenciais foram registradas como a conta "${registeredAccount}"; refira-se a ela pelo nome, nunca pelos valores`);
        }
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

export async function generateScenario(
  instruction: string,
  opts: { id?: string; force?: boolean; dependsOn?: string[] } = {},
  client?: LlmClient,
): Promise<AuthoringResult> {
  const ctx = getContext();
  const llm = client ?? createLlmClient();

  const store = await SiteMapStore.load(ctx.paths.mapFile);
  const siteKnowledge = store.sliceForAuthoring(instruction, MAP_BUDGET_CHARS);
  const knownPaths = store.knownPaths();

  // Segurança por padrão: credenciais literais na instrução NÃO vão para o
  // cenário (arquivo commitado). Viram uma conta registrada — valores no
  // .env.local, mapeamento no windup.credentials.json — e a task referencia
  // a conta; o executor resolve o ENV só em runtime.
  const creds = literalCredentials(instruction);
  let registeredAccount: string | undefined;
  if (creds.length) {
    const { deriveAccountName, registerCredentials } = await import("./secrets.js");
    const email = creds.find((c) => c.includes("@"));
    const password = creds.find((c) => !c.includes("@"));
    const account = deriveAccountName(email);
    const existing = ctx.config.context?.credentials?.[account];
    if (!existing) {
      registerCredentials(account, {
        ...(email ? { user: email } : {}),
        ...(password ? { password } : {}),
      });
    }
    registeredAccount = account;
  }

  let existingIds: string[] = [];
  try {
    existingIds = (await readdir(ctx.paths.scenariosDir))
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""))
      .sort();
  } catch {
    // scenariosDir ainda não existe
  }

  const tokens = { input: 0, output: 0 };
  let llmCalls = 0;
  const dependsSection = opts.dependsOn?.length
    ? `\n# Dependências declaradas\nEste cenário roda APÓS os cenários ${opts.dependsOn.map((d) => `"${d}"`).join(", ")} (na mesma sessão). Descreva o fluxo a partir do ESTADO FINAL deles (ex.: usuário já autenticado) — NÃO repita os passos que as dependências já cobrem.\n`
    : "";
  let prompt = buildAuthoringPrompt(instruction, siteKnowledge, buildManifestSection(), existingIds, registeredAccount) + dependsSection;
  let scenario: AuthoredScenario | null = null;
  let lastErrors: string[] = [];

  // Mesmo espírito do planejador: 1 retry semântico curto com os erros.
  for (let attempt = 1; attempt <= 2 && !scenario; attempt++) {
    const response = await llm.generate({ prompt, schema: AUTHORING_SCHEMA, maxOutputTokens: 2048, temperature: 0.3, seed: attempt * 10 });
    llmCalls += 1;
    tokens.input += response.tokens.input;
    tokens.output += response.tokens.output;
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(response.text);
    } catch {
      lastErrors = ["resposta não era JSON válido"];
    }
    if (parsed) {
      const check = validate(parsed, instruction, registeredAccount);
      if (check.ok) {
        scenario = parsed as AuthoredScenario;
        break;
      }
      // Vazamento de credencial no ÚLTIMO retry não aborta: a limpeza
      // mecânica abaixo resolve — o modelo não tem a palavra final sobre
      // o que vai para um arquivo commitado.
      if (attempt === 2 && check.errors.every((e) => e.includes("contém a credencial literal"))) {
        scenario = parsed as AuthoredScenario;
        break;
      }
      lastErrors = check.errors;
    }
    prompt = `Você gerou o cenário JSON abaixo para a instrução "${instruction}", mas ele é INVÁLIDO.\n\n# Resposta anterior\n${response.text.slice(0, 3000)}\n\n# Erros a corrigir\n${lastErrors.join("\n")}\n\nDevolva o cenário completo corrigido (scenario_id, start_url, task e opcionalmente hints). Responda APENAS com o JSON.`;
  }
  if (!scenario) {
    throw new Error(`could not generate a valid scenario after retry: ${lastErrors.join("; ")}`);
  }

  // Cinto e suspensório: nada de credencial literal sobrevive no arquivo.
  if (registeredAccount) {
    for (const cred of creds) {
      scenario.task = scenario.task.split(cred).join(`a conta ${registeredAccount}`);
      scenario.hints = scenario.hints?.map((h) => h.split(cred).join(`a conta ${registeredAccount}`));
    }
  }

  // Normalizações mecânicas (mesma filosofia do sanitize do planejador):
  // id em kebab-case, start_url como path, unicidade garantida por sufixo.
  scenario.scenario_id = kebab(opts.id ?? scenario.scenario_id) || "novo-cenario";
  scenario.start_url = startPath(scenario.start_url ?? "/");
  if (opts.dependsOn?.length) {
    (scenario as AuthoredScenario & { depends_on?: string[] }).depends_on = opts.dependsOn;
    // dependente sem necessidade de goto: continua da página final da dependência
    delete (scenario as Partial<AuthoredScenario>).start_url;
  }
  // start_url inventado (não consta no mapa) desorienta a execução inteira:
  // (cenário dependente sem start_url pula esta validação — não há goto)
  // com mapa disponível, cai para "/" — o planejador vê a página real de
  // qualquer forma. Visto no dogfood: o modelo inventou "/index.html" por
  // convenção, uma rota que o app real não renderiza.
  if (scenario.start_url && knownPaths.length > 0 && !knownPaths.includes(scenario.start_url)) {
    console.warn(`warning: start_url "${scenario.start_url}" is not a known route — falling back to "/"`);
    scenario.start_url = "/";
  }
  if (scenario.hints && scenario.hints.length === 0) delete scenario.hints;
  if (!opts.force && !opts.id) {
    let candidate = scenario.scenario_id;
    for (let n = 2; existingIds.includes(candidate); n++) candidate = `${scenario.scenario_id}-${n}`;
    scenario.scenario_id = candidate;
  }

  await mkdir(ctx.paths.scenariosDir, { recursive: true });
  const file = path.join(ctx.paths.scenariosDir, `${scenario.scenario_id}.json`);
  if (existsSync(file) && !opts.force) {
    throw new Error(`scenario "${scenario.scenario_id}" already exists (${file}) — use --force to overwrite or --id for another name`);
  }
  await writeFile(file, `${JSON.stringify(scenario, null, 2)}\n`);

  // Gasto de autoria entra no MESMO ledger (windup costs), como o scan.
  const cost = estimateCostUsd(tokens, llm.model);
  await mkdir(ctx.paths.runsDir, { recursive: true });
  const record = {
    kind: "authoring",
    started_at: new Date().toISOString(),
    scenario_generated: scenario.scenario_id,
    llm_calls: llmCalls,
    llm_model: llm.model,
    llm_provider: llm.provider,
    tokens,
    estimated_cost_usd: cost,
  };
  await writeFile(path.join(ctx.paths.runsDir, `authoring-${record.started_at.replace(/[:.]/g, "-")}.json`), JSON.stringify(record, null, 2));

  return { file, scenario, registered_account: registeredAccount, llm_calls: llmCalls, tokens, model: llm.model, provider: llm.provider, est_cost_usd: cost };
}
