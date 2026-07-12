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

/** Assinatura injetável para testes (o caller real usa @google/genai). */
export type AssistCaller = (prompt: string) => Promise<{ text: string; tokens: { input: number; output: number } }>;

async function geminiCaller(model: string): Promise<AssistCaller> {
  const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!apiKey) {
    throw new Error("GOOGLE_GENERATIVE_AI_API_KEY is not set (required for scan LLM-assist; use --no-assist to skip)");
  }
  const { GoogleGenAI } = await import("@google/genai");
  const ai = new GoogleGenAI({ apiKey });
  return async (prompt: string) => {
    const response = await ai.models.generateContent({
      model,
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: ASSIST_SCHEMA,
        thinkingConfig: { thinkingBudget: model.includes("pro") ? 128 : 0 },
        maxOutputTokens: 4096,
        temperature: 0.3,
      },
    });
    return {
      text: response.text ?? "",
      tokens: {
        input: response.usageMetadata?.promptTokenCount ?? 0,
        output: response.usageMetadata?.candidatesTokenCount ?? 0,
      },
    };
  };
}

const MAX_FILE_CHARS = 24_000;

export async function runAssist(candidates: AssistCandidate[], caller?: AssistCaller): Promise<AssistOutcome> {
  const config = getContext().config;
  const maxCalls = config.scan?.llmAssist?.maxCalls ?? 20;
  const model = config.llm.model;
  const call = caller ?? (await geminiCaller(model));

  const outcome: AssistOutcome = {
    pages: [],
    calls: 0,
    tokens: { input: 0, output: 0 },
    model,
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
        outcome.pages.push({ path: route.path, elements: route.elements ?? [], file: candidate.file });
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
