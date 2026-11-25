/**
 * src/features/chat/chat-config-resolver.ts
 *
 * Pure resolution of chat request payload and LLM chains from client configuration,
 * BYOK credentials, active market preferences, and hosted deployment constraints.
 */

import { isHostedMode } from "@/lib/api-client";
import { apiKeyHeaders } from "@/lib/client-config-store";
import { getMarketPreference, type MarketPreference } from "@/lib/market/client-market-store";
import {
  getActiveByokProvider,
  getByokKey,
  getByokModel,
  getByokModelReasoningEffort,
  getByokReasoningEffort,
  hasByokKey,
  injectByokHeaders
} from "@/lib/llm/client-byok-store";
import { pickHostedProvider } from "@/lib/llm/hosted-defaults";
import { isHostedProvider } from "@/lib/llm/providers";
import type { StoredCompactContext } from "@/lib/sessions/compact-context";
import type { ClientConfig, KeySource, LLMProvider, ReasoningEffort, SearchProvider } from "@/types/client";

export interface ResolveChatOptions {
  isHosted?: boolean;
  marketPreference?: MarketPreference;
  activeByokProvider?: string | null;
  hasKey?: (provider: string) => boolean;
  getModel?: (provider: string) => string | undefined;
  getReasoningEffort?: (provider: string, model?: string) => ReasoningEffort | undefined;
  compactContext?: StoredCompactContext | null;
}

export interface ChatRequestBody {
  sessionId: string;
  compactContext?: StoredCompactContext | null;
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
  const getReasoningEffortFn =
    options?.getReasoningEffort ??
    ((provider: string, model?: string) =>
      model ? getByokModelReasoningEffort(provider, model) : getByokReasoningEffort(provider));
  const activeProvider =
    options?.activeByokProvider !== undefined
      ? options.activeByokProvider
      : getActiveByokProvider();

  const countryCode = marketPref.countryCode || config.countryCode;
  const currency = marketPref.currencyCode || config.currency;

  let chatChain = config.chatChain;
  if (isHosted) {
    chatChain = chatChain.filter((entry) => isHostedProvider(entry.provider));
    const preferred = pickHostedProvider(activeProvider, hasKeyFn, getModelFn);

    if (preferred) {
      const { provider: preferredProvider, model } = preferred;
      const effort = getReasoningEffortFn(preferredProvider, model);
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
    ...(entry.reasoningEffort ? { reasoningEffort: entry.reasoningEffort } : {}),
    ...(entry.contextLimit ? { contextLimit: entry.contextLimit } : {})
  }));

  let subagentChain = serverChain;
  if (config.subagentChain && config.subagentChain.length > 0) {
    const rawSub = isHosted
      ? config.subagentChain.filter((entry) => isHostedProvider(entry.provider))
      : config.subagentChain;
    if (rawSub.length > 0) {
      subagentChain = rawSub.map((entry) => ({
        provider: entry.provider,
        model: entry.model,
        keySource: (hasKeyFn(entry.provider) ? "ui" : entry.keySource) as "env" | "ui",
        baseUrl: isHosted ? undefined : entry.baseUrl,
        ...(entry.reasoningEffort ? { reasoningEffort: entry.reasoningEffort } : {}),
        ...(entry.contextLimit ? { contextLimit: entry.contextLimit } : {})
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
    ...(options?.compactContext ? { compactContext: options.compactContext } : {}),
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

export interface ResolveChatHeadersOptions {
  isHosted?: boolean;
  getByokKey?: (provider: string) => string | undefined;
}

/**
 * Builds API-key headers for `/api/chat` and `/api/chat/compact`.
 *
 * In hosted mode, headers are built exclusively from browser BYOK keys for
 * the resolved chat/subagent chains and enabled hosted search provider so a
 * legacy local key in `pcbuildsage:uiKeys` can never override the active BYOK
 * credential.
 */
export function resolveChatRequestHeaders(
  config: ClientConfig,
  requestBody: ChatRequestBody,
  options?: ResolveChatHeadersOptions
): Record<string, string> {
  const isHosted = options?.isHosted !== undefined ? options.isHosted : isHostedMode();
  if (!isHosted) {
    return injectByokHeaders(apiKeyHeaders(config.chatChain, config)) as Record<string, string>;
  }

  const getKey = options?.getByokKey ?? getByokKey;
  const providers = new Set<string>();
  for (const entry of requestBody.config.chatLlmChain) {
    providers.add(entry.provider);
  }
  for (const entry of requestBody.config.subagentLlmChain ?? []) {
    providers.add(entry.provider);
  }
  if (["exa", "tavily", "brave"].includes(requestBody.config.searchProvider)) {
    providers.add(requestBody.config.searchProvider);
  }

  const headers: Record<string, string> = {};
  for (const provider of providers) {
    const key = getKey(provider)?.trim();
    if (!key) continue;
    const normalized = provider.trim().toLowerCase().replace(/_/g, "-");
    headers[`x-pcbuildsage-api-key-${normalized}`] = key;
    headers[`x-${normalized}-api-key`] = key;
  }
  return headers;
}

export interface ActiveSelection {
  provider?: string;
  model: string;
  baseUrl?: string;
  reasoningEffort?: ReasoningEffort;
}

/**
 * Resolves the active (provider, model, reasoningEffort) for UI headers,
 * status indicators, and the in-chat model picker.
 *
 * The user's currently configured selection always takes precedence over
 * `lastAssistantModel` so switching models mid-conversation updates the UI
 * immediately; `lastAssistantModel` is only a fallback when no model is
 * configured yet.
 */
export function resolveActiveSelection(
  config: ClientConfig,
  lastAssistantModel?: string,
  options?: ResolveChatOptions
): ActiveSelection {
  const isHosted = options?.isHosted !== undefined ? options.isHosted : isHostedMode();
  const hasKeyFn = options?.hasKey ?? hasByokKey;
  const getModelFn = options?.getModel ?? getByokModel;
  const getReasoningEffortFn =
    options?.getReasoningEffort ??
    ((provider: string, model?: string) =>
      model ? getByokModelReasoningEffort(provider, model) : getByokReasoningEffort(provider));
  const activeProvider =
    options?.activeByokProvider !== undefined
      ? options.activeByokProvider
      : getActiveByokProvider();

  if (isHosted) {
    const preferred = pickHostedProvider(activeProvider, hasKeyFn, getModelFn);
    if (preferred) {
      return {
        provider: preferred.provider,
        model: preferred.model,
        reasoningEffort: getReasoningEffortFn(preferred.provider, preferred.model)
      };
    }
    return {
      model: lastAssistantModel || config.chatChain?.[0]?.model || "Sage"
    };
  }

  const primary = config.chatChain?.[0];
  if (primary?.model) {
    return {
      provider: primary.provider,
      model: primary.model,
      baseUrl: primary.baseUrl,
      reasoningEffort: primary.reasoningEffort
    };
  }

  const preferred = pickHostedProvider(activeProvider, hasKeyFn, getModelFn);
  if (preferred) {
    return {
      provider: preferred.provider,
      model: preferred.model,
      reasoningEffort: getReasoningEffortFn(preferred.provider, preferred.model)
    };
  }

  return {
    provider: primary?.provider,
    model: lastAssistantModel || "Sage",
    baseUrl: primary?.baseUrl,
    reasoningEffort: primary?.reasoningEffort
  };
}

/**
 * Resolves the active model identifier for UI headers and status indicators.
 */
export function resolveActiveModel(
  config: ClientConfig,
  lastAssistantModel?: string,
  options?: ResolveChatOptions
): string {
  return resolveActiveSelection(config, lastAssistantModel, options).model;
}
