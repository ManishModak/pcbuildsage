/**
 * src/lib/llm/client-byok-store.ts
 *
 * Ephemeral client-side BYOK (Bring Your Own Key) credential store.
 * Stores user-provided provider keys (e.g. Gemini, OpenRouter) in sessionStorage
 * by default (scoped to tab lifetime). Keys are persisted in localStorage ONLY
 * if the user explicitly requests browser persistence ("Remember for this browser").
 *
 * Keys travel to the server exclusively via per-request HTTP headers and are
 * never logged, stored in server databases, or leaked into response payloads.
 */

import type { ReasoningEffort } from "@/types/config";
import { LLM_PROVIDER_IDS, getProvider } from "@/lib/llm/providers";

export const BYOK_PREFIX = "pcbuildsage_byok_";
export const BYOK_COLON_PREFIX = "pcbuildsage:byok:";

export const DEFAULT_BYOK_PROVIDERS: readonly string[] = LLM_PROVIDER_IDS;

let customSessionStorage: Storage | undefined;
let customLocalStorage: Storage | undefined;
const byokListeners = new Set<() => void>();
let byokStorageListenerRegistered = false;

function handleByokStorageEvent(event: StorageEvent): void {
  if (!event.key || event.key.startsWith(BYOK_PREFIX) || event.key.startsWith(BYOK_COLON_PREFIX)) {
    notifyByokListeners();
  }
}

function ensureByokStorageListener(): void {
  if (!byokStorageListenerRegistered && typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("storage", handleByokStorageEvent);
    byokStorageListenerRegistered = true;
  }
}

function notifyByokListeners(): void {
  for (const listener of byokListeners) {
    try {
      listener();
    } catch {
      // Ignore individual subscriber callback errors
    }
  }
}

/**
 * Subscribe to BYOK key, model, active provider, or reasoning-effort changes.
 * Returns an unsubscribe callback.
 */
export function subscribeByokStore(listener: () => void): () => void {
  byokListeners.add(listener);
  ensureByokStorageListener();
  return () => {
    byokListeners.delete(listener);
    if (byokListeners.size === 0 && byokStorageListenerRegistered && typeof window !== "undefined") {
      window.removeEventListener("storage", handleByokStorageEvent);
      byokStorageListenerRegistered = false;
    }
  };
}

/**
 * Configure custom storage backends (primarily for unit testing environments).
 */
export function setByokStorageForTesting(session?: Storage, local?: Storage): void {
  customSessionStorage = session;
  customLocalStorage = local;
}

/**
 * Reset test storage backends.
 */
export function resetByokStoreForTesting(): void {
  byokListeners.clear();
  customSessionStorage = undefined;
  customLocalStorage = undefined;
  if (byokStorageListenerRegistered && typeof window !== "undefined") {
    window.removeEventListener("storage", handleByokStorageEvent);
    byokStorageListenerRegistered = false;
  }
}

function getSessionStorage(): Storage | undefined {
  if (customSessionStorage) return customSessionStorage;
  try {
    if (typeof window !== "undefined" && window.sessionStorage) {
      return window.sessionStorage;
    }
    if (typeof globalThis !== "undefined" && (globalThis as unknown as { sessionStorage?: Storage }).sessionStorage) {
      return (globalThis as unknown as { sessionStorage: Storage }).sessionStorage;
    }
  } catch {
    // Restricted environment or private browsing
  }
  return undefined;
}

function getLocalStorage(): Storage | undefined {
  if (customLocalStorage) return customLocalStorage;
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      return window.localStorage;
    }
    if (typeof globalThis !== "undefined" && (globalThis as unknown as { localStorage?: Storage }).localStorage) {
      return (globalThis as unknown as { localStorage: Storage }).localStorage;
    }
  } catch {
    // Restricted environment or private browsing
  }
  return undefined;
}

function normalizeProvider(provider: string): string {
  return provider.trim().toLowerCase().replace(/_/g, "-");
}

function primaryKey(provider: string): string {
  return `${BYOK_PREFIX}${normalizeProvider(provider)}`;
}

function colonKey(provider: string): string {
  return `${BYOK_COLON_PREFIX}${normalizeProvider(provider)}`;
}

/**
 * Discovers all providers that currently have keys stored in either
 * sessionStorage or localStorage.
 */
export function listStoredProviders(): string[] {
  const providers = new Set<string>(DEFAULT_BYOK_PROVIDERS);

  const scan = (storage?: Storage) => {
    if (!storage) return;
    try {
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (!key) continue;
        if (key.startsWith(BYOK_PREFIX)) {
          providers.add(key.slice(BYOK_PREFIX.length));
        } else if (key.startsWith(BYOK_COLON_PREFIX)) {
          providers.add(key.slice(BYOK_COLON_PREFIX.length));
        }
      }
    } catch {
      // Ignore enumeration issues
    }
  };

  scan(getSessionStorage());
  scan(getLocalStorage());

  return Array.from(providers);
}

/**
 * Retrieves a stored BYOK key for a given provider.
 * Checks ephemeral sessionStorage first, falling back to localStorage if persisted.
 */
export function getByokKey(provider: string): string | undefined {
  if (!provider) return undefined;
  const pKey = primaryKey(provider);
  const cKey = colonKey(provider);

  const session = getSessionStorage();
  if (session) {
    try {
      const val = session.getItem(pKey) ?? session.getItem(cKey);
      if (val && val.trim().length > 0) {
        return val.trim();
      }
    } catch {
      // ignore
    }
  }

  const local = getLocalStorage();
  if (local) {
    try {
      const val = local.getItem(pKey) ?? local.getItem(cKey);
      if (val && val.trim().length > 0) {
        return val.trim();
      }
    } catch {
      // ignore
    }
  }

  return undefined;
}

/**
 * Checks whether the stored BYOK key for the provider is persisted in localStorage
 * (as opposed to being stored only in ephemeral sessionStorage).
 */
export function isByokKeyPersistent(provider: string): boolean {
  if (!provider) return false;
  const local = getLocalStorage();
  if (!local) return false;
  try {
    const val = local.getItem(primaryKey(provider)) ?? local.getItem(colonKey(provider));
    return Boolean(val && val.trim().length > 0);
  } catch {
    return false;
  }
}

/**
 * Stores a user-provided API key for a provider.
 * Keys are saved into ephemeral sessionStorage by default.
 * Only saved to localStorage if `persist === true`.
 * Passing an empty or whitespace key clears the key.
 */
export function setByokKey(provider: string, key: string, persist = false): void {
  if (!provider) return;
  const trimmed = (key ?? "").trim();
  if (!trimmed) {
    clearByokKey(provider);
    return;
  }

  const pKey = primaryKey(provider);

  const session = getSessionStorage();
  if (session) {
    try {
      session.setItem(pKey, trimmed);
    } catch {
      // ignore quota / disabled storage
    }
  }

  const local = getLocalStorage();
  if (local) {
    try {
      if (persist) {
        local.setItem(pKey, trimmed);
      } else {
        // If user does not choose to persist, purge any previous persistent entry
        local.removeItem(pKey);
        local.removeItem(colonKey(provider));
      }
    } catch {
      // ignore
    }
  }
  notifyByokListeners();
}

/**
 * Removes a stored BYOK key from both sessionStorage and localStorage.
 */
export function clearByokKey(provider: string): void {
  if (!provider) return;
  const pKey = primaryKey(provider);
  const cKey = colonKey(provider);

  const session = getSessionStorage();
  if (session) {
    try {
      session.removeItem(pKey);
      session.removeItem(cKey);
    } catch {
      // ignore
    }
  }

  const local = getLocalStorage();
  if (local) {
    try {
      local.removeItem(pKey);
      local.removeItem(cKey);
    } catch {
      // ignore
    }
  }
  notifyByokListeners();
}

/**
 * Purges all stored BYOK keys across both storage tiers.
 */
export function clearAllByokKeys(): void {
  const purge = (storage?: Storage) => {
    if (!storage) return;
    try {
      const toRemove: string[] = [];
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (key && (key.startsWith(BYOK_PREFIX) || key.startsWith(BYOK_COLON_PREFIX))) {
          toRemove.push(key);
        }
      }
      for (const k of toRemove) {
        storage.removeItem(k);
      }
    } catch {
      // ignore
    }
  };

  purge(getSessionStorage());
  purge(getLocalStorage());
  notifyByokListeners();
}

/**
 * Checks if a valid non-empty BYOK key exists for a provider.
 */
export function hasByokKey(provider: string): boolean {
  return Boolean(getByokKey(provider));
}

/**
 * Masks an API key for safe UI display (e.g. "AIza...4X9Z").
 * Preserves the first 4 and last 4 characters when sufficiently long.
 */
export function maskApiKey(key: string): string {
  if (!key || typeof key !== "string") return "";
  const trimmed = key.trim();
  if (trimmed.length === 0) return "";
  if (trimmed.length > 8) {
    return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
  }
  if (trimmed.length >= 4) {
    return `${trimmed.slice(0, 2)}...${trimmed.slice(-2)}`;
  }
  return `...${trimmed}`;
}

/**
 * Injects stored BYOK keys into request headers.
 * Attaches both `x-pcbuildsage-api-key-<provider>` and `x-<provider>-api-key` headers.
 * Safely supports Headers instances, [string, string][] arrays, or plain records.
 * Omit keys that are empty or whitespace-only.
 */
export function injectByokHeaders(headers: HeadersInit = {}): HeadersInit {
  const byokHeaders: Record<string, string> = {};

  const providers = listStoredProviders();
  for (const provider of providers) {
    const key = getByokKey(provider);
    if (!key || !key.trim()) continue;

    const normalized = normalizeProvider(provider);
    const trimmedKey = key.trim();

    byokHeaders[`x-pcbuildsage-api-key-${normalized}`] = trimmedKey;
    byokHeaders[`x-${normalized}-api-key`] = trimmedKey;
  }

  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    const result = new Headers(headers);
    for (const [name, val] of Object.entries(byokHeaders)) {
      if (!result.has(name)) {
        result.set(name, val);
      }
    }
    return result;
  }

  if (Array.isArray(headers)) {
    const existingNames = new Set(headers.map(([name]) => name.toLowerCase()));
    const result = [...headers];
    for (const [name, val] of Object.entries(byokHeaders)) {
      if (!existingNames.has(name.toLowerCase())) {
        result.push([name, val]);
      }
    }
    return result;
  }

  return {
    ...byokHeaders,
    ...(headers as Record<string, string>)
  };
}

const MODEL_SUFFIX = "_model";
const ACTIVE_PROVIDER_KEY = "pcbuildsage_byok_active_provider";

/**
 * Retrieves the user-configured model for a given BYOK provider.
 */
export function getByokModel(provider: string): string | undefined {
  const norm = normalizeProvider(provider);
  const session = getSessionStorage();
  const fromSession = session?.getItem(`${BYOK_PREFIX}${norm}${MODEL_SUFFIX}`);
  if (fromSession && fromSession.trim()) return fromSession.trim();

  const local = getLocalStorage();
  const fromLocal = local?.getItem(`${BYOK_PREFIX}${norm}${MODEL_SUFFIX}`);
  if (fromLocal && fromLocal.trim()) return fromLocal.trim();

  return undefined;
}

/**
 * Stores the chosen model for a given BYOK provider.
 * If a legacy provider-level reasoning effort exists and no per-model efforts
 * have been recorded yet, migrates that legacy effort onto the model that was
 * active before the switch so the newly selected model does not inherit it.
 */
export function setByokModel(provider: string, model: string, persist = false): void {
  const norm = normalizeProvider(provider);
  const trimmed = model.trim();
  const key = `${BYOK_PREFIX}${norm}${MODEL_SUFFIX}`;
  if (!trimmed) {
    clearByokModel(provider);
    return;
  }

  const previousModel = getByokModel(provider) ?? getProvider(norm)?.defaultModel;
  if (previousModel && previousModel !== trimmed) {
    migrateLegacyReasoningEffortToModel(provider, previousModel, persist);
  }

  try {
    getSessionStorage()?.setItem(key, trimmed);
  } catch {
    // Quota or security error
  }
  if (persist) {
    try {
      getLocalStorage()?.setItem(key, trimmed);
    } catch {
      // Quota or security error
    }
  } else {
    try {
      getLocalStorage()?.removeItem(key);
    } catch {
      // Ignore
    }
  }
  notifyByokListeners();
}

/**
 * Clears the chosen model for a given BYOK provider.
 */
export function clearByokModel(provider: string): void {
  const norm = normalizeProvider(provider);
  const key = `${BYOK_PREFIX}${norm}${MODEL_SUFFIX}`;
  try {
    getSessionStorage()?.removeItem(key);
    getLocalStorage()?.removeItem(key);
  } catch {
    // Ignore
  }
  notifyByokListeners();
}

const REASONING_EFFORT_SUFFIX = "_reasoning_effort";
const MODEL_EFFORT_SUFFIX = "_model_efforts";

type StoredModelEffort = ReasoningEffort | "default";

function readLegacyReasoningEffort(provider: string): ReasoningEffort | undefined {
  const norm = normalizeProvider(provider);
  const session = getSessionStorage();
  const fromSession = session?.getItem(`${BYOK_PREFIX}${norm}${REASONING_EFFORT_SUFFIX}`);
  if (fromSession && (fromSession === "low" || fromSession === "medium" || fromSession === "high")) {
    return fromSession as ReasoningEffort;
  }

  const local = getLocalStorage();
  const fromLocal = local?.getItem(`${BYOK_PREFIX}${norm}${REASONING_EFFORT_SUFFIX}`);
  if (fromLocal && (fromLocal === "low" || fromLocal === "medium" || fromLocal === "high")) {
    return fromLocal as ReasoningEffort;
  }

  return undefined;
}

function clearLegacyReasoningEffortRaw(provider: string): void {
  const norm = normalizeProvider(provider);
  const key = `${BYOK_PREFIX}${norm}${REASONING_EFFORT_SUFFIX}`;
  try {
    getSessionStorage()?.removeItem(key);
    getLocalStorage()?.removeItem(key);
  } catch {
    // Ignore
  }
}

function readModelEfforts(provider: string): Record<string, StoredModelEffort> {
  const norm = normalizeProvider(provider);
  const key = `${BYOK_PREFIX}${norm}${MODEL_EFFORT_SUFFIX}`;
  const raw = getSessionStorage()?.getItem(key) ?? getLocalStorage()?.getItem(key);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const clean: Record<string, StoredModelEffort> = {};
    for (const [m, v] of Object.entries(parsed)) {
      if (v === "low" || v === "medium" || v === "high" || v === "default") clean[m] = v;
    }
    return clean;
  } catch {
    return {};
  }
}

function writeModelEfforts(provider: string, map: Record<string, StoredModelEffort>, persist: boolean): void {
  const norm = normalizeProvider(provider);
  const key = `${BYOK_PREFIX}${norm}${MODEL_EFFORT_SUFFIX}`;
  const serialized = JSON.stringify(map);
  try {
    getSessionStorage()?.setItem(key, serialized);
  } catch {
    // Ignore
  }
  if (persist) {
    try {
      getLocalStorage()?.setItem(key, serialized);
    } catch {
      // Ignore
    }
  } else {
    try {
      getLocalStorage()?.removeItem(key);
    } catch {
      // Ignore
    }
  }
}

function migrateLegacyReasoningEffortToModel(provider: string, previousModel: string, persist: boolean): void {
  const legacy = readLegacyReasoningEffort(provider);
  if (!legacy) return;
  const map = readModelEfforts(provider);
  if (Object.keys(map).length === 0) {
    map[previousModel] = legacy;
    writeModelEfforts(provider, map, persist || isByokKeyPersistent(provider));
  }
  clearLegacyReasoningEffortRaw(provider);
}

/**
 * Retrieves the user-configured reasoning effort for a given BYOK provider's
 * active model (or legacy provider-level effort if no model is stored yet).
 */
export function getByokReasoningEffort(provider: string): ReasoningEffort | undefined {
  if (!provider) return undefined;
  const currentModel = getByokModel(provider);
  if (currentModel) {
    return getByokModelReasoningEffort(provider, currentModel);
  }
  const defaultModel = getProvider(normalizeProvider(provider))?.defaultModel;
  if (defaultModel && Object.keys(readModelEfforts(provider)).length > 0) {
    return getByokModelReasoningEffort(provider, defaultModel);
  }
  return readLegacyReasoningEffort(provider);
}

/**
 * Stores the chosen reasoning effort for a given BYOK provider's active model.
 * When a model is already configured for this provider, writes directly to the
 * single model-scoped preference store so Settings and the picker never drift.
 */
export function setByokReasoningEffort(provider: string, effort?: ReasoningEffort, persist = false): void {
  if (!provider) return;
  const currentModel = getByokModel(provider);
  if (currentModel) {
    setByokModelReasoningEffort(provider, currentModel, effort, persist);
    return;
  }

  const norm = normalizeProvider(provider);
  const key = `${BYOK_PREFIX}${norm}${REASONING_EFFORT_SUFFIX}`;
  if (!effort) {
    clearByokReasoningEffort(provider);
    return;
  }
  try {
    getSessionStorage()?.setItem(key, effort);
  } catch {
    // Quota or security error
  }
  if (persist) {
    try {
      getLocalStorage()?.setItem(key, effort);
    } catch {
      // Quota or security error
    }
  } else {
    try {
      getLocalStorage()?.removeItem(key);
    } catch {
      // Ignore
    }
  }
  notifyByokListeners();
}

/**
 * Clears all reasoning effort preferences (both per-model map and legacy key)
 * for a given BYOK provider.
 */
export function clearByokReasoningEffort(provider: string): void {
  const norm = normalizeProvider(provider);
  const legacyKey = `${BYOK_PREFIX}${norm}${REASONING_EFFORT_SUFFIX}`;
  const mapKey = `${BYOK_PREFIX}${norm}${MODEL_EFFORT_SUFFIX}`;
  try {
    getSessionStorage()?.removeItem(legacyKey);
    getLocalStorage()?.removeItem(legacyKey);
    getSessionStorage()?.removeItem(mapKey);
    getLocalStorage()?.removeItem(mapKey);
  } catch {
    // Ignore
  }
  notifyByokListeners();
}

/**
 * Retrieves the active BYOK provider (e.g. "gemini" or "openrouter").
 */
export function getActiveByokProvider(): string | undefined {
  const session = getSessionStorage();
  const fromSession = session?.getItem(ACTIVE_PROVIDER_KEY);
  if (fromSession && fromSession.trim()) return fromSession.trim();

  const local = getLocalStorage();
  const fromLocal = local?.getItem(ACTIVE_PROVIDER_KEY);
  if (fromLocal && fromLocal.trim()) return fromLocal.trim();

  return undefined;
}

/**
 * Sets the active BYOK provider.
 */
export function setActiveByokProvider(provider: string, persist = false): void {
  const trimmed = provider.trim().toLowerCase();
  try {
    getSessionStorage()?.setItem(ACTIVE_PROVIDER_KEY, trimmed);
  } catch {
    // Ignore
  }
  if (persist) {
    try {
      getLocalStorage()?.setItem(ACTIVE_PROVIDER_KEY, trimmed);
    } catch {
      // Ignore
    }
  }
  notifyByokListeners();
}

/**
 * Returns the remembered per-model reasoning effort for a BYOK (provider, model).
 * Falls back to a legacy provider-level effort only when no per-model choices exist yet.
 */
export function getByokModelReasoningEffort(provider: string, model: string): ReasoningEffort | undefined {
  if (!provider || !model) return undefined;
  const map = readModelEfforts(provider);
  if (Object.prototype.hasOwnProperty.call(map, model)) {
    const stored = map[model];
    return stored === "default" ? undefined : stored;
  }
  if (Object.keys(map).length === 0) {
    return readLegacyReasoningEffort(provider);
  }
  return undefined;
}

/**
 * Stores per-model reasoning effort as the single canonical reasoning preference
 * for `(provider, model)` in the BYOK store.
 */
export function setByokModelReasoningEffort(
  provider: string,
  model: string,
  effort?: ReasoningEffort,
  persist = false
): void {
  if (!provider || !model) return;
  const norm = normalizeProvider(provider);
  const map = readModelEfforts(provider);
  if (Object.keys(map).length === 0) {
    const legacy = readLegacyReasoningEffort(provider);
    const activeModel = getByokModel(provider) ?? getProvider(norm)?.defaultModel;
    if (legacy && activeModel && activeModel !== model) {
      map[activeModel] = legacy;
    }
  }
  map[model] = effort ?? "default";
  writeModelEfforts(provider, map, persist);
  clearLegacyReasoningEffortRaw(provider);
  notifyByokListeners();
}

