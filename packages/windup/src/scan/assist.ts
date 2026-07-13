import { readFile } from "node:fs/promises";
import { getContext } from "../context.js";

/**
 * LLM-assist do scan (SPEC-002, camada 3): a LLM lê arquivos que as camadas
 * estáticas não resolveram — rotas construídas dinamicamente, componentes
 * muito indiretos — e responde num schema fixo. Sempre com TETO explícito
 * (`scan.llmAssist.maxCalls`): scan nunca surpreende em custo.
 *
 * Resultados entram no grafo com `source: "llm"` — a MENOR precedência
 * (execution > static > llm): dica de baixa confiança, nunca sobrescreve
 * conhecimento melhor.
 */
export interface AssistCandidate {
  file: string;
  reason: "router-no-routes" | "page-dir-uncovered" | "route-no-elements";
}

export interface AssistPage {
  path: string;
  elements: string[];
  file: string;
}

export interface AssistOutcome {
  pages: AssistPage[];
  calls: number;
  tokens: { input: number; output: number };
  model: string;
  provider: string;
  candidates_skipped: number;
}

const ROUTER_PATTERN = /react-router|<Route[\s>]|createBrowserRouter|createHashRouter|useRoutes|createRoutesFromElements/;
const PAGE_DIR = /\/(pages|views|screens|routes)\//;

/**
 * Seleção heurística (sem LLM) dos arquivos que valem uma chamada, em ordem
 * de probabilidade. Exportada para teste.
 */
export function selectCandidates(
  files: Array<{ file: string; content: string }>,
  coveredFiles: Set<string>,
  nodesWithoutElements: Set<string>,
): AssistCandidate[] {
  const candidates: AssistCandidate[] = [];
  for (const { file, content } of files) {
    if (nodesWithoutElements.has(file)) {
      candidates.push({ file, reason: "route-no-elements" });
    } else if (ROUTER_PATTERN.test(content) && !coveredFiles.has(file)) {
      candidates.push({ file, reason: "router-no-routes" });
    } else if (PAGE_DIR.test(file) && !coveredFiles.has(file)) {
      candidates.push({ file, reason: "page-dir-uncovered" });
    }
  }
  const rank = { "router-no-routes": 0, "route-no-elements": 1, "page-dir-uncovered": 2 } as const;
  return candidates.sort((a, b) => rank[a.reason] - rank[b.reason]);
}

const ASSIST_SCHEMA = {
  type: "object",
  required: ["routes"],
  properties: {
    routes: {
      type: "array",
      items: {
        type: "object",
        required: ["path"],
        properties: {
          path: { type: "string" },
          elements: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

function assistPrompt(file: string, source: string): string {
  return `Você analisa código-fonte de frontends para mapear páginas de um app web.

Analise o arquivo abaixo e responda:
1. "routes": as rotas URL que este arquivo define ou constrói (inclusive dinamicamente — \
arrays mapeados, concatenação). Use o formato de path URL ("/pedidos/:id"). Se o arquivo \
não define rotas, devolva lista vazia.
2. Para cada rota, "elements": os elementos interativos que a página renderiza, no formato \
"tag id=... name=... data-test=... type=... text=..." (só campos existentes; um por linha \
do array). Prefira ids e data-test estáveis.

NÃO invente: só relate o que o código evidencia.

# Arquivo: ${file}
${source}`;
}

/** Assinatura injetável para testes (o caller real usa a fronteira LLM multi-provider). */
export type AssistCaller = (prompt: string) => Promise<{ text: string; tokens: { input: number; output: number } }>;

const MAX_FILE_CHARS = 24_000;

export async function runAssist(candidates: AssistCandidate[], caller?: AssistCaller): Promise<AssistOutcome> {
  const config = getContext().config;
  const maxCalls = config.scan?.llmAssist?.maxCalls ?? 20;

  // Mesma fronteira do planejador: o assist respeita --llm/WINDUP_LLM e a
  // seção llm.providers da config.
  let call = caller;
  let model = config.llm.model;
  let provider: string = config.llm.provider;
  if (!call) {
    const { createLlmClient } = await import("../llm.js");
    const client = createLlmClient();
    model = client.model;
    provider = client.provider;
    call = (prompt: string) =>
      client.generate({ prompt, schema: ASSIST_SCHEMA, maxOutputTokens: 4096, temperature: 0.3 });
  }

  const outcome: AssistOutcome = {
    pages: [],
    calls: 0,
    tokens: { input: 0, output: 0 },
    model,
    provider,
    candidates_skipped: Math.max(0, candidates.length - maxCalls),
  };

  for (const candidate of candidates.slice(0, maxCalls)) {
    let source: string;
    try {
      source = (await readFile(candidate.file, "utf8")).slice(0, MAX_FILE_CHARS);
    } catch {
      continue;
    }
    try {
      const result = await call(assistPrompt(candidate.file, source));
      outcome.calls += 1;
      outcome.tokens.input += result.tokens.input;
      outcome.tokens.output += result.tokens.output;
      const parsed = JSON.parse(result.text) as { routes?: Array<{ path?: string; elements?: string[] }> };
      for (const route of parsed.routes ?? []) {
        if (!route.path || !route.path.startsWith("/")) continue;
        const cleanPath = route.path.split(/[?#]/)[0].replace(/\/+$/, "") || "/";
        outcome.pages.push({ path: cleanPath, elements: route.elements ?? [], file: candidate.file });
      }
    } catch (err) {
      console.warn(`scan assist: skipping ${candidate.file}: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (outcome.candidates_skipped > 0) {
    console.log(`scan assist: ${outcome.candidates_skipped} candidate file(s) beyond the ${maxCalls}-call cap were skipped (raise scan.llmAssist.maxCalls to cover them)`);
  }
  return outcome;
}
