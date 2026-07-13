import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createLlmClient, parseLlmSpec, resolveLlm, PROVIDER_DEFAULTS } from "../src/llm.js";
import { createContext, setContext } from "../src/context.js";
import { DEFAULT_CONFIG, type WindupConfig } from "../src/config.js";

function withConfig(llm: WindupConfig["llm"]): void {
  setContext(createContext(process.cwd(), { config: { ...DEFAULT_CONFIG, llm } }));
}

afterAll(() => setContext(createContext()));
afterEach(() => {
  delete process.env.WINDUP_LLM;
  delete process.env.LLM_MODEL;
  delete process.env.OPENAI_API_KEY;
  vi.unstubAllGlobals();
});

describe("seleção de provider/modelo (multi-provider)", () => {
  it("parseLlmSpec: provider puro usa o modelo default do provider", () => {
    withConfig({ provider: "google", model: "gemini-3.1-flash-lite" });
    expect(parseLlmSpec("openai")).toEqual({ provider: "openai", model: PROVIDER_DEFAULTS.openai.model });
  });

  it("parseLlmSpec: provider:model e provider/model", () => {
    withConfig(DEFAULT_CONFIG.llm);
    expect(parseLlmSpec("openai:gpt-5-nano")).toEqual({ provider: "openai", model: "gpt-5-nano" });
    expect(parseLlmSpec("google/gemini-3.5-flash")).toEqual({ provider: "google", model: "gemini-3.5-flash" });
  });

  it("parseLlmSpec: provider sem modelo respeita o default da config (llm.providers)", () => {
    withConfig({ provider: "google", model: "gemini-3.1-flash-lite", providers: { openai: { model: "gpt-4.1-mini" } } });
    expect(parseLlmSpec("openai")).toEqual({ provider: "openai", model: "gpt-4.1-mini" });
  });

  it("parseLlmSpec: provider desconhecido é erro claro", () => {
    withConfig(DEFAULT_CONFIG.llm);
    expect(() => parseLlmSpec("anthropic:claude")).toThrow(/unknown LLM provider/);
  });

  it("resolveLlm: WINDUP_LLM (flag --llm) tem precedência sobre a config", () => {
    withConfig({ provider: "google", model: "gemini-3.1-flash-lite" });
    process.env.WINDUP_LLM = "openai:gpt-5-mini";
    expect(resolveLlm()).toEqual({ provider: "openai", model: "gpt-5-mini" });
  });

  it("resolveLlm: LLM_MODEL legado troca só o modelo no provider da config", () => {
    withConfig({ provider: "google", model: "gemini-3.1-flash-lite" });
    process.env.LLM_MODEL = "gemini-3.5-flash";
    expect(resolveLlm()).toEqual({ provider: "google", model: "gemini-3.5-flash" });
  });

  it("resolveLlm: sem overrides usa a config", () => {
    withConfig({ provider: "openai", model: "gpt-5-mini" });
    expect(resolveLlm()).toEqual({ provider: "openai", model: "gpt-5-mini" });
  });

  it("createLlmClient: falta de API key do provider selecionado é erro com o nome da env", () => {
    withConfig(DEFAULT_CONFIG.llm);
    process.env.WINDUP_LLM = "openai";
    expect(() => createLlmClient()).toThrow(/OPENAI_API_KEY/);
  });
});

describe("client OpenAI (REST)", () => {
  function stubFetch(payload: unknown): ReturnType<typeof vi.fn> {
    const mock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    }));
    vi.stubGlobal("fetch", mock);
    return mock;
  }

  const RESPONSE = {
    choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 20 },
  };

  it("modelo com raciocínio (gpt-5*): reasoning_effort minimal, sem temperature/seed; schema vira json mode + instrução", async () => {
    withConfig(DEFAULT_CONFIG.llm);
    process.env.WINDUP_LLM = "openai:gpt-5-mini";
    process.env.OPENAI_API_KEY = "test-key";
    const mock = stubFetch(RESPONSE);

    const client = createLlmClient();
    const result = await client.generate({ prompt: "plano", schema: { type: "object" }, maxOutputTokens: 8192, temperature: 0.3, seed: 11 });

    expect(result).toEqual({ text: '{"ok":true}', tokens: { input: 100, output: 20 }, truncated: false });
    const [url, init] = mock.mock.calls[0] as unknown as [string, { body: string; headers: Record<string, string> }];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(init.headers.authorization).toBe("Bearer test-key");
    const body = JSON.parse(init.body);
    expect(body.model).toBe("gpt-5-mini");
    expect(body.reasoning_effort).toBe("minimal");
    expect(body.temperature).toBeUndefined();
    expect(body.seed).toBeUndefined();
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages[0].content).toContain("JSON Schema");
    expect(body.max_completion_tokens).toBe(8192);
  });

  it("modelo clássico (gpt-4o-mini): temperature e seed vão na chamada", async () => {
    withConfig(DEFAULT_CONFIG.llm);
    process.env.WINDUP_LLM = "openai:gpt-4o-mini";
    process.env.OPENAI_API_KEY = "test-key";
    const mock = stubFetch(RESPONSE);

    await createLlmClient().generate({ prompt: "plano", maxOutputTokens: 4096, temperature: 0.3, seed: 7 });
    const body = JSON.parse((mock.mock.calls[0] as unknown as [string, { body: string }])[1].body);
    expect(body.temperature).toBe(0.3);
    expect(body.seed).toBe(7);
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.response_format).toBeUndefined();
  });

  it("finish_reason length → truncated (retry transiente do planner)", async () => {
    withConfig(DEFAULT_CONFIG.llm);
    process.env.WINDUP_LLM = "openai:gpt-5-mini";
    process.env.OPENAI_API_KEY = "test-key";
    stubFetch({ choices: [{ message: { content: "{" }, finish_reason: "length" }], usage: { prompt_tokens: 1, completion_tokens: 8192 } });

    const result = await createLlmClient().generate({ prompt: "p", maxOutputTokens: 10, temperature: 0.3 });
    expect(result.truncated).toBe(true);
  });

  it("baseUrl da config (endpoint OpenAI-compatível) é respeitada", async () => {
    withConfig({ provider: "google", model: "gemini-3.1-flash-lite", providers: { openai: { model: "gpt-5-mini", baseUrl: "http://localhost:11434/v1/" } } });
    process.env.WINDUP_LLM = "openai";
    process.env.OPENAI_API_KEY = "test-key";
    const mock = stubFetch(RESPONSE);

    await createLlmClient().generate({ prompt: "p", maxOutputTokens: 10, temperature: 0.3 });
    expect((mock.mock.calls[0] as unknown as [string])[0]).toBe("http://localhost:11434/v1/chat/completions");
  });
});
