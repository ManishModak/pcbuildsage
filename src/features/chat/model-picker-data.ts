import { hasUiKey, savedUiKey } from "@/lib/client-config-store";
import {
  getByokKey,
  getByokModel,
  getByokModelReasoningEffort,
  isByokKeyPersistent,
  setActiveByokProvider,
  setByokModel,
  setByokModelReasoningEffort,
  setByokReasoningEffort
} from "@/lib/llm/client-byok-store";
import { hostedDefaultModelFor } from "@/lib/llm/hosted-defaults";
import { getFreeTierWarning, supportsReasoning, type FreeTierWarning } from "@/lib/llm/model-capabilities";
import { groupModelsForPicker, isFreeModel, isToolCapableModel } from "@/lib/llm/model-recommend";
import { LLM_PROVIDERS, getProvider, isLocalProvider, providerName, type ProviderInfo } from "@/lib/llm/providers";
import type { ChainEntry, ClientConfig, CredentialAvailability, DiscoveredModel, KeySource, LLMProvider, ReasoningEffort } from "@/types/client";

export interface EligibleProvidersInput {
  isHosted: boolean;
  chatChain: ChainEntry[];
  subagentChain?: ChainEntry[] | null;
  credentials?: CredentialAvailability | null;
  hasKey: (provider: string) => boolean;
  localServerProviders?: ReadonlySet<string>;
}

/**
 * Providers the in-chat model picker may show:
 * - Hosted mode: strictly `provider.hosted === true` AND a browser-stored BYOK key.
 *   Never exposes server `.env` keys or local providers (`ollama`, `openai-compatible`).
 * - Local mode: providers that have a configured chain entry, server `.env` key,
 *   saved UI key, or detected local server.
 */
export function getEligibleProviders(input: EligibleProvidersInput): ProviderInfo[] {
  const { isHosted, chatChain, subagentChain, credentials, hasKey, localServerProviders } = input;
  if (isHosted) {
    return LLM_PROVIDERS.filter((provider) => provider.hosted && hasKey(provider.id));
  }
  const chainProviders = new Set([
    ...chatChain.map((entry) => entry.provider),
    ...(subagentChain ?? []).map((entry) => entry.provider)
  ]);
  return LLM_PROVIDERS.filter((provider) => {
    if (chainProviders.has(provider.id)) return true;
    if (credentials?.llm?.[provider.id]) return true;
    if (hasKey(provider.id)) return true;
    if (localServerProviders?.has(provider.id)) return true;
    return false;
  });
}

export interface PickerModelItem {
  provider: LLMProvider;
  providerLabel: string;
  model: string;
  name?: string;
  contextLimit?: number;
  free: boolean;
  toolCapable: boolean;
  supportedParameters?: string[];
  supportsReasoning: boolean;
  freeTierWarning: FreeTierWarning | null;
  /** Role badge for configured entries ("Main", "Backup 1", "Active", "Saved"). */
  configuredBadge?: string;
  isConfigured: boolean;
}

export interface PickerSectionsInput {
  eligibleProviders: ProviderInfo[];
  isHosted: boolean;
  chatChain: ChainEntry[];
  activeProvider?: string;
  activeModel?: string;
  getByokModel?: (provider: string) => string | undefined;
  discoveredByProvider: Record<string, DiscoveredModel[]>;
  selectedProvider: string;
  query: string;
}

export interface PickerSectionsResult {
  configured: PickerModelItem[];
  recommended: PickerModelItem[];
  available: PickerModelItem[];
}

function makeModelItem(params: {
  provider: LLMProvider;
  model: string;
  name?: string;
  contextLimit?: number;
  discovered?: DiscoveredModel;
  configuredBadge?: string;
  isConfigured: boolean;
}): PickerModelItem {
  const { provider, model, name, contextLimit, discovered, configuredBadge, isConfigured } = params;
  return {
    provider,
    providerLabel: providerName(provider),
    model,
    name: name ?? discovered?.name,
    contextLimit: contextLimit ?? discovered?.contextLimit,
    free: discovered ? isFreeModel(discovered) : false,
    toolCapable: discovered ? isToolCapableModel(discovered) : false,
    supportedParameters: discovered?.supportedParameters,
    supportsReasoning: supportsReasoning(provider, model, discovered),
    freeTierWarning: getFreeTierWarning(provider, model),
    configuredBadge,
    isConfigured
  };
}

function matchesMultiWordQuery(item: PickerModelItem, words: string[]): boolean {
  if (words.length === 0) return true;
  const haystack = `${item.model} ${item.name ?? ""} ${item.providerLabel} ${item.provider}`.toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/**
 * Builds the configured section (on top) and searchable discovered sections
 * (recommended + available) for the in-chat model picker.
 */
export function buildPickerSections(input: PickerSectionsInput): PickerSectionsResult {
  const {
    eligibleProviders,
    isHosted,
    chatChain,
    activeProvider,
    activeModel,
    getByokModel: getByokModelFn = getByokModel,
    discoveredByProvider,
    selectedProvider,
    query
  } = input;

  const eligibleIds = new Set(eligibleProviders.map((p) => p.id));
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);

  const discoveredLookup = new Map<string, DiscoveredModel>();
  for (const provider of eligibleProviders) {
    for (const model of discoveredByProvider[provider.id] ?? []) {
      discoveredLookup.set(`${provider.id}::${model.id}`, model);
    }
  }

  const configuredAll: PickerModelItem[] = [];
  const configuredKeys = new Set<string>();

  if (isHosted) {
    for (const provider of eligibleProviders) {
      const model = getByokModelFn(provider.id) || hostedDefaultModelFor(provider.id);
      if (!model) continue;
      const key = `${provider.id}::${model}`;
      if (configuredKeys.has(key)) continue;
      configuredKeys.add(key);
      const isActive = activeProvider === provider.id && activeModel === model;
      configuredAll.push(
        makeModelItem({
          provider: provider.id as LLMProvider,
          model,
          discovered: discoveredLookup.get(key),
          configuredBadge: isActive ? "Active" : "Saved",
          isConfigured: true
        })
      );
    }
  } else {
    chatChain.forEach((entry, index) => {
      if (!entry.model || !eligibleIds.has(entry.provider)) return;
      const key = `${entry.provider}::${entry.model}`;
      if (configuredKeys.has(key)) return;
      configuredKeys.add(key);
      configuredAll.push(
        makeModelItem({
          provider: entry.provider,
          model: entry.model,
          contextLimit: entry.contextLimit,
          discovered: discoveredLookup.get(key),
          configuredBadge: index === 0 ? "Main" : `Backup ${index}`,
          isConfigured: true
        })
      );
    });
  }

  const providerMatches = (providerId: string) => selectedProvider === "all" || providerId === selectedProvider;

  const configured = configuredAll.filter((item) => providerMatches(item.provider) && matchesMultiWordQuery(item, words));

  const discoveredFlat: PickerModelItem[] = [];
  const seenDiscovered = new Set<string>();
  for (const provider of eligibleProviders) {
    if (!providerMatches(provider.id)) continue;
    for (const model of discoveredByProvider[provider.id] ?? []) {
      const key = `${provider.id}::${model.id}`;
      if (configuredKeys.has(key) || seenDiscovered.has(key)) continue;
      seenDiscovered.add(key);
      const item = makeModelItem({
        provider: provider.id as LLMProvider,
        model: model.id,
        discovered: model,
        isConfigured: false
      });
      if (matchesMultiWordQuery(item, words)) {
        discoveredFlat.push(item);
      }
    }
  }

  const { recommended, rest } = groupModelsForPicker(
    discoveredFlat.map((item) => ({
      ...item,
      id: item.model
    }))
  );

  return {
    configured,
    recommended,
    available: rest
  };
}

export function resolveDiscoveryRequestParams(params: {
  provider: ProviderInfo;
  isHosted: boolean;
  chatChain: ChainEntry[];
  subagentChain?: ChainEntry[] | null;
  hasUiKeyFn?: (provider: string) => boolean;
  savedUiKeyFn?: (provider: string) => string | undefined;
  getByokKeyFn?: (provider: string) => string | undefined;
}): { provider: string; keySource: KeySource; apiKey?: string; baseUrl?: string } {
  const {
    provider,
    isHosted,
    chatChain,
    subagentChain,
    hasUiKeyFn = hasUiKey,
    savedUiKeyFn = savedUiKey,
    getByokKeyFn = getByokKey
  } = params;

  if (isHosted) {
    return {
      provider: provider.id,
      keySource: "ui",
      apiKey: getByokKeyFn(provider.id)
    };
  }

  const chainMatch =
    chatChain.find((entry) => entry.provider === provider.id) ??
    subagentChain?.find((entry) => entry.provider === provider.id);

  if (isLocalProvider(provider.id)) {
    const hasSaved = hasUiKeyFn(provider.id);
    return {
      provider: provider.id,
      keySource: chainMatch?.keySource ?? (hasSaved ? "ui" : "none"),
      apiKey: hasSaved ? savedUiKeyFn(provider.id) : undefined,
      baseUrl: chainMatch?.baseUrl
    };
  }

  const hasSaved = hasUiKeyFn(provider.id);
  return {
    provider: provider.id,
    keySource: hasSaved ? "ui" : (chainMatch?.keySource ?? "env"),
    apiKey: hasSaved ? savedUiKeyFn(provider.id) : undefined,
    baseUrl: chainMatch?.baseUrl
  };
}

/**
 * Updates `chatChain[0]` cleanly in local mode without wiping backup entries (`chatChain.slice(1)`).
 */
export function applyModelSwitchLocal(
  prevConfig: ClientConfig,
  selection: {
    provider: LLMProvider;
    model: string;
    contextLimit?: number;
    supportedParameters?: string[];
    reasoningEffort?: ReasoningEffort;
    credentials?: CredentialAvailability | null;
    hasUiKeyFn?: (provider: string) => boolean;
  }
): ClientConfig {
  const {
    provider,
    model,
    contextLimit,
    supportedParameters,
    reasoningEffort,
    credentials,
    hasUiKeyFn = hasUiKey
  } = selection;

  const existingPrimary = prevConfig.chatChain[0];
  const backups = prevConfig.chatChain.slice(1);
  const matchingExisting =
    (existingPrimary?.provider === provider ? existingPrimary : undefined) ??
    prevConfig.chatChain.find((entry) => entry.provider === provider) ??
    prevConfig.subagentChain?.find((entry) => entry.provider === provider);

  const canReason = supportsReasoning(provider, model, { supportedParameters });
  const isSameEntry = existingPrimary?.provider === provider && existingPrimary?.model === model;

  const nextEffort: ReasoningEffort | undefined = canReason
    ? reasoningEffort !== undefined
      ? reasoningEffort
      : isSameEntry
        ? existingPrimary.reasoningEffort
        : undefined
    : undefined;

  const resolvedKeySource: KeySource = matchingExisting?.keySource
    ? matchingExisting.keySource
    : isLocalProvider(provider)
      ? hasUiKeyFn(provider)
        ? "ui"
        : "none"
      : hasUiKeyFn(provider)
        ? "ui"
        : credentials?.llm?.[provider]
          ? "env"
          : "ui";

  const resolvedContextLimit =
    contextLimit ?? (isSameEntry ? existingPrimary.contextLimit : undefined);

  const nextPrimary: ChainEntry = {
    id: existingPrimary?.provider === provider ? existingPrimary.id : `chat-${provider}-${Date.now()}`,
    provider,
    model,
    keySource: resolvedKeySource,
    ...(matchingExisting?.baseUrl ? { baseUrl: matchingExisting.baseUrl } : {}),
    ...(matchingExisting?.presetName ? { presetName: matchingExisting.presetName } : {}),
    ...(matchingExisting?.hasSavedKey !== undefined ? { hasSavedKey: matchingExisting.hasSavedKey } : {}),
    ...(resolvedContextLimit ? { contextLimit: resolvedContextLimit } : {}),
    ...(nextEffort ? { reasoningEffort: nextEffort } : {}),
    ...(isSameEntry && existingPrimary.ping ? { ping: existingPrimary.ping } : {})
  };

  return {
    ...prevConfig,
    chatChain: [nextPrimary, ...backups]
  };
}

/**
 * Updates `chatChain[0].reasoningEffort` in local mode without touching backup entries.
 */
export function applyReasoningSwitchLocal(
  prevConfig: ClientConfig,
  effort?: ReasoningEffort
): ClientConfig {
  if (prevConfig.chatChain.length === 0) return prevConfig;
  const [primary, ...backups] = prevConfig.chatChain;
  const nextPrimary: ChainEntry = { ...primary };
  if (effort) {
    nextPrimary.reasoningEffort = effort;
  } else {
    delete nextPrimary.reasoningEffort;
  }
  return {
    ...prevConfig,
    chatChain: [nextPrimary, ...backups]
  };
}

/**
 * Persists a hosted-mode model switch into the BYOK store while keeping
 * per-model reasoning effort synchronized with `getByokReasoningEffort`.
 */
export function applyModelSwitchHosted(selection: {
  provider: string;
  model: string;
  supportedParameters?: string[];
  reasoningEffort?: ReasoningEffort;
}): void {
  const { provider, model, supportedParameters, reasoningEffort } = selection;
  const info = getProvider(provider);
  if (!info?.hosted) return;

  const persist = isByokKeyPersistent(provider);
  setActiveByokProvider(provider, persist);
  setByokModel(provider, model, persist);

  if (!supportsReasoning(provider, model, { supportedParameters })) {
    setByokReasoningEffort(provider, undefined, persist);
    return;
  }

  if (reasoningEffort !== undefined) {
    setByokModelReasoningEffort(provider, model, reasoningEffort, persist, true);
  } else {
    const remembered = getByokModelReasoningEffort(provider, model);
    setByokReasoningEffort(provider, remembered, persist);
  }
}

/**
 * Persists a hosted-mode reasoning-effort change for the active model.
 */
export function applyReasoningSwitchHosted(
  provider: string,
  model: string,
  effort?: ReasoningEffort
): void {
  const persist = isByokKeyPersistent(provider);
  setByokModelReasoningEffort(provider, model, effort, persist, true);
}
