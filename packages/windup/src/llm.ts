import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
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

export type ProviderName = "google" | "openai" | "claude-code";

export interface LlmRequest {
  prompt: string;
  /**
   * Relaxed JSON Schema: Google uses it as responseSchema; OpenAI gets it in
   * the prompt + json mode; claude-code gets it in the prompt only (the
   * wrapper has no JSON mode) and the reply is un-fenced mechanically.
   */
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

export const PROVIDER_DEFAULTS: Record<ProviderName, { model: string; apiKeyEnv: string; apiKeyOptional?: boolean }> = {
  google: { model: "gemini-3.1-flash-lite", apiKeyEnv: "GOOGLE_GENERATIVE_AI_API_KEY" },
  openai: { model: "gpt-5-mini", apiKeyEnv: "OPENAI_API_KEY" },
  // Default path is the native `claude` CLI (no server, no key). The key is
  // only for the optional HTTP wrapper, whose own auth is off by default — so
  // it is always optional here. See claudeCliClient / claudeCodeClient.
  "claude-code": { model: "claude-sonnet-4-6", apiKeyEnv: "CLAUDE_CODE_API_KEY", apiKeyOptional: true },
};

/** Providers billed by a subscription the developer already pays for — never per token. */
export const SUBSCRIPTION_PROVIDERS = new Set<ProviderName>(["claude-code"]);

/** Default endpoint of a locally-run claude-code-openai-wrapper. */
const CLAUDE_CODE_DEFAULT_URL = "http://localhost:8000/v1";

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
  if (!apiKey && !PROVIDER_DEFAULTS[provider].apiKeyOptional) {
    throw new WindupError(`${apiKeyEnv} is not set (required for planning with ${provider}; cached replays do not use the LLM)`);
  }
  if (provider === "claude-code") {
    // Two ways to reach a Claude subscription, chosen automatically:
    //   - baseUrl / WINDUP_CLAUDE_CODE_URL set → the (opt-in) HTTP wrapper;
    //   - nothing set → the native `claude` CLI, spawned locally (zero setup).
    const wrapperUrl = providerCfg?.baseUrl ?? process.env.WINDUP_CLAUDE_CODE_URL;
    return wrapperUrl ? claudeCodeClient(model, apiKey, wrapperUrl) : claudeCliClient(model);
  }
  if (provider === "openai") {
    return openaiClient(model, apiKey!, providerCfg?.baseUrl ?? process.env.OPENAI_BASE_URL);
  }
  return googleClient(model, apiKey!);
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

/**
 * A model with no JSON mode answers with the JSON wrapped in a ```json fence
 * or a sentence ("Here is the plan: {...}"). Unwrap it mechanically — a prompt
 * rule is not enough (the same lesson the planner learned with fragment
 * echoes: code has the final word). Returns the text unchanged when nothing
 * looks like JSON; Ajv remains the authority on whether it is a valid plan.
 * Exported for testing.
 */
export function extractJson(text: string): string {
  const trimmed = text.trim();
  // A fenced block wins: models put prose around it, never inside it.
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  if (candidate.startsWith("{") || candidate.startsWith("[")) return candidate;
  // Bare object buried in prose: take the outermost {...}.
  const first = candidate.indexOf("{");
  const last = candidate.lastIndexOf("}");
  return first !== -1 && last > first ? candidate.slice(first, last + 1) : candidate;
}

/**
 * Claude Code CLI (native) — the DEFAULT path for `--llm claude-code`, and the
 * zero-setup one. The developer already has the `claude` CLI installed and
 * logged into their Claude subscription; Windup spawns it in non-interactive
 * print mode (`claude -p ... --output-format json`) and reads the plan from
 * stdout. No wrapper, no Python, no local server.
 *
 * Run from a neutral temp cwd so Claude Code loads no project CLAUDE.md/context;
 * in headless default permission mode it cannot perform side-effecting tool
 * calls (no approver present → any tool needing permission is denied). Same
 * contract as every client: the schema rides in the prompt (there is no JSON
 * mode), the reply is un-fenced by extractJson(), tokens are real, and the
 * DOLLARS are $0 by design (SUBSCRIPTION_PROVIDERS). `temperature`/`seed` have
 * no CLI equivalent and are not sent (harmless — seed jitter is a flash quirk).
 */
function claudeCliClient(model: string): LlmClient {
  return {
    provider: "claude-code",
    model,
    generate(req) {
      const content = req.schema
        ? `${req.prompt}\n\nRespond ONLY with valid JSON matching this JSON Schema. No prose, no markdown fences:\n${JSON.stringify(req.schema)}`
        : req.prompt;
      return new Promise<LlmResponse>((resolve, reject) => {
        const child = spawn("claude", ["-p", content, "--output-format", "json", "--model", model], {
          cwd: tmpdir(),
          // The CLI spawns the agent loop; give it the same 5 min the wrapper gets.
          timeout: 300_000,
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => (stdout += d));
        child.stderr.on("data", (d) => (stderr += d));
        child.on("error", (err) => reject(claudeCliError(err)));
        child.on("close", (code, signal) => {
          if (signal === "SIGTERM") {
            reject(new WindupError(`the claude CLI timed out after 300s planning with ${model}`));
            return;
          }
          if (code !== 0) {
            reject(new WindupError(`the claude CLI exited with code ${code}${stderr ? `: ${stderr.trim().slice(0, 400)}` : ""}`));
            return;
          }
          let env: { result?: string; is_error?: boolean; subtype?: string; stop_reason?: string; usage?: { input_tokens?: number; output_tokens?: number } };
          try {
            env = JSON.parse(stdout);
          } catch {
            reject(new Error(`the claude CLI returned non-JSON output: ${stdout.slice(0, 300)}`));
            return;
          }
          if (env.is_error) {
            reject(new WindupError(`the claude CLI reported an error (${env.subtype ?? "unknown"}): ${(env.result ?? "").slice(0, 400)}`));
            return;
          }
          const raw = env.result ?? "";
          resolve({
            text: req.schema ? extractJson(raw) : raw,
            tokens: { input: env.usage?.input_tokens ?? 0, output: env.usage?.output_tokens ?? 0 },
            truncated: env.stop_reason === "max_tokens",
          });
        });
      });
    },
  };
}

/** A spawn failure turned into an actionable message (the #1 case: CLI not installed / not on PATH). */
function claudeCliError(err: unknown): WindupError {
  const msg = err instanceof Error ? err.message : String(err);
  if (/ENOENT/.test(msg)) {
    return new WindupError(
      `the "claude" CLI was not found on PATH. Install it (npm i -g @anthropic-ai/claude-code) and log in ` +
        `(run "claude", then /login with your Claude plan), or run the claude-code-openai-wrapper and point ` +
        `providers["claude-code"].baseUrl / WINDUP_CLAUDE_CODE_URL at it instead.`,
    );
  }
  return new WindupError(`could not run the claude CLI: ${msg}`);
}

/**
 * Claude Code wrapper (claude-code-openai-wrapper) — the OPT-IN alternative to
 * the native CLI above, used only when a `baseUrl` / WINDUP_CLAUDE_CODE_URL
 * points at it. A THIRD-PARTY, locally run OpenAI-compatible proxy in front of
 * the developer's own Claude Code session. Never a default: it is not a hosted
 * API, and it is not operated by us or by Anthropic.
 *
 * It implements only model/messages/stream. `response_format`, `temperature`,
 * `seed` and `max_tokens` are dropped on the floor, so this client does not
 * send them — pretending to set a control we do not have would be a lie in the
 * request. Two consequences the callers must live with:
 *   - no JSON mode: the schema rides in the prompt and the reply is un-fenced
 *     by extractJson(), so `text` keeps the LlmClient contract (parseable);
 *   - no seed jitter: the planner's transient re-calls cannot vary the seed
 *     (harmless — token-loop degeneration is a flash-family pathology).
 * Tokens are real and land in the ledger; the DOLLARS are zero by design
 * (metrics.ts: SUBSCRIPTION_PROVIDERS).
 */
function claudeCodeClient(model: string, apiKey: string | undefined, baseUrl?: string): LlmClient {
  const root = (baseUrl ?? process.env.WINDUP_CLAUDE_CODE_URL ?? CLAUDE_CODE_DEFAULT_URL).replace(/\/$/, "");
  const url = `${root}/chat/completions`;
  return {
    provider: "claude-code",
    model,
    async generate(req) {
      const content = req.schema
        ? `${req.prompt}\n\nRespond ONLY with valid JSON matching this JSON Schema. No prose, no markdown fences:\n${JSON.stringify(req.schema)}`
        : req.prompt;
      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
          body: JSON.stringify({ model, messages: [{ role: "user", content }], stream: false }),
          // The wrapper drives the Claude Code CLI (process spawn + agent
          // loop), so it is slower to first byte than a hosted API.
          signal: AbortSignal.timeout(300_000),
        });
      } catch (err) {
        // A local server that is down is not a transient blip: fail now with
        // something actionable instead of letting the planner burn 3 retries
        // with backoff to arrive at "fetch failed".
        throw new WindupError(
          `could not reach the Claude Code wrapper at ${root} (${err instanceof Error ? err.message : err}). ` +
            `Start it first (it is a separate, third-party server), or pick another provider with --llm google|openai`,
        );
      }
      if (!response.ok) {
        const detail = (await response.text().catch(() => "")).slice(0, 500);
        throw new Error(`Claude Code wrapper error ${response.status}: ${detail}`);
      }
      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const raw = data.choices?.[0]?.message?.content ?? "";
      return {
        // Only un-fence when a schema was asked for: --summary/--suggest want
        // prose, and digging a "{" out of prose would mangle it.
        text: req.schema ? extractJson(raw) : raw,
        tokens: {
          input: data.usage?.prompt_tokens ?? 0,
          output: data.usage?.completion_tokens ?? 0,
        },
        truncated: data.choices?.[0]?.finish_reason === "length",
      };
    },
  };
}
