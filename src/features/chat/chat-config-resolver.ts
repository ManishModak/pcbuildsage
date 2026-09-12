/**
 * src/features/chat/chat-config-resolver.ts
 *
 * Pure resolution of chat request payload and LLM chains from client configuration,
 * BYOK credentials, active market preferences, and hosted deployment constraints.
 */

import { isHostedMode } from "@/lib/api-client";
import { toServerChain } from "@/lib/client-config-store";
import { getMarketPreference, type MarketPreference } from "@/lib/market/client-market-store";
import { getActiveByokProvider, getByokModel, hasByokKey } from "@/lib/llm/client-byok-store";
import type { ClientConfig, KeySource, LLMProvider } from "@/types/client";

export interface ResolveChatOptions {
  isHosted?: boolean;
  marketPreference?: MarketPreference;
  activeByokProvider?: string | null;
  hasKey?: (provider: string) => boolean;
  getModel?: (provider: string) => string | undefined;
}

export interface ChatRequestBody {
  sessionId: string;
  config: {
    chatLlmChain: Array<{
      provider: LLMProvider;
      model: string;
      keySource: KeySource;
      baseUrl?: string;
    }>;
    llmChain: Array<{
      provider: LLMProvider;
      model: string;
      keySource: KeySource;
      baseUrl?: string;
    }>;
    subagentLlmChain?: Array<{
      provider: LLMProvider;
      model: string;
      keySource: KeySource;
      baseUrl?: string;
    }>;
    personality: string;
    tier2Enabled: boolean;
    freeformConsultEnabled: boolean;
    countryCode: string;
    currency: string;
    locale?: string;
    marketPreference: MarketPreference;
    searchProvider: string;
    searchBaseUrl?: string;
    crawlEnabled: boolean;
  };
}

export function resolveChatRequestBody(
  config: ClientConfig,
  sessionId: string,
  options?: ResolveChatOptions
): ChatRequestBody {
  const isHosted = options?.isHosted !== undefined ? options.isHosted : isHostedMode();
  const marketPref = options?.marketPreference ?? getMarketPreference();
  const hasKeyFn = options?.hasKey ?? hasByokKey;
  const getModelFn = options?.getModel ?? getByokModel;
  const activeProvider =
    options?.activeByokProvider !== undefined
      ? options.activeByokProvider
      : getActiveByokProvider();

  const countryCode = marketPref.countryCode || config.countryCode;
  const currency = marketPref.currencyCode || config.currency;

  let chatChain = config.chatChain;
  if (isHosted) {
    chatChain = chatChain.filter((entry) => entry.provider !== "ollama");
    const preferredProvider =
      activeProvider && hasKeyFn(activeProvider)
        ? activeProvider
        : hasKeyFn("gemini")
          ? "gemini"
          : hasKeyFn("openrouter")
            ? "openrouter"
            : null;

    if (preferredProvider) {
      const model =
        getModelFn(preferredProvider) ||
        (preferredProvider === "gemini" ? "gemini-2.5-flash" : "anthropic/claude-3.5-sonnet");
      chatChain = [
        {
          id: `hosted-${preferredProvider}`,
          provider: preferredProvider as LLMProvider,
          model,
          keySource: "ui"
        }
      ];
    }
  }

  const serverChain = chatChain.map((entry) => ({
    provider: entry.provider,
    model: entry.model,
    keySource: (hasKeyFn(entry.provider) ? "ui" : entry.keySource) as "env" | "ui",
    baseUrl: isHosted ? undefined : entry.baseUrl
  }));

  return {
    sessionId,
    config: {
      chatLlmChain: serverChain,
      llmChain: serverChain,
      ...(config.subagentChain ? { subagentLlmChain: toServerChain(config.subagentChain) } : {}),
      personality: config.personality,
      tier2Enabled: config.tier2Enabled,
      freeformConsultEnabled: config.freeformConsultEnabled,
      countryCode,
      currency,
      locale: marketPref.locale,
      marketPreference: marketPref,
      searchProvider: isHosted ? "duckduckgo" : config.searchProvider,
      searchBaseUrl: isHosted ? undefined : config.searchBaseUrl,
      crawlEnabled: isHosted ? false : config.crawlEnabled
    }
  };
}
