import { getContext } from "./context.js";
import { WindupError } from "./errors.js";

/**
 * Multi-provider boundary with LLMs. Everything that talks to a model (planner,
 * scan assist) goes through an LlmClient — switching company/model means picking
 * another client, never touching the callers.
 *
 * Provider/model selection per run (precedence):
 *   1. WINDUP_LLM env — "provider", "provider:model" or "provider/model"
 *      (the CLI's --llm flag writes here);
 *   2. LLM_MODEL env (legacy) — model only, on the config's provider;
 *   3. config llm.provider + llm.model.
 * The default model of a provider chosen without ":model" comes from
 * config.llm.providers[provider].model, otherwise from the built-in default.
 */

export type ProviderName = "google" | "openai";

export interface LlmRequest {
  prompt: string;
  /** Relaxed JSON Schema: Google uses it as responseSchema; OpenAI gets it in the prompt + json mode. */
  schema?: object;
  maxOutputTokens: number;
  temperature: number;
  seed?: number;
}

export interface LlmResponse {
  text: string;
  tokens: { input: number; output: number };
  /** true = response cut by the token limit (degeneration/plan too large) — transient failure. */
  truncated: boolean;
}

export interface LlmClient {
  provider: ProviderName;
  model: string;
  generate(req: LlmRequest): Promise<LlmResponse>;
}

export const PROVIDER_DEFAULTS: Record<ProviderName, { model: string; apiKeyEnv: string }> = {
  google: { model: "gemini-3.1-flash-lite", apiKeyEnv: "GOOGLE_GENERATIVE_AI_API_KEY" },
  openai: { model: "gpt-5-mini", apiKeyEnv: "OPENAI_API_KEY" },
};

function isProvider(name: string): name is ProviderName {
  return name in PROVIDER_DEFAULTS;
}

function defaultModelFor(provider: ProviderName): string {
  return getContext().config.llm.providers?.[provider]?.model ?? PROVIDER_DEFAULTS[provider].model;
}

/** "openai", "openai:gpt-5-mini" or "openai/gpt-5-mini" → {provider, model}. Exported for testing. */
export function parseLlmSpec(spec: string): { provider: ProviderName; model: string } {
  const match = spec.match(/^([a-z0-9-]+)[:/](.+)$/);
  const providerName = (match ? match[1] : spec).toLowerCase();
  if (!isProvider(providerName)) {
    throw new WindupError(
      `unknown LLM provider "${providerName}" — supported: ${Object.keys(PROVIDER_DEFAULTS).join(", ")} (format: provider or provider:model, e.g. --llm openai:gpt-5-mini)`,
    );
  }
  return { provider: providerName, model: match ? match[2] : defaultModelFor(providerName) };
}

export function resolveLlm(): { provider: ProviderName; model: string } {
  const spec = process.env.WINDUP_LLM?.trim();
  if (spec) return parseLlmSpec(spec);
  const config = getContext().config.llm;
  const provider = isProvider(config.provider) ? config.provider : "google";
  // Legacy (pre-multi-provider): LLM_MODEL swapped only the model.
  const legacy = process.env.LLM_MODEL?.trim();
  if (legacy) return { provider, model: legacy.replace(/^google\//, "") };
  return { provider, model: config.model ?? defaultModelFor(provider) };
}

export function createLlmClient(): LlmClient {
  const { provider, model } = resolveLlm();
  const providerCfg = getContext().config.llm.providers?.[provider];
  const apiKeyEnv = providerCfg?.apiKeyEnv ?? PROVIDER_DEFAULTS[provider].apiKeyEnv;
  const apiKey = process.env[apiKeyEnv];
  if (!apiKey) {
    throw new WindupError(`${apiKeyEnv} is not set (required for planning with ${provider}; cached replays do not use the LLM)`);
  }
  if (provider === "openai") {
    return openaiClient(model, apiKey, providerCfg?.baseUrl ?? process.env.OPENAI_BASE_URL);
  }
  return googleClient(model, apiKey);
}

function googleClient(model: string, apiKey: string): LlmClient {
  let ai: import("@google/genai").GoogleGenAI | null = null;
  return {
    provider: "google",
    model,
    async generate(req) {
      if (!ai) {
        const { GoogleGenAI } = await import("@google/genai");
        ai = new GoogleGenAI({ apiKey });
      }
      const response = await ai.models.generateContent({
        model,
        contents: req.prompt,
        config: {
          ...(req.schema ? { responseMimeType: "application/json", responseSchema: req.schema } : {}),
          // Planning is transcribing a task into actions, not long reasoning:
          // thinking disabled cuts ~10x of latency and cost on flash.
          // The *pro* models do not accept budget 0 — they use the minimum (128).
          thinkingConfig: { thinkingBudget: model.includes("pro") ? 128 : 0 },
          maxOutputTokens: req.maxOutputTokens,
          temperature: req.temperature,
          ...(req.seed !== undefined ? { seed: req.seed } : {}),
        },
      });
      return {
        text: response.text ?? "",
        tokens: {
          input: response.usageMetadata?.promptTokenCount ?? 0,
          output: response.usageMetadata?.candidatesTokenCount ?? 0,
        },
        truncated: response.candidates?.[0]?.finishReason === "MAX_TOKENS",
      };
    },
  };
}

/**
 * OpenAI via REST (chat/completions) — no SDK: a fetch call does not pay for
 * a dependency tree. Configurable baseUrl covers any OpenAI-compatible
 * endpoint (Azure, proxies, local models).
 */
function openaiClient(model: string, apiKey: string, baseUrl?: string): LlmClient {
  const url = `${(baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "")}/chat/completions`;
  // Models with built-in reasoning do not accept temperature/seed; minimal
  // effort plays the same role as Gemini's thinkingBudget 0.
  const reasoningEffort = /^gpt-5/.test(model) ? "minimal" : /^o\d/.test(model) ? "low" : null;
  return {
    provider: "openai",
    model,
    async generate(req) {
      // json mode does not take a schema: it goes as an instruction in the prompt
      // (the local Ajv remains the authority, as with Google).
      const content = req.schema
        ? `${req.prompt}\n\nRespond ONLY with valid JSON matching this JSON Schema:\n${JSON.stringify(req.schema)}`
        : req.prompt;
      const body = {
        model,
        messages: [{ role: "user", content }],
        ...(req.schema ? { response_format: { type: "json_object" } } : {}),
        max_completion_tokens: req.maxOutputTokens,
        ...(reasoningEffort
          ? { reasoning_effort: reasoningEffort }
          : { temperature: req.temperature, ...(req.seed !== undefined ? { seed: req.seed } : {}) }),
      };
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) {
        const detail = (await response.text().catch(() => "")).slice(0, 500);
        throw new Error(`OpenAI API error ${response.status}: ${detail}`);
      }
      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      return {
        text: data.choices?.[0]?.message?.content ?? "",
        tokens: {
          input: data.usage?.prompt_tokens ?? 0,
          output: data.usage?.completion_tokens ?? 0,
        },
        truncated: data.choices?.[0]?.finish_reason === "length",
      };
    },
  };
}
