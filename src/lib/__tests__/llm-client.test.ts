import { afterEach, describe, expect, it, vi } from "vitest";
import { parseLlmChain, resolveConfig } from "../config";
import { createLanguageModel, isFallbackable, normalizeBaseUrl } from "../llm-client";
import { discoverModels } from "../model-discovery";

const openAiState = vi.hoisted(() => ({
  configs: [] as Array<{ baseURL?: string; apiKey?: string }>
}));

vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: (config: { baseURL?: string; apiKey?: string }) => {
    openAiState.configs.push(config);
    return (model: string) => ({ model, config });
  }
}));

vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: () => (model: string) => ({ model })
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

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

  it("respects non-root OpenAI-compatible proxy paths", () => {
    expect(normalizeBaseUrl("https://host/my-proxy")).toBe("https://host/my-proxy");
    expect(normalizeBaseUrl("https://host/api/v1")).toBe("https://host/api/v1");
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

describe("discoverModels", () => {
  it("uses provider-specific environment keys for OpenAI-compatible discovery", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "openrouter-key");
    vi.stubEnv("OPENAI_COMPATIBLE_API_KEY", "compatible-key");
    const fetchMock = vi.fn(async () => Response.json({ data: [] }));

    await discoverModels({ provider: "openai-compatible", model: "test", baseUrl: "https://llm.example/v1", keySource: "env" }, fetchMock);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://llm.example/v1/models",
      { headers: { Authorization: "Bearer compatible-key" } }
    );
  });

  it("uses OpenRouter's key only for OpenRouter discovery", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "openrouter-key");
    vi.stubEnv("OPENAI_COMPATIBLE_API_KEY", "compatible-key");
    const fetchMock = vi.fn(async () => Response.json({ data: [] }));

    await discoverModels({ provider: "openrouter", model: "test", keySource: "env" }, fetchMock);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/models",
      { headers: { Authorization: "Bearer openrouter-key" } }
    );
  });

  it("sends no Authorization header when keySource is none", async () => {
    vi.stubEnv("OPENAI_COMPATIBLE_API_KEY", "compatible-key");
    const fetchMock = vi.fn(async () => Response.json({ data: [] }));

    await discoverModels({ provider: "openai-compatible", model: "test", baseUrl: "https://llm.example/v1", keySource: "none" }, fetchMock);

    expect(fetchMock).toHaveBeenCalledWith("https://llm.example/v1/models", { headers: undefined });
  });
});
