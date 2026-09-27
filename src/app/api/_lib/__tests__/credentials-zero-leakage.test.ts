import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAppConfig, entryFromRequest, getCredentialAvailability, UnsafeConfigError } from "../credentials";
import { POST as chatRoute } from "../../chat/route";
import { POST as searchProbeRoute } from "../../search/probe/route";
import * as chatEngine from "@/lib/llm/chat-engine";
import { createLanguageModel, resolveApiKey } from "@/lib/llm/client";

describe("Server-side zero-leakage & SSRF protection in hosted-demo mode", () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, savedEnv);
    vi.restoreAllMocks();
  });

  it("strictly rejects custom/unauthorized LLM baseUrls in hosted-demo mode", () => {
    process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "hosted-demo";

    const maliciousUrls = [
      "http://127.0.0.1:8000",
      "https://127.0.0.1",
      "http://localhost:11434",
      "http://169.254.169.254/latest/meta-data",
      "https://10.0.0.1/v1",
      "https://192.168.1.10/v1",
      "https://attacker-llm-proxy.com/v1",
      "http://generativelanguage.googleapis.com", // unencrypted HTTP rejected
      "https://user:pass@openrouter.ai/api/v1" // basic auth embedded rejected
    ];

    for (const url of maliciousUrls) {
      const headers = new Headers();
      expect(() =>
        buildAppConfig(headers, {
          llmChain: [
            {
              provider: "openai-compatible",
              model: "gpt-4",
              baseUrl: url
            }
          ]
        })
      ).toThrow(UnsafeConfigError);
    }
  });

  it("permits standard official provider baseUrls in hosted-demo mode", () => {
    process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "hosted-demo";

    const validUrls = [
      "https://generativelanguage.googleapis.com",
      "https://openrouter.ai/api/v1",
      "https://api.openai.com/v1",
      "https://api.anthropic.com/v1",
      "https://api.groq.com/openai/v1",
      "https://api.deepseek.com/v1"
    ];

    for (const url of validUrls) {
      const headers = new Headers();
      const config = buildAppConfig(headers, {
        llmChain: [
          {
            provider: "openai-compatible",
            model: "model-name",
            baseUrl: url
          }
        ]
      });
      expect(config.llm.chain[0].baseUrl).toBeDefined();
      expect(config.llm.chain[0].baseUrl).toMatch(new RegExp(`^${url}`));
    }
  });

  it("hydrates BYOK keys from request headers into active request config in hosted-demo mode", () => {
    process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "hosted-demo";

    const headers = new Headers({
      "x-gemini-api-key": "AIzaSyEphemeralKeyActive99",
      "x-pcbuildsage-api-key-openrouter": "sk-or-v1-active-key"
    });

    const config = buildAppConfig(headers, {
      llmChain: [
        { provider: "gemini", model: "gemini-2.0-flash", keySource: "ui" },
        { provider: "openrouter", model: "anthropic/claude-3.5", keySource: "ui" }
      ]
    });

    expect(config.llm.chain[0].apiKey).toBe("AIzaSyEphemeralKeyActive99");
    expect(config.llm.chain[1].apiKey).toBe("sk-or-v1-active-key");
  });

  it("redacts API keys from stream errors and does not leak keys into response payloads", async () => {
    process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "hosted-demo";

    const secretKey = "AIzaSySecretLeakTestKey999";
    const headers = {
      "content-type": "application/json",
      "x-gemini-api-key": secretKey
    };

    // Simulate streamChat throwing an error that echoes the API key
    vi.spyOn(chatEngine, "streamChat").mockRejectedValue(
      new Error(`Provider Gemini authentication failed with API key ${secretKey}`)
    );

    const request = new Request("http://localhost/api/chat", {
      method: "POST",
      headers,
      body: JSON.stringify({
        messages: [{ role: "user", content: "hello" }],
        config: {
          llmChain: [{ provider: "gemini", model: "gemini-2.0-flash", keySource: "ui" }]
        }
      })
    });

    const response = await chatRoute(request);
    expect(response.status).toBe(500);

    const text = await response.text();
    expect(text).not.toContain(secretKey);
    expect(text).toContain("[REDACTED]");
  });

  it("rejects chat request with 400 when unauthorized baseUrl is passed in hosted-demo mode", async () => {
    process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "hosted-demo";

    const request = new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "hello" }],
        config: {
          llmChain: [
            {
              provider: "openai-compatible",
              model: "gpt-4",
              baseUrl: "http://169.254.169.254/latest/meta-data"
            }
          ]
        }
      })
    });

    const response = await chatRoute(request);
    expect(response.status).toBe(400);

    const text = await response.text();
    expect(text).toContain("invalid_request");
    expect(text).not.toContain("169.254.169.254"); // verifies rejection without reflection
  });

  it("correctly parses groq provider and reasoningEffort in request entry", () => {
    const headers = new Headers({
      "x-pcbuildsage-api-key-groq": "gsk_secret123"
    });
    const entry = entryFromRequest(
      {
        provider: "groq",
        model: "deepseek-r1-distill-llama-70b",
        reasoningEffort: "high",
        keySource: "ui"
      },
      headers
    );

    expect(entry.provider).toBe("groq");
    expect(entry.model).toBe("deepseek-r1-distill-llama-70b");
    expect(entry.reasoningEffort).toBe("high");
    expect(entry.apiKey).toBe("gsk_secret123");
  });

  it("reports all credential availability as false in hosted-demo mode despite server env keys", () => {
    process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "hosted-demo";
    process.env.GEMINI_API_KEY = "server-gemini-secret";
    process.env.BRAVE_API_KEY = "server-brave-secret";

    const availability = getCredentialAvailability(process.env);
    expect(Object.values(availability.llm).every((v) => v === false)).toBe(true);
    expect(Object.values(availability.search).every((v) => v === false)).toBe(true);
  });

  it("fails search probe without header/body keys in hosted-demo mode despite server env key", async () => {
    process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "hosted-demo";
    process.env.BRAVE_API_KEY = "server-brave-secret";

    const request = new Request("http://localhost/api/search/probe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "brave" })
    });

    const response = await searchProbeRoute(request);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.ok).toBe(false);
    expect(data.error).toBe("brave search API key is required.");
  });

  it("never falls back to server env keys for LLM or search in hosted-demo mode", () => {
    process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "hosted-demo";
    process.env.GEMINI_API_KEY = "server-gemini-secret";
    process.env.BRAVE_API_KEY = "server-brave-secret";

    const headers = new Headers();
    const config = buildAppConfig(headers, {
      llmChain: [{ provider: "gemini", model: "gemini-2.0-flash", keySource: "env" }],
      searchProvider: "brave"
    });

    expect(config.llm.chain[0].apiKey).toBeUndefined();
    expect(config.search.apiKey).toBeUndefined();
    expect(resolveApiKey(config.llm.chain[0], "GEMINI_API_KEY")).toBeUndefined();
  });

  it("does not leak server GOOGLE_GENERATIVE_AI_API_KEY to Gemini model in hosted-demo mode", () => {
    process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "hosted-demo";
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "server-google-env-key";
    process.env.GEMINI_API_KEY = "server-gemini-env-key";

    const model = createLanguageModel({
      provider: "gemini",
      model: "gemini-2.5-flash",
      keySource: "env"
    }) as unknown as { config: { headers: () => Record<string, string> } };

    const headers = model.config.headers();
    expect(headers["x-goog-api-key"]).toBe("");
  });

  it("does not pass server env keys to streamChat in hosted-demo mode", async () => {
    process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "hosted-demo";
    process.env.GEMINI_API_KEY = "server-gemini-secret-12345";
    process.env.BRAVE_API_KEY = "server-brave-secret-67890";

    const streamSpy = vi.spyOn(chatEngine, "streamChat").mockResolvedValue({
      toUIMessageStreamResponse: () => new Response("ok")
    } as unknown as Awaited<ReturnType<typeof chatEngine.streamChat>>);

    const request = new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "hello" }],
        config: {
          llmChain: [{ provider: "gemini", model: "gemini-2.0-flash", keySource: "env" }],
          searchProvider: "brave"
        }
      })
    });

    const response = await chatRoute(request);
    expect(response.status).toBe(200);
    expect(streamSpy).toHaveBeenCalledTimes(1);
    const passedConfig = streamSpy.mock.calls[0][0];
    expect(passedConfig.llm.chain[0].apiKey).toBeUndefined();
    expect(passedConfig.search.apiKey).toBeUndefined();
  });
});
