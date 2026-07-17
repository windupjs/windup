import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLlmClient, extractJson, parseLlmSpec, resolveLlm, PROVIDER_DEFAULTS } from "../src/llm.js";
import { createContext, setContext } from "../src/context.js";
import { DEFAULT_CONFIG, type WindupConfig } from "../src/config.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
import { spawn } from "node:child_process";

function withConfig(llm: WindupConfig["llm"]): void {
  setContext(createContext(process.cwd(), { config: { ...DEFAULT_CONFIG, llm } }));
}

/** A controllable fake `claude` child: emits stdout/stderr on next tick, then closes. */
function fakeChild(opts: { stdout?: string; stderr?: string; code?: number; signal?: string | null; spawnError?: Error }) {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  process.nextTick(() => {
    if (opts.spawnError) return void child.emit("error", opts.spawnError);
    if (opts.stdout) child.stdout.emit("data", Buffer.from(opts.stdout));
    if (opts.stderr) child.stderr.emit("data", Buffer.from(opts.stderr));
    child.emit("close", opts.code ?? 0, opts.signal ?? null);
  });
  return child;
}

afterAll(() => setContext(createContext()));
afterEach(() => {
  delete process.env.WINDUP_LLM;
  delete process.env.LLM_MODEL;
  delete process.env.OPENAI_API_KEY;
  delete process.env.CLAUDE_CODE_API_KEY;
  delete process.env.WINDUP_CLAUDE_CODE_URL;
  vi.mocked(spawn).mockReset();
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
  // Since 0.22.0 the wrapper is the OPT-IN path: it is used only when a URL is
  // configured. These tests opt in via the env var; the default (no URL) path
  // is the native CLI, covered in its own block below.
  beforeEach(() => {
    process.env.WINDUP_CLAUDE_CODE_URL = "http://localhost:8000/v1";
  });

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

describe("claude-code client (native CLI — the zero-setup default)", () => {
  const envelope = (over: Record<string, unknown> = {}) =>
    JSON.stringify({ result: '```json\n{"ok":true}\n```', is_error: false, subtype: "success", stop_reason: "end_turn", usage: { input_tokens: 12, output_tokens: 7 }, ...over });

  it("with NO wrapper URL, spawns `claude -p ... --output-format json --model <m>` from a neutral cwd", async () => {
    withConfig(DEFAULT_CONFIG.llm);
    process.env.WINDUP_LLM = "claude-code";
    vi.mocked(spawn).mockReturnValue(fakeChild({ stdout: envelope() }) as never);

    const result = await createLlmClient().generate({ prompt: "plan", schema: { type: "object" }, maxOutputTokens: 8192, temperature: 0.3, seed: 5 });
    // fenced reply un-fenced, real tokens; $-free is decided in metrics.ts, not here
    expect(result).toEqual({ text: '{"ok":true}', tokens: { input: 12, output: 7 }, truncated: false });

    const [cmd, args, opts] = vi.mocked(spawn).mock.calls[0] as unknown as [string, string[], { cwd: string }];
    expect(cmd).toBe("claude");
    expect(args).toEqual(["-p", expect.stringContaining("JSON Schema"), "--output-format", "json", "--model", "claude-sonnet-4-6"]);
    expect(opts.cwd).toBe(tmpdir());
  });

  it("routing: no URL → CLI (spawn), never the wrapper (fetch)", async () => {
    withConfig(DEFAULT_CONFIG.llm);
    process.env.WINDUP_LLM = "claude-code";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(spawn).mockReturnValue(fakeChild({ stdout: envelope() }) as never);

    await createLlmClient().generate({ prompt: "p", schema: { type: "object" }, maxOutputTokens: 10, temperature: 0.3 });
    expect(spawn).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a missing `claude` binary fails with an actionable install/login message", async () => {
    withConfig(DEFAULT_CONFIG.llm);
    process.env.WINDUP_LLM = "claude-code";
    vi.mocked(spawn).mockReturnValue(fakeChild({ spawnError: Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }) }) as never);

    await expect(createLlmClient().generate({ prompt: "p", schema: { type: "object" }, maxOutputTokens: 10, temperature: 0.3 })).rejects.toThrow(
      /@anthropic-ai\/claude-code/,
    );
  });

  it("is_error in the envelope surfaces as an actionable error, not a bogus plan", async () => {
    withConfig(DEFAULT_CONFIG.llm);
    process.env.WINDUP_LLM = "claude-code";
    vi.mocked(spawn).mockReturnValue(fakeChild({ stdout: JSON.stringify({ is_error: true, subtype: "error_during_execution", result: "not logged in" }) }) as never);

    await expect(createLlmClient().generate({ prompt: "p", schema: { type: "object" }, maxOutputTokens: 10, temperature: 0.3 })).rejects.toThrow(
      /claude CLI reported an error/,
    );
  });

  it("stop_reason max_tokens marks the response truncated (planner's transient retry)", async () => {
    withConfig(DEFAULT_CONFIG.llm);
    process.env.WINDUP_LLM = "claude-code";
    vi.mocked(spawn).mockReturnValue(fakeChild({ stdout: envelope({ result: "{", stop_reason: "max_tokens" }) }) as never);

    const result = await createLlmClient().generate({ prompt: "p", schema: { type: "object" }, maxOutputTokens: 10, temperature: 0.3 });
    expect(result.truncated).toBe(true);
  });

  it("WITHOUT a schema: prose passes through untouched (--summary/--suggest)", async () => {
    withConfig(DEFAULT_CONFIG.llm);
    process.env.WINDUP_LLM = "claude-code";
    vi.mocked(spawn).mockReturnValue(fakeChild({ stdout: envelope({ result: "Logged in and reached {the dashboard}." }) }) as never);

    const result = await createLlmClient().generate({ prompt: "p", maxOutputTokens: 10, temperature: 0.3 });
    expect(result.text).toBe("Logged in and reached {the dashboard}.");
  });
});
