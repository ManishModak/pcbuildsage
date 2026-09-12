import { afterEach, describe, expect, it, vi } from "vitest";
import { parseLlmChain, resolveConfig } from "../config";
import { createLanguageModel, isFallbackable, normalizeBaseUrl, sanitizeOpenAICompatibleRequestBody } from "@/lib/llm/client";
import { discoverModels } from "@/lib/llm/discovery";

const openAiState = vi.hoisted(() => ({
  configs: [] as Array<{
    name?: string;
    baseURL?: string;
    apiKey?: string;
    transformRequestBody?: (args: Record<string, unknown>) => Record<string, unknown>;
  }>
}));

vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: (config: any) => {
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
    expect(isFallbackable(new Error("Rate limit exceeded: free-models-per-day"))).toBe(true);
    expect(isFallbackable(new Error("Quota exceeded for this period"))).toBe(true);
    expect(isFallbackable(new Error("Too many requests"))).toBe(true);
    expect(isFallbackable(new Error("API returned 502 Bad Gateway"))).toBe(true);
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

  it("uses Groq's key and default endpoint for Groq model discovery", async () => {
    vi.stubEnv("GROQ_API_KEY", "gsk_test_groq_key");
    const fetchMock = vi.fn(async () =>
      Response.json({
        data: [
          { id: "llama-3.3-70b-versatile", name: "Llama 3.3 70B" },
          { id: "llama-3.1-8b-instant" }
        ]
      })
    );

    const models = await discoverModels({ provider: "groq", model: "test", keySource: "env" }, fetchMock);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.groq.com/openai/v1/models",
      { headers: { Authorization: "Bearer gsk_test_groq_key" } }
    );
    expect(models).toEqual([
      { id: "llama-3.3-70b-versatile", name: "Llama 3.3 70B" },
      { id: "llama-3.1-8b-instant", name: "llama-3.1-8b-instant" }
    ]);
  });
});

describe("sanitizeOpenAICompatibleRequestBody", () => {
  it("strips reasoning_content and reasoning from assistant messages in multi-turn payloads", () => {
    const rawBody = {
      model: "qwen/qwen3.8-27b",
      messages: [
        { role: "system", content: "You are PCBuildSage." },
        { role: "user", content: "Best 1440p gaming build around ₹90,000" },
        {
          role: "assistant",
          content: "Good brief — a 1440p gaming build around ₹90k.",
          reasoning_content: "The user is asking for a 1440p gaming build around ₹90,000.",
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "get_catalog", arguments: "{}" } }
          ]
        },
        { role: "tool", tool_call_id: "call_1", content: "{}" }
      ]
    };

    const sanitized = sanitizeOpenAICompatibleRequestBody(rawBody, "groq");

    expect(sanitized.messages).toHaveLength(4);
    const assistantMsg = (sanitized.messages as Array<Record<string, unknown>>)[2];
    expect(assistantMsg.role).toBe("assistant");
    expect(assistantMsg.content).toBe("Good brief — a 1440p gaming build around ₹90k.");
    expect(assistantMsg.tool_calls).toBeDefined();
    expect(assistantMsg).not.toHaveProperty("reasoning_content");
    expect(assistantMsg).not.toHaveProperty("reasoning");

    // Non-assistant messages must be untouched
    expect((sanitized.messages as Array<Record<string, unknown>>)[0]).toEqual(rawBody.messages[0]);
    expect((sanitized.messages as Array<Record<string, unknown>>)[1]).toEqual(rawBody.messages[1]);
    expect((sanitized.messages as Array<Record<string, unknown>>)[3]).toEqual(rawBody.messages[3]);
  });

  it("strips reasoning_effort when provider is groq or endpoint is groq.com", () => {
    const rawBody = {
      model: "llama-3.3-70b-versatile",
      reasoning_effort: "high",
      messages: [{ role: "user", content: "hello" }]
    };

    const groqSanitized = sanitizeOpenAICompatibleRequestBody(rawBody, "groq");
    expect(groqSanitized).not.toHaveProperty("reasoning_effort");

    const groqUrlSanitized = sanitizeOpenAICompatibleRequestBody(rawBody, "openai-compatible", "https://api.groq.com/openai/v1");
    expect(groqUrlSanitized).not.toHaveProperty("reasoning_effort");

    const openRouterSanitized = sanitizeOpenAICompatibleRequestBody(rawBody, "openrouter", "https://openrouter.ai/api/v1");
    expect(openRouterSanitized).toHaveProperty("reasoning_effort", "high");
  });

  it("attaches transformRequestBody in createLanguageModel for OpenAI-compatible providers", () => {
    openAiState.configs = [];
    createLanguageModel({ provider: "groq", model: "llama-3.3-70b-versatile", keySource: "none" });

    const lastConfig = openAiState.configs.at(-1);
    expect(lastConfig).toBeDefined();
    expect(typeof lastConfig?.transformRequestBody).toBe("function");

    const transformed = lastConfig!.transformRequestBody!({
      messages: [
        { role: "assistant", content: "test", reasoning_content: "unsupported by groq" }
      ],
      reasoning_effort: "medium"
    });

    const msg = (transformed.messages as Array<Record<string, unknown>>)[0];
    expect(msg).not.toHaveProperty("reasoning_content");
    expect(transformed).not.toHaveProperty("reasoning_effort");
  });
});

