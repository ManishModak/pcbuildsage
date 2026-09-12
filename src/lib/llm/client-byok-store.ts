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

export const BYOK_PREFIX = "pcbuildsage_byok_";
export const BYOK_COLON_PREFIX = "pcbuildsage:byok:";

export const DEFAULT_BYOK_PROVIDERS = [
  "gemini",
  "groq",
  "openrouter",
  "openai-compatible",
  "ollama"
] as const;

let customSessionStorage: Storage | undefined;
let customLocalStorage: Storage | undefined;

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
  customSessionStorage = undefined;
  customLocalStorage = undefined;
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
 */
export function setByokModel(provider: string, model: string, persist = false): void {
  const norm = normalizeProvider(provider);
  const trimmed = model.trim();
  const key = `${BYOK_PREFIX}${norm}${MODEL_SUFFIX}`;
  if (!trimmed) {
    clearByokModel(provider);
    return;
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
  }
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
}

const REASONING_EFFORT_SUFFIX = "_reasoning_effort";

/**
 * Retrieves the user-configured reasoning effort for a given BYOK provider.
 */
export function getByokReasoningEffort(provider: string): ReasoningEffort | undefined {
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

/**
 * Stores the chosen reasoning effort for a given BYOK provider.
 */
export function setByokReasoningEffort(provider: string, effort?: ReasoningEffort, persist = false): void {
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
  }
}

/**
 * Clears the chosen reasoning effort for a given BYOK provider.
 */
export function clearByokReasoningEffort(provider: string): void {
  const norm = normalizeProvider(provider);
  const key = `${BYOK_PREFIX}${norm}${REASONING_EFFORT_SUFFIX}`;
  try {
    getSessionStorage()?.removeItem(key);
    getLocalStorage()?.removeItem(key);
  } catch {
    // Ignore
  }
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
}

