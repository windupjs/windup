import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createLlmClient, extractJson, parseLlmSpec, resolveLlm, PROVIDER_DEFAULTS } from "../src/llm.js";
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
  delete process.env.CLAUDE_CODE_API_KEY;
  delete process.env.WINDUP_CLAUDE_CODE_URL;
  vi.unstubAllGlobals();
});

describe("provider/model selection (multi-provider)", () => {
  it("parseLlmSpec: bare provider uses the provider's default model", () => {
    withConfig({ provider: "google", model: "gemini-3.1-flash-lite" });
    expect(parseLlmSpec("openai")).toEqual({ provider: "openai", model: PROVIDER_DEFAULTS.openai.model });
  });

  it("parseLlmSpec: provider:model and provider/model", () => {
    withConfig(DEFAULT_CONFIG.llm);
    expect(parseLlmSpec("openai:gpt-5-nano")).toEqual({ provider: "openai", model: "gpt-5-nano" });
    expect(parseLlmSpec("google/gemini-3.5-flash")).toEqual({ provider: "google", model: "gemini-3.5-flash" });
  });

  it("parseLlmSpec: provider without a model respects the config default (llm.providers)", () => {
    withConfig({ provider: "google", model: "gemini-3.1-flash-lite", providers: { openai: { model: "gpt-4.1-mini" } } });
    expect(parseLlmSpec("openai")).toEqual({ provider: "openai", model: "gpt-4.1-mini" });
  });

  it("parseLlmSpec: unknown provider is a clear error", () => {
    withConfig(DEFAULT_CONFIG.llm);
    expect(() => parseLlmSpec("anthropic:claude")).toThrow(/unknown LLM provider/);
  });

  it("resolveLlm: WINDUP_LLM (--llm flag) takes precedence over the config", () => {
    withConfig({ provider: "google", model: "gemini-3.1-flash-lite" });
    process.env.WINDUP_LLM = "openai:gpt-5-mini";
    expect(resolveLlm()).toEqual({ provider: "openai", model: "gpt-5-mini" });
  });

  it("resolveLlm: legacy LLM_MODEL swaps only the model within the config's provider", () => {
    withConfig({ provider: "google", model: "gemini-3.1-flash-lite" });
    process.env.LLM_MODEL = "gemini-3.5-flash";
    expect(resolveLlm()).toEqual({ provider: "google", model: "gemini-3.5-flash" });
  });

  it("resolveLlm: without overrides uses the config", () => {
    withConfig({ provider: "openai", model: "gpt-5-mini" });
    expect(resolveLlm()).toEqual({ provider: "openai", model: "gpt-5-mini" });
  });

  it("createLlmClient: missing API key for the selected provider is an error naming the env var", () => {
    withConfig(DEFAULT_CONFIG.llm);
    process.env.WINDUP_LLM = "openai";
    expect(() => createLlmClient()).toThrow(/OPENAI_API_KEY/);
  });
});

describe("OpenAI client (REST)", () => {
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

  it("reasoning model (gpt-5*): reasoning_effort minimal, no temperature/seed; schema becomes json mode + instruction", async () => {
    withConfig(DEFAULT_CONFIG.llm);
    process.env.WINDUP_LLM = "openai:gpt-5-mini";
    process.env.OPENAI_API_KEY = "test-key";
    const mock = stubFetch(RESPONSE);

    const client = createLlmClient();
    const result = await client.generate({ prompt: "plan", schema: { type: "object" }, maxOutputTokens: 8192, temperature: 0.3, seed: 11 });

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

  it("classic model (gpt-4o-mini): temperature and seed go in the call", async () => {
    withConfig(DEFAULT_CONFIG.llm);
    process.env.WINDUP_LLM = "openai:gpt-4o-mini";
    process.env.OPENAI_API_KEY = "test-key";
    const mock = stubFetch(RESPONSE);

    await createLlmClient().generate({ prompt: "plan", maxOutputTokens: 4096, temperature: 0.3, seed: 7 });
    const body = JSON.parse((mock.mock.calls[0] as unknown as [string, { body: string }])[1].body);
    expect(body.temperature).toBe(0.3);
    expect(body.seed).toBe(7);
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.response_format).toBeUndefined();
  });

  it("finish_reason length → truncated (planner's transient retry)", async () => {
    withConfig(DEFAULT_CONFIG.llm);
    process.env.WINDUP_LLM = "openai:gpt-5-mini";
    process.env.OPENAI_API_KEY = "test-key";
    stubFetch({ choices: [{ message: { content: "{" }, finish_reason: "length" }], usage: { prompt_tokens: 1, completion_tokens: 8192 } });

    const result = await createLlmClient().generate({ prompt: "p", maxOutputTokens: 10, temperature: 0.3 });
    expect(result.truncated).toBe(true);
  });

  it("baseUrl from the config (OpenAI-compatible endpoint) is respected", async () => {
    withConfig({ provider: "google", model: "gemini-3.1-flash-lite", providers: { openai: { model: "gpt-5-mini", baseUrl: "http://localhost:11434/v1/" } } });
    process.env.WINDUP_LLM = "openai";
    process.env.OPENAI_API_KEY = "test-key";
    const mock = stubFetch(RESPONSE);

    await createLlmClient().generate({ prompt: "p", maxOutputTokens: 10, temperature: 0.3 });
    expect((mock.mock.calls[0] as unknown as [string])[0]).toBe("http://localhost:11434/v1/chat/completions");
  });
});

describe("extractJson (no JSON mode → un-fence mechanically)", () => {
  it("pulls the plan out of a ```json fence", () => {
    expect(extractJson('```json\n{"plan_version":"0.1"}\n```')).toBe('{"plan_version":"0.1"}');
  });

  it("pulls it out of an unlabelled fence, and out of surrounding prose", () => {
    expect(extractJson('Here is the plan:\n```\n{"a":1}\n```\nHope it helps!')).toBe('{"a":1}');
    expect(extractJson('Sure! {"a":1} — let me know.')).toBe('{"a":1}');
  });

  it("leaves already-bare JSON untouched (objects and arrays)", () => {
    expect(extractJson('{"a":1}')).toBe('{"a":1}');
    expect(extractJson('  [{"a":1}]  ')).toBe('[{"a":1}]');
  });

  it("keeps nested braces: takes the OUTERMOST object, not the first close", () => {
    expect(extractJson('text {"a":{"b":2}} tail')).toBe('{"a":{"b":2}}');
  });

  it("text with no JSON passes through — Ajv stays the authority on validity", () => {
    expect(extractJson("the model refused")).toBe("the model refused");
  });
});

describe("claude-code client (third-party local wrapper)", () => {
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

  const FENCED = {
    choices: [{ message: { content: '```json\n{"ok":true}\n```' }, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 20 },
  };

  it("parseLlmSpec: claude-code resolves to the wrapper's default model", () => {
    withConfig(DEFAULT_CONFIG.llm);
    expect(parseLlmSpec("claude-code")).toEqual({ provider: "claude-code", model: PROVIDER_DEFAULTS["claude-code"].model });
    expect(parseLlmSpec("claude-code:claude-opus-4-6")).toEqual({ provider: "claude-code", model: "claude-opus-4-6" });
  });

  it("needs NO api key (the wrapper's own auth is opt-in), unlike the hosted providers", async () => {
    withConfig(DEFAULT_CONFIG.llm);
    process.env.WINDUP_LLM = "claude-code";
    const mock = stubFetch(FENCED);

    const client = createLlmClient(); // must not throw
    await client.generate({ prompt: "plan", schema: { type: "object" }, maxOutputTokens: 8192, temperature: 0.3, seed: 11 });
    const [, init] = mock.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(init.headers.authorization).toBeUndefined();
  });

  it("sends an api key when one IS set", async () => {
    withConfig(DEFAULT_CONFIG.llm);
    process.env.WINDUP_LLM = "claude-code";
    process.env.CLAUDE_CODE_API_KEY = "wrapper-token";
    const mock = stubFetch(FENCED);

    await createLlmClient().generate({ prompt: "p", maxOutputTokens: 10, temperature: 0.3 });
    const [, init] = mock.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(init.headers.authorization).toBe("Bearer wrapper-token");
  });

  it("sends ONLY what the wrapper implements — no response_format/temperature/seed/max_tokens", async () => {
    withConfig(DEFAULT_CONFIG.llm);
    process.env.WINDUP_LLM = "claude-code";
    const mock = stubFetch(FENCED);

    await createLlmClient().generate({ prompt: "plan", schema: { type: "object" }, maxOutputTokens: 8192, temperature: 0.3, seed: 11 });
    const [url, init] = mock.mock.calls[0] as unknown as [string, { body: string }];
    expect(url).toBe("http://localhost:8000/v1/chat/completions");
    const body = JSON.parse(init.body);
    expect(body.model).toBe("claude-sonnet-4-6");
    expect(body.stream).toBe(false);
    expect(body.response_format).toBeUndefined();
    expect(body.temperature).toBeUndefined();
    expect(body.seed).toBeUndefined();
    expect(body.max_tokens).toBeUndefined();
    expect(body.max_completion_tokens).toBeUndefined();
    // The schema has nowhere to go but the prompt.
    expect(body.messages[0].content).toContain("JSON Schema");
  });

  it("with a schema: the fenced reply is un-fenced, tokens survive", async () => {
    withConfig(DEFAULT_CONFIG.llm);
    process.env.WINDUP_LLM = "claude-code";
    stubFetch(FENCED);

    const result = await createLlmClient().generate({ prompt: "p", schema: { type: "object" }, maxOutputTokens: 10, temperature: 0.3 });
    expect(result).toEqual({ text: '{"ok":true}', tokens: { input: 100, output: 20 }, truncated: false });
  });

  it("WITHOUT a schema: prose passes through untouched (--summary/--suggest)", async () => {
    withConfig(DEFAULT_CONFIG.llm);
    process.env.WINDUP_LLM = "claude-code";
    stubFetch({
      choices: [{ message: { content: "The test logged in and reached {the dashboard}." }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });

    const result = await createLlmClient().generate({ prompt: "p", maxOutputTokens: 10, temperature: 0.3 });
    expect(result.text).toBe("The test logged in and reached {the dashboard}.");
  });

  it("baseUrl from the config points at a wrapper on another port", async () => {
    withConfig({ provider: "google", model: "gemini-3.1-flash-lite", providers: { "claude-code": { baseUrl: "http://127.0.0.1:9000/v1/" } } });
    process.env.WINDUP_LLM = "claude-code";
    const mock = stubFetch(FENCED);

    await createLlmClient().generate({ prompt: "p", maxOutputTokens: 10, temperature: 0.3 });
    expect((mock.mock.calls[0] as unknown as [string])[0]).toBe("http://127.0.0.1:9000/v1/chat/completions");
  });

  it("wrapper not running → actionable error, NOT a transient retry loop", async () => {
    withConfig(DEFAULT_CONFIG.llm);
    process.env.WINDUP_LLM = "claude-code";
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("fetch failed"); }));

    await expect(createLlmClient().generate({ prompt: "p", maxOutputTokens: 10, temperature: 0.3 }))
      .rejects.toThrow(/could not reach the Claude Code wrapper at http:\/\/localhost:8000\/v1/);
  });
});
