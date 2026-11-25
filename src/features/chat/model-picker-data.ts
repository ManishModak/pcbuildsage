import {
  getLocalModelReasoningEffort,
  hasUiKey,
  savedUiKey,
  setLocalModelReasoningEffort
} from "@/lib/client-config-store";
import {
  getByokKey,
  getByokModel,
  isByokKeyPersistent,
  setActiveByokProvider,
  setByokModel,
  setByokModelReasoningEffort
} from "@/lib/llm/client-byok-store";
import { isChatCapableGeminiModel } from "@/lib/llm/discovery";
import { hostedDefaultModelFor } from "@/lib/llm/hosted-defaults";
import { getFreeTierWarning, supportsReasoning, type FreeTierWarning } from "@/lib/llm/model-capabilities";
import { isFreeModel, isToolCapableModel } from "@/lib/llm/model-recommend";
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

export interface PickerDiscoveredEndpoint {
  baseUrl?: string;
  keySource?: KeySource;
  presetName?: string;
  hasSavedKey?: boolean;
}

export interface PickerModelItem {
  /** Stable identity distinguishing provider, endpoint, and configured entry. */
  entryKey: string;
  /** Original `ChainEntry.id` when built from a configured local chain entry. */
  sourceEntryId?: string;
  provider: LLMProvider;
  providerLabel: string;
  model: string;
  name?: string;
  baseUrl?: string;
  keySource?: KeySource;
  presetName?: string;
  hasSavedKey?: boolean;
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
  /** Connection settings that supplied each provider's discovered catalog. */
  discoveredEndpointsByProvider?: Record<string, PickerDiscoveredEndpoint>;
  selectedProvider: string;
  query: string;
}

export interface PickerSectionsResult {
  configured: PickerModelItem[];
  recommended: PickerModelItem[];
  available: PickerModelItem[];
}

function modelIdentityKey(provider: string, model: string, baseUrl?: string): string {
  return `${provider}::${(baseUrl ?? "").trim()}::${model}`;
}

function makeModelItem(params: {
  entryKey: string;
  sourceEntryId?: string;
  provider: LLMProvider;
  model: string;
  name?: string;
  baseUrl?: string;
  keySource?: KeySource;
  presetName?: string;
  hasSavedKey?: boolean;
  contextLimit?: number;
  discovered?: DiscoveredModel;
  configuredBadge?: string;
  isConfigured: boolean;
}): PickerModelItem {
  const {
    entryKey,
    sourceEntryId,
    provider,
    model,
    name,
    baseUrl,
    keySource,
    presetName,
    hasSavedKey,
    contextLimit,
    discovered,
    configuredBadge,
    isConfigured
  } = params;
  return {
    entryKey,
    sourceEntryId,
    provider,
    providerLabel: providerName(provider),
    model,
    name: name ?? discovered?.name,
    baseUrl,
    keySource,
    presetName,
    hasSavedKey,
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
  const haystack = `${item.model} ${item.name ?? ""} ${item.providerLabel} ${item.provider} ${item.baseUrl ?? ""}`.toLowerCase();
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
    discoveredEndpointsByProvider = {},
    selectedProvider,
    query
  } = input;

  const eligibleIds = new Set(eligibleProviders.map((p) => p.id));
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);

  const discoveredLookup = new Map<string, DiscoveredModel>();
  const discoveredByProviderModel = new Map<string, DiscoveredModel>();
  for (const provider of eligibleProviders) {
    const endpoint = discoveredEndpointsByProvider[provider.id];
    for (const model of discoveredByProvider[provider.id] ?? []) {
      discoveredLookup.set(modelIdentityKey(provider.id, model.id, endpoint?.baseUrl), model);
      discoveredByProviderModel.set(`${provider.id}::${model.id}`, model);
    }
  }

  const configuredAll: PickerModelItem[] = [];
  const configuredKeys = new Set<string>();

  if (isHosted) {
    for (const provider of eligibleProviders) {
      const model = getByokModelFn(provider.id) || hostedDefaultModelFor(provider.id);
      if (!model) continue;
      const key = modelIdentityKey(provider.id, model);
      if (configuredKeys.has(key)) continue;
      configuredKeys.add(key);
      const isActive = activeProvider === provider.id && activeModel === model;
      configuredAll.push(
        makeModelItem({
          entryKey: `cfg:${key}`,
          provider: provider.id as LLMProvider,
          model,
          discovered: discoveredLookup.get(key) ?? discoveredByProviderModel.get(`${provider.id}::${model}`),
          configuredBadge: isActive ? "Active" : "Saved",
          isConfigured: true
        })
      );
    }
  } else {
    chatChain.forEach((entry, index) => {
      if (!entry.model || !eligibleIds.has(entry.provider)) return;
      const key = modelIdentityKey(entry.provider, entry.model, entry.baseUrl);
      if (configuredKeys.has(key)) return;
      configuredKeys.add(key);
      configuredAll.push(
        makeModelItem({
          entryKey: `cfg:${entry.id}`,
          sourceEntryId: entry.id,
          provider: entry.provider,
          model: entry.model,
          baseUrl: entry.baseUrl,
          keySource: entry.keySource,
          presetName: entry.presetName,
          hasSavedKey: entry.hasSavedKey,
          contextLimit: entry.contextLimit,
          discovered: discoveredLookup.get(key) ?? discoveredByProviderModel.get(`${entry.provider}::${entry.model}`),
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
    const endpoint = isHosted ? undefined : discoveredEndpointsByProvider[provider.id];
    for (const model of discoveredByProvider[provider.id] ?? []) {
      if (provider.id === "gemini" && !isChatCapableGeminiModel(model)) continue;
      const key = modelIdentityKey(provider.id, model.id, endpoint?.baseUrl);
      if (configuredKeys.has(key) || seenDiscovered.has(key)) continue;
      seenDiscovered.add(key);
      const item = makeModelItem({
        entryKey: `disc:${key}`,
        provider: provider.id as LLMProvider,
        model: model.id,
        baseUrl: endpoint?.baseUrl,
        keySource: endpoint?.keySource,
        presetName: endpoint?.presetName,
        hasSavedKey: endpoint?.hasSavedKey,
        discovered: model,
        isConfigured: false
      });
      if (matchesMultiWordQuery(item, words)) {
        discoveredFlat.push(item);
      }
    }
  }

  // Split directly by tool capability without raw model-ID deduplication so
  // two providers publishing the same model ID (e.g. OpenRouter and Groq for
  // `openai/gpt-oss-20b`) both stay visible in All-provider search.
  const recommended: PickerModelItem[] = [];
  const available: PickerModelItem[] = [];
  for (const item of discoveredFlat) {
    if (item.toolCapable) recommended.push(item);
    else available.push(item);
  }
  recommended.sort((a, b) => Number(b.free) - Number(a.free));

  return {
    configured,
    recommended,
    available
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
}): {
  provider: string;
  keySource: KeySource;
  apiKey?: string;
  baseUrl?: string;
  presetName?: string;
  hasSavedKey?: boolean;
} {
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
      baseUrl: chainMatch?.baseUrl,
      presetName: chainMatch?.presetName,
      hasSavedKey: chainMatch?.hasSavedKey
    };
  }

  const hasSaved = hasUiKeyFn(provider.id);
  return {
    provider: provider.id,
    keySource: hasSaved ? "ui" : (chainMatch?.keySource ?? "env"),
    apiKey: hasSaved ? savedUiKeyFn(provider.id) : undefined,
    baseUrl: chainMatch?.baseUrl,
    presetName: chainMatch?.presetName,
    hasSavedKey: chainMatch?.hasSavedKey
  };
}

/**
 * Updates `chatChain[0]` cleanly in local mode without wiping backup entries (`chatChain.slice(1)`),
 * preserving the selected entry's connection settings (endpoint, keySource, preset) and
 * remembering/restoring per-model reasoning effort across switches.
 */
export function applyModelSwitchLocal(
  prevConfig: ClientConfig,
  selection: {
    sourceEntryId?: string;
    provider: LLMProvider;
    model: string;
    baseUrl?: string;
    keySource?: KeySource;
    presetName?: string;
    hasSavedKey?: boolean;
    contextLimit?: number;
    supportedParameters?: string[];
    reasoningEffort?: ReasoningEffort;
    credentials?: CredentialAvailability | null;
    hasUiKeyFn?: (provider: string) => boolean;
  }
): ClientConfig {
  const {
    sourceEntryId,
    provider,
    model,
    baseUrl,
    keySource,
    presetName,
    hasSavedKey,
    contextLimit,
    supportedParameters,
    reasoningEffort,
    credentials,
    hasUiKeyFn = hasUiKey
  } = selection;

  const existingPrimary = prevConfig.chatChain[0];
  const backups = prevConfig.chatChain.slice(1);

  // Remember the outgoing primary's reasoning effort before switching away so
  // switching back restores it even if it was configured in Settings.
  if (existingPrimary?.model && existingPrimary.reasoningEffort !== undefined) {
    setLocalModelReasoningEffort(
      existingPrimary.provider,
      existingPrimary.model,
      existingPrimary.reasoningEffort,
      existingPrimary.baseUrl
    );
  }

  const allEntries = [...prevConfig.chatChain, ...(prevConfig.subagentChain ?? [])];
  const matchingExisting =
    (sourceEntryId ? allEntries.find((entry) => entry.id === sourceEntryId) : undefined) ??
    (baseUrl !== undefined
      ? allEntries.find((entry) => entry.provider === provider && (entry.baseUrl ?? "") === baseUrl)
      : undefined) ??
    (existingPrimary?.provider === provider ? existingPrimary : undefined) ??
    prevConfig.chatChain.find((entry) => entry.provider === provider) ??
    prevConfig.subagentChain?.find((entry) => entry.provider === provider);

  const resolvedBaseUrl = baseUrl !== undefined ? baseUrl : matchingExisting?.baseUrl;
  const resolvedPresetName = presetName !== undefined ? presetName : matchingExisting?.presetName;
  const resolvedHasSavedKey = hasSavedKey !== undefined ? hasSavedKey : matchingExisting?.hasSavedKey;

  const canReason = supportsReasoning(provider, model, { supportedParameters });
  const isSameEntry =
    existingPrimary?.provider === provider &&
    existingPrimary?.model === model &&
    (existingPrimary.baseUrl ?? "") === (resolvedBaseUrl ?? "");

  let nextEffort: ReasoningEffort | undefined;
  if (canReason) {
    if (reasoningEffort !== undefined) {
      setLocalModelReasoningEffort(provider, model, reasoningEffort, resolvedBaseUrl);
      nextEffort = reasoningEffort;
    } else if (isSameEntry) {
      nextEffort = existingPrimary.reasoningEffort;
    } else {
      nextEffort =
        getLocalModelReasoningEffort(provider, model, resolvedBaseUrl) ??
        (matchingExisting?.model === model ? matchingExisting.reasoningEffort : undefined);
    }
  }

  const resolvedKeySource: KeySource =
    keySource ??
    matchingExisting?.keySource ??
    (isLocalProvider(provider)
      ? hasUiKeyFn(provider)
        ? "ui"
        : "none"
      : hasUiKeyFn(provider)
        ? "ui"
        : credentials?.llm?.[provider]
          ? "env"
          : "ui");

  const resolvedContextLimit =
    contextLimit ?? (isSameEntry ? existingPrimary.contextLimit : undefined);

  const reusePrimaryId =
    existingPrimary?.provider === provider &&
    (existingPrimary.baseUrl ?? "") === (resolvedBaseUrl ?? "");

  const nextPrimary: ChainEntry = {
    id: reusePrimaryId ? existingPrimary.id : `chat-${provider}-${Date.now()}`,
    provider,
    model,
    keySource: resolvedKeySource,
    ...(resolvedBaseUrl ? { baseUrl: resolvedBaseUrl } : {}),
    ...(resolvedPresetName ? { presetName: resolvedPresetName } : {}),
    ...(resolvedHasSavedKey !== undefined ? { hasSavedKey: resolvedHasSavedKey } : {}),
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
 * Updates `chatChain[0].reasoningEffort` in local mode without touching backup entries,
 * and remembers the choice per `(provider, baseUrl, model)` for future switches.
 */
export function applyReasoningSwitchLocal(
  prevConfig: ClientConfig,
  effort?: ReasoningEffort
): ClientConfig {
  if (prevConfig.chatChain.length === 0) return prevConfig;
  const [primary, ...backups] = prevConfig.chatChain;
  setLocalModelReasoningEffort(primary.provider, primary.model, effort, primary.baseUrl);
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
 * Persists a hosted-mode model switch into the BYOK store using the single
 * model-scoped reasoning preference (migrating any legacy effort onto the
 * outgoing model before switching).
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
    setByokModelReasoningEffort(provider, model, undefined, persist);
    return;
  }

  if (reasoningEffort !== undefined) {
    setByokModelReasoningEffort(provider, model, reasoningEffort, persist);
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
  setByokModelReasoningEffort(provider, model, effort, persist);
}
