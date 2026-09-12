/**
 * src/features/chat/chat-config-resolver.ts
 *
 * Pure resolution of chat request payload and LLM chains from client configuration,
 * BYOK credentials, active market preferences, and hosted deployment constraints.
 */

import { isHostedMode } from "@/lib/api-client";
import { getMarketPreference, type MarketPreference } from "@/lib/market/client-market-store";
import { getActiveByokProvider, getByokModel, getByokReasoningEffort, hasByokKey } from "@/lib/llm/client-byok-store";
import type { ClientConfig, KeySource, LLMProvider, ReasoningEffort, SearchProvider } from "@/types/client";

export interface ResolveChatOptions {
  isHosted?: boolean;
  marketPreference?: MarketPreference;
  activeByokProvider?: string | null;
  hasKey?: (provider: string) => boolean;
  getModel?: (provider: string) => string | undefined;
  getReasoningEffort?: (provider: string) => ReasoningEffort | undefined;
}

export interface ChatRequestBody {
  sessionId: string;
  config: {
    chatLlmChain: Array<{
      provider: LLMProvider;
      model: string;
      keySource: KeySource;
      baseUrl?: string;
      reasoningEffort?: ReasoningEffort;
    }>;
    llmChain: Array<{
      provider: LLMProvider;
      model: string;
      keySource: KeySource;
      baseUrl?: string;
      reasoningEffort?: ReasoningEffort;
    }>;
    subagentLlmChain?: Array<{
      provider: LLMProvider;
      model: string;
      keySource: KeySource;
      baseUrl?: string;
      reasoningEffort?: ReasoningEffort;
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
  const getReasoningEffortFn = options?.getReasoningEffort ?? getByokReasoningEffort;
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
          : hasKeyFn("groq")
            ? "groq"
            : hasKeyFn("openrouter")
              ? "openrouter"
              : null;

    if (preferredProvider) {
      const defaultModel =
        preferredProvider === "gemini"
          ? "gemini-2.5-flash"
          : preferredProvider === "groq"
            ? "llama-3.3-70b-versatile"
            : "anthropic/claude-3.5-sonnet";
      const model = getModelFn(preferredProvider) || defaultModel;
      const effort = getReasoningEffortFn(preferredProvider);
      chatChain = [
        {
          id: `hosted-${preferredProvider}`,
          provider: preferredProvider as LLMProvider,
          model,
          keySource: "ui",
          ...(effort ? { reasoningEffort: effort } : {})
        }
      ];
    }
  }

  const serverChain = chatChain.map((entry) => ({
    provider: entry.provider,
    model: entry.model,
    keySource: (hasKeyFn(entry.provider) ? "ui" : entry.keySource) as "env" | "ui",
    baseUrl: isHosted ? undefined : entry.baseUrl,
    ...(entry.reasoningEffort ? { reasoningEffort: entry.reasoningEffort } : {})
  }));

  let subagentChain = serverChain;
  if (config.subagentChain && config.subagentChain.length > 0) {
    const rawSub = isHosted
      ? config.subagentChain.filter((entry) => entry.provider !== "ollama")
      : config.subagentChain;
    if (rawSub.length > 0) {
      subagentChain = rawSub.map((entry) => ({
        provider: entry.provider,
        model: entry.model,
        keySource: (hasKeyFn(entry.provider) ? "ui" : entry.keySource) as "env" | "ui",
        baseUrl: isHosted ? undefined : entry.baseUrl,
        ...(entry.reasoningEffort ? { reasoningEffort: entry.reasoningEffort } : {})
      }));
    }
  }

  const supportedHostedSearch = ["tavily", "exa", "brave"];
  const isHostedResearchConfigured =
    Boolean(config.tier2Enabled) &&
    supportedHostedSearch.includes(config.searchProvider) &&
    hasKeyFn(config.searchProvider);

  const effectiveSearchProvider: SearchProvider = isHosted
    ? (isHostedResearchConfigured ? config.searchProvider : "none")
    : config.searchProvider;

  const effectiveTier2 = isHosted
    ? isHostedResearchConfigured
    : Boolean(config.tier2Enabled);

  return {
    sessionId,
    config: {
      chatLlmChain: serverChain,
      llmChain: serverChain,
      subagentLlmChain: subagentChain,
      personality: config.personality,
      tier2Enabled: effectiveTier2,
      freeformConsultEnabled: config.freeformConsultEnabled,
      countryCode,
      currency,
      locale: marketPref.locale,
      marketPreference: marketPref,
      searchProvider: effectiveSearchProvider,
      searchBaseUrl: isHosted ? undefined : config.searchBaseUrl,
      crawlEnabled: isHosted ? false : config.crawlEnabled
    }
  };
}

/**
 * Resolves the active model identifier for UI headers and status indicators.
 * Respects last assistant message metadata, chatChain configuration, and
 * client-side BYOK provider preferences.
 */
export function resolveActiveModel(
  config: ClientConfig,
  lastAssistantModel?: string,
  options?: ResolveChatOptions
): string {
  if (lastAssistantModel) return lastAssistantModel;

  const isHosted = options?.isHosted !== undefined ? options.isHosted : isHostedMode();
  const hasKeyFn = options?.hasKey ?? hasByokKey;
  const getModelFn = options?.getModel ?? getByokModel;
  const activeProvider =
    options?.activeByokProvider !== undefined
      ? options.activeByokProvider
      : getActiveByokProvider();

  // If in hosted mode or chatChain is unpopulated, check active BYOK provider
  if (isHosted || !config.chatChain || config.chatChain.length === 0) {
    const preferredProvider =
      activeProvider && hasKeyFn(activeProvider)
        ? activeProvider
        : hasKeyFn("gemini")
          ? "gemini"
          : hasKeyFn("groq")
            ? "groq"
            : hasKeyFn("openrouter")
              ? "openrouter"
              : null;

    if (preferredProvider) {
      const defaultModel =
        preferredProvider === "gemini"
          ? "gemini-2.5-flash"
          : preferredProvider === "groq"
            ? "llama-3.3-70b-versatile"
            : "anthropic/claude-3.5-sonnet";
      return getModelFn(preferredProvider) || defaultModel;
    }
  }

  return config.chatChain?.[0]?.model || "Sage";
}
