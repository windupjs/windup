import { afterAll, afterEach, describe, expect, it } from "vitest";
import { resolveLlm } from "../src/llm.js";
import { createContext, setContext } from "../src/context.js";
import { DEFAULT_CONFIG, type WindupConfig } from "../src/config.js";

function withConfig(llm: WindupConfig["llm"]): void {
  setContext(createContext(process.cwd(), { config: { ...DEFAULT_CONFIG, llm } }));
}
afterAll(() => setContext(createContext()));
afterEach(() => { delete process.env.WINDUP_LLM; delete process.env.LLM_MODEL; });

describe("self-heal provider precedence (regression: bug report #1)", () => {
  it("the re-plan reuses the provider that originally planned the scenario, over the config default", () => {
    withConfig({ provider: "google", model: "gemini-3.1-flash-lite" });
    // no --llm/WINDUP_LLM this invocation; the cached plan was made by openai
    expect(resolveLlm("openai/gpt-4o-mini")).toEqual({ provider: "openai", model: "gpt-4o-mini" });
  });

  it("an explicit --llm (WINDUP_LLM) still wins over the recorded provider", () => {
    withConfig({ provider: "google", model: "gemini-3.1-flash-lite" });
    process.env.WINDUP_LLM = "openai:gpt-5-mini";
    expect(resolveLlm("google/gemini-3.1-flash-lite")).toEqual({ provider: "openai", model: "gpt-5-mini" });
  });

  it("without a preferred provider, falls back to the config default", () => {
    withConfig({ provider: "google", model: "gemini-3.1-flash-lite" });
    expect(resolveLlm()).toEqual({ provider: "google", model: "gemini-3.1-flash-lite" });
  });

  it("an unknown recorded provider is ignored (falls back to config)", () => {
    withConfig({ provider: "google", model: "gemini-3.1-flash-lite" });
    expect(resolveLlm("anthropic/claude")).toEqual({ provider: "google", model: "gemini-3.1-flash-lite" });
  });
});
