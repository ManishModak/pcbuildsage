import { describe, it, expect } from "vitest";
import { resolveActiveModel, resolveChatRequestBody } from "../chat-config-resolver";
import { DEFAULT_CONFIG } from "@/lib/client-config-store";

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
});

describe("resolveActiveModel", () => {
  it("prioritizes last assistant message metadata model", () => {
    const config = { ...DEFAULT_CONFIG, chatChain: [{ id: "c1", provider: "openrouter" as const, model: "openrouter-default", keySource: "ui" as const }] };
    expect(resolveActiveModel(config, "anthropic/claude-3.5-sonnet")).toBe("anthropic/claude-3.5-sonnet");
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
