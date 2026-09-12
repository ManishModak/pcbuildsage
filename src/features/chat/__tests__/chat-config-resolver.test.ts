import { describe, it, expect } from "vitest";
import { resolveChatRequestBody } from "../chat-config-resolver";
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

    expect(res.config.searchProvider).toBe("duckduckgo");
    expect(res.config.searchBaseUrl).toBeUndefined();
    expect(res.config.crawlEnabled).toBe(false);
    expect(res.config.chatLlmChain.find((c) => c.provider === "ollama")).toBeUndefined();
    const gemini = res.config.chatLlmChain.find((c) => c.provider === "gemini");
    expect(gemini).toBeDefined();
    expect(gemini?.keySource).toBe("ui");
    expect(gemini?.baseUrl).toBeUndefined();
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
