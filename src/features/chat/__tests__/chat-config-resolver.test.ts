import { describe, it, expect } from "vitest";
import { resolveActiveModel, resolveChatRequestBody, resolveChatRequestHeaders } from "../chat-config-resolver";
import { DEFAULT_CONFIG, saveUiKey } from "@/lib/client-config-store";

describe("resolveChatRequestBody", () => {
  it("resolves local configuration preserving base urls and crawl settings", () => {
    const config = {
      ...DEFAULT_CONFIG,
      chatChain: [
        { id: "c1", provider: "ollama" as const, model: "llama3", keySource: "env" as const, baseUrl: "http://localhost:11434" }
      ],
      crawlEnabled: true,
      searchProvider: "searxng" as const
    };

    const res = resolveChatRequestBody(config, "session-123", { isHosted: false });
    expect(res.sessionId).toBe("session-123");
    expect(res.config.searchProvider).toBe("searxng");
    expect(res.config.crawlEnabled).toBe(true);
    expect(res.config.chatLlmChain).toHaveLength(1);
    expect(res.config.chatLlmChain[0].baseUrl).toBe("http://localhost:11434");
  });

  it("filters out ollama and sanitizes network options in hosted mode", () => {
    const config = {
      ...DEFAULT_CONFIG,
      chatChain: [
        { id: "c1", provider: "ollama" as const, model: "llama3", keySource: "env" as const, baseUrl: "http://localhost:11434" },
        { id: "c2", provider: "gemini" as const, model: "gemini-2.0-flash", keySource: "env" as const }
      ],
      crawlEnabled: true,
      searchProvider: "searxng" as const
    };

    const res = resolveChatRequestBody(config, "session-123", {
      isHosted: true,
      hasKey: (provider) => provider === "gemini"
    });

    expect(res.config.searchProvider).toBe("none");
    expect(res.config.tier2Enabled).toBe(false);
    expect(res.config.searchBaseUrl).toBeUndefined();
    expect(res.config.crawlEnabled).toBe(false);
    expect(res.config.chatLlmChain.find((c) => c.provider === "ollama")).toBeUndefined();
    const gemini = res.config.chatLlmChain.find((c) => c.provider === "gemini");
    expect(gemini).toBeDefined();
    expect(gemini?.keySource).toBe("ui");
    expect(gemini?.baseUrl).toBeUndefined();
  });

  it("enables research in hosted mode when supported search provider has key", () => {
    const config = {
      ...DEFAULT_CONFIG,
      tier2Enabled: true,
      searchProvider: "tavily" as const,
      chatChain: [
        { id: "c1", provider: "gemini" as const, model: "gemini-2.5-flash", keySource: "ui" as const }
      ]
    };

    const res = resolveChatRequestBody(config, "session-123", {
      isHosted: true,
      hasKey: (provider) => provider === "gemini" || provider === "tavily"
    });

    expect(res.config.searchProvider).toBe("tavily");
    expect(res.config.tier2Enabled).toBe(true);
    expect(res.config.subagentLlmChain).toEqual(res.config.chatLlmChain);
  });

  it("prioritizes market preference over config for market scope", () => {
    const config = {
      ...DEFAULT_CONFIG,
      countryCode: "US",
      currency: "USD"
    };

    const res = resolveChatRequestBody(config, "session-123", {
      marketPreference: {
        countryCode: "IN",
        currencyCode: "INR",
        locale: "en-IN"
      }
    });

    expect(res.config.countryCode).toBe("IN");
    expect(res.config.currency).toBe("INR");
    expect(res.config.locale).toBe("en-IN");
  });

  it("preserves reasoningEffort in local mode for chat and subagent chains", () => {
    const config = {
      ...DEFAULT_CONFIG,
      chatChain: [
        {
          id: "c1",
          provider: "groq" as const,
          model: "llama-3.3-70b-versatile",
          keySource: "env" as const,
          reasoningEffort: "high" as const
        }
      ],
      subagentChain: [
        {
          id: "s1",
          provider: "gemini" as const,
          model: "gemini-2.5-flash",
          keySource: "env" as const,
          reasoningEffort: "low" as const
        }
      ]
    };

    const res = resolveChatRequestBody(config, "session-effort", { isHosted: false });
    expect(res.config.chatLlmChain[0].reasoningEffort).toBe("high");
    expect(res.config.llmChain[0].reasoningEffort).toBe("high");
    expect(res.config.subagentLlmChain?.[0].reasoningEffort).toBe("low");
  });

  it("resolves configured BYOK reasoning effort in hosted mode", () => {
    const config = { ...DEFAULT_CONFIG, chatChain: [] };
    const res = resolveChatRequestBody(config, "session-hosted-effort", {
      isHosted: true,
      activeByokProvider: "groq",
      hasKey: (p) => p === "groq",
      getModel: () => "deepseek-r1-distill-llama-70b",
      getReasoningEffort: (p) => (p === "groq" ? "medium" : undefined)
    });

    expect(res.config.chatLlmChain[0].provider).toBe("groq");
    expect(res.config.chatLlmChain[0].model).toBe("deepseek-r1-distill-llama-70b");
    expect(res.config.chatLlmChain[0].reasoningEffort).toBe("medium");
    expect(res.config.llmChain[0].reasoningEffort).toBe("medium");
  });

  it("builds hosted chat headers exclusively from BYOK keys so legacy local uiKeys cannot override them", () => {
    const store = new Map<string, string>();
    const mockLocalStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); }
    };
    const prevWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = { localStorage: mockLocalStorage };
    try {
      saveUiKey("gemini", "LEGACY_LOCAL_GEMINI_KEY");
      const config = {
        ...DEFAULT_CONFIG,
        tier2Enabled: true,
        searchProvider: "tavily" as const,
        chatChain: [{ id: "c1", provider: "gemini" as const, model: "gemini-4-hydrogen", keySource: "ui" as const }]
      };
      const body = resolveChatRequestBody(config, "session-hosted-headers", {
        isHosted: true,
        activeByokProvider: "gemini",
        hasKey: (p) => p === "gemini" || p === "tavily",
        getModel: () => "gemini-4-hydrogen"
      });
      const headers = resolveChatRequestHeaders(config, body, {
        isHosted: true,
        getByokKey: (p) =>
          p === "gemini"
            ? "BYOK_GEMINI_KEY"
            : p === "tavily"
              ? "BYOK_TAVILY_KEY"
              : p === "openai"
                ? "UNRELATED_OPENAI_KEY"
                : undefined
      });
      expect(headers["x-pcbuildsage-api-key-gemini"]).toBe("BYOK_GEMINI_KEY");
      expect(headers["x-gemini-api-key"]).toBe("BYOK_GEMINI_KEY");
      expect(headers["x-pcbuildsage-api-key-tavily"]).toBe("BYOK_TAVILY_KEY");
      expect(headers["x-tavily-api-key"]).toBe("BYOK_TAVILY_KEY");
      expect(headers["x-pcbuildsage-api-key-openai"]).toBeUndefined();
    } finally {
      if (prevWindow === undefined) delete (globalThis as { window?: unknown }).window;
      else (globalThis as { window?: unknown }).window = prevWindow;
    }
  });
});

describe("resolveActiveModel", () => {
  it("prioritizes configured chatChain model over stale lastAssistantModel so in-chat switches reflect immediately", () => {
    const config = { ...DEFAULT_CONFIG, chatChain: [{ id: "c1", provider: "openrouter" as const, model: "openrouter-default", keySource: "ui" as const }] };
    expect(resolveActiveModel(config, "anthropic/claude-3.5-sonnet", { isHosted: false })).toBe("openrouter-default");
  });

  it("falls back to lastAssistantModel when no model is configured yet", () => {
    const config = { ...DEFAULT_CONFIG, chatChain: [] };
    expect(
      resolveActiveModel(config, "anthropic/claude-3.5-sonnet", {
        isHosted: false,
        hasKey: () => false
      })
    ).toBe("anthropic/claude-3.5-sonnet");
  });

  it("prioritizes active hosted BYOK selection over stale lastAssistantModel", () => {
    const config = { ...DEFAULT_CONFIG, chatChain: [] };
    const model = resolveActiveModel(config, "gemini-2.5-flash", {
      isHosted: true,
      activeByokProvider: "openrouter",
      hasKey: (p) => p === "openrouter",
      getModel: (p) => (p === "openrouter" ? "nex-agi/nex-n2.5-pro:free" : undefined)
    });
    expect(model).toBe("nex-agi/nex-n2.5-pro:free");
  });

  it("uses config.chatChain model when present", () => {
    const config = {
      ...DEFAULT_CONFIG,
      chatChain: [{ id: "c1", provider: "openrouter" as const, model: "nex-agi/nex-n2.5-pro:free", keySource: "ui" as const }]
    };
    expect(resolveActiveModel(config, undefined, { isHosted: false })).toBe("nex-agi/nex-n2.5-pro:free");
  });

  it("resolves BYOK model in hosted mode when chatChain is empty", () => {
    const config = { ...DEFAULT_CONFIG, chatChain: [] };
    const model = resolveActiveModel(config, undefined, {
      isHosted: true,
      activeByokProvider: "openrouter",
      hasKey: (p) => p === "openrouter",
      getModel: (p) => (p === "openrouter" ? "nex-agi/nex-n2.5-pro:free" : undefined)
    });
    expect(model).toBe("nex-agi/nex-n2.5-pro:free");
  });

  it("resolves Groq BYOK model with default fallback in hosted mode", () => {
    const config = { ...DEFAULT_CONFIG, chatChain: [] };
    const model = resolveActiveModel(config, undefined, {
      isHosted: true,
      activeByokProvider: "groq",
      hasKey: (p) => p === "groq",
      getModel: () => undefined
    });
    expect(model).toBe("openai/gpt-oss-120b");
  });

  it("falls back to 'Sage' when no keys or chains exist", () => {
    const config = { ...DEFAULT_CONFIG, chatChain: [] };
    const model = resolveActiveModel(config, undefined, {
      isHosted: true,
      activeByokProvider: null,
      hasKey: () => false,
      getModel: () => undefined
    });
    expect(model).toBe("Sage");
  });
});
