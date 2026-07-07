import { describe, expect, it, vi } from "vitest";
import { parseLlmChain, resolveConfig } from "../config";
import { createLanguageModel, isFallbackable, normalizeBaseUrl } from "../llm-client";

const openAiState = vi.hoisted(() => ({
  configs: [] as Array<{ baseURL?: string }>
}));

vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: (config: { baseURL?: string }) => {
    openAiState.configs.push(config);
    return (model: string) => ({ model, config });
  }
}));

vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: () => (model: string) => ({ model })
}));

describe("isFallbackable", () => {
  it("does not fall back on auth failures", () => {
    expect(isFallbackable({ status: 401 })).toBe(false);
    expect(isFallbackable({ response: { status: 403 } })).toBe(false);
  });

  it("falls back on transient status and network errors", () => {
    expect(isFallbackable({ statusCode: 429 })).toBe(true);
    expect(isFallbackable({ status: 503 })).toBe(true);
    expect(isFallbackable(new Error("connect ECONNREFUSED 127.0.0.1"))).toBe(true);
  });
});

describe("normalizeBaseUrl", () => {
  it("normalizes host and port values", () => {
    expect(normalizeBaseUrl("localhost:8000")).toBe("http://localhost:8000/v1");
  });

  it("removes trailing slashes", () => {
    expect(normalizeBaseUrl("http://localhost:8000/")).toBe("http://localhost:8000/v1");
  });

  it("preserves existing v1 paths", () => {
    expect(normalizeBaseUrl("http://localhost:8000/v1")).toBe("http://localhost:8000/v1");
  });

  it("creates Ollama models with exactly one v1 path when base URL omits it", () => {
    openAiState.configs = [];
    createLanguageModel({ provider: "ollama", model: "llama3.3", baseUrl: "http://localhost:11434", keySource: "none" });
    expect(openAiState.configs.at(-1)?.baseURL).toBe("http://localhost:11434/v1");
  });

  it("creates Ollama models with exactly one v1 path when base URL includes it", () => {
    openAiState.configs = [];
    createLanguageModel({ provider: "ollama", model: "llama3.3", baseUrl: "http://localhost:11434/v1", keySource: "none" });
    expect(openAiState.configs.at(-1)?.baseURL).toBe("http://localhost:11434/v1");
  });
});

describe("parseLlmChain", () => {
  it("parses a valid chain string", () => {
    expect(parseLlmChain("gemini:gemini-2.5-flash,ollama:llama3.3")).toMatchObject([
      { provider: "gemini", model: "gemini-2.5-flash" },
      { provider: "ollama", model: "llama3.3" }
    ]);
  });

  it("supports per-role chain overrides through config resolution", () => {
    const config = resolveConfig({
      llmChain: "gemini:chat-default",
      chatLlmChain: "openrouter:chat-model",
      subagentLlmChain: "ollama:subagent-model"
    });
    expect(config.llm.roles.chat[0]).toMatchObject({ provider: "openrouter", model: "chat-model" });
    expect(config.llm.roles.subagent[0]).toMatchObject({ provider: "ollama", model: "subagent-model" });
    expect(config.llm.roles.scraper[0]).toMatchObject({ provider: "gemini", model: "chat-default" });
  });

  it("throws on invalid entries", () => {
    expect(() => parseLlmChain("not-a-provider:model")).toThrow(/Invalid LLM chain entry/);
    expect(() => parseLlmChain("gemini:")).toThrow(/Invalid LLM chain entry/);
  });

  it("rejects invalid country and currency codes", () => {
    expect(() => resolveConfig({ countryCode: "IN;ignore" })).toThrow(/Invalid countryCode/);
    expect(() => resolveConfig({ currency: "inr" })).toThrow(/Invalid currency/);
  });
});
