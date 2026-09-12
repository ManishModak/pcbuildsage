/**
 * src/lib/market/client-market-store.ts
 *
 * Client-side Market Preference store.
 * Manages persisting MarketPreference (countryCode, currencyCode, locale)
 * in localStorage with runtime validation and reactive listener subscriptions.
 */

export interface MarketPreference {
  countryCode: string;
  currencyCode: string;
  locale: string;
}

export const DEFAULT_MARKET_PREFERENCE: Readonly<MarketPreference> = Object.freeze({
  countryCode: "IN",
  currencyCode: "INR",
  locale: "en-IN"
});

export const MARKET_STORAGE_KEY = "pcbuildsage:market_preference";
export const LEGACY_MARKET_STORAGE_KEY = "pcbuildsage_market_preference";

const COUNTRY_CODE_REGEX = /^[A-Z]{2}$/;
const CURRENCY_CODE_REGEX = /^[A-Z]{3}$/;

type MarketPreferenceListener = (pref: MarketPreference) => void;

const listeners = new Set<MarketPreferenceListener>();
let storageListenerRegistered = false;
let customStorage: Storage | undefined;

/**
 * Configure a custom Storage backend (primarily used for unit testing).
 */
export function setLocalStorageForTesting(storage?: Storage): void {
  customStorage = storage;
}

/**
 * Reset in-memory subscribers and custom storage backend (for tests).
 */
export function resetMarketStoreForTesting(): void {
  listeners.clear();
  customStorage = undefined;
  if (storageListenerRegistered && typeof window !== "undefined") {
    window.removeEventListener("storage", handleStorageEvent);
    storageListenerRegistered = false;
  }
}

function getStorage(): Storage | undefined {
  if (customStorage) return customStorage;
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      return window.localStorage;
    }
    if (typeof globalThis !== "undefined" && (globalThis as unknown as { localStorage?: Storage }).localStorage) {
      return (globalThis as unknown as { localStorage: Storage }).localStorage;
    }
  } catch {
    // Storage access may throw in restricted iframes or disabled cookies
  }
  return undefined;
}

function handleStorageEvent(event: StorageEvent): void {
  if (event.key === MARKET_STORAGE_KEY || event.key === LEGACY_MARKET_STORAGE_KEY) {
    const current = getMarketPreference();
    notifyListeners(current);
  }
}

function ensureStorageListener(): void {
  if (!storageListenerRegistered && typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("storage", handleStorageEvent);
    storageListenerRegistered = true;
  }
}

function notifyListeners(pref: MarketPreference): void {
  for (const listener of listeners) {
    try {
      listener(pref);
    } catch {
      // Ignore individual subscriber callback errors
    }
  }
}

/**
 * Validates and normalizes market preference object safely with fallbacks.
 */
export function validateMarketPreference(raw: unknown): MarketPreference {
  if (!raw || typeof raw !== "object") {
    return { ...DEFAULT_MARKET_PREFERENCE };
  }

  const obj = raw as Record<string, unknown>;

  let countryCode = DEFAULT_MARKET_PREFERENCE.countryCode;
  if (typeof obj.countryCode === "string") {
    const code = obj.countryCode.trim().toUpperCase();
    if (COUNTRY_CODE_REGEX.test(code)) {
      countryCode = code;
    }
  }

  let currencyCode = DEFAULT_MARKET_PREFERENCE.currencyCode;
  if (typeof obj.currencyCode === "string") {
    const curr = obj.currencyCode.trim().toUpperCase();
    if (CURRENCY_CODE_REGEX.test(curr)) {
      currencyCode = curr;
    }
  }

  let locale = DEFAULT_MARKET_PREFERENCE.locale;
  if (typeof obj.locale === "string" && obj.locale.trim()) {
    locale = obj.locale.trim().replace(/_/g, "-");
  }

  return { countryCode, currencyCode, locale };
}

/**
 * Retrieves the client's market preference from localStorage.
 * Falls back safely to defaults (IN / INR / en-IN) if storage is empty or corrupted.
 */
export function getMarketPreference(): MarketPreference {
  const storage = getStorage();
  if (!storage) return { ...DEFAULT_MARKET_PREFERENCE };

  try {
    const raw = storage.getItem(MARKET_STORAGE_KEY) ?? storage.getItem(LEGACY_MARKET_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_MARKET_PREFERENCE };
    return validateMarketPreference(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_MARKET_PREFERENCE };
  }
}

/**
 * Updates client market preference in localStorage.
 * Validates countryCode (2 uppercase letters) and currencyCode (3 uppercase letters).
 * Notifies all active subscribers upon modification.
 */
export function setMarketPreference(pref: Partial<MarketPreference>): MarketPreference {
  if (!pref || typeof pref !== "object") {
    return getMarketPreference();
  }

  const current = getMarketPreference();
  let countryCode = current.countryCode;
  let currencyCode = current.currencyCode;
  let locale = current.locale;

  if (pref.countryCode !== undefined) {
    if (typeof pref.countryCode !== "string") {
      throw new Error("Invalid countryCode: must be a string");
    }
    const code = pref.countryCode.trim().toUpperCase();
    if (!COUNTRY_CODE_REGEX.test(code)) {
      throw new Error(`Invalid countryCode "${pref.countryCode}": must be an uppercase 2-letter ISO code.`);
    }
    countryCode = code;
  }

  if (pref.currencyCode !== undefined) {
    if (typeof pref.currencyCode !== "string") {
      throw new Error("Invalid currencyCode: must be a string");
    }
    const curr = pref.currencyCode.trim().toUpperCase();
    if (!CURRENCY_CODE_REGEX.test(curr)) {
      throw new Error(`Invalid currencyCode "${pref.currencyCode}": must be an uppercase 3-letter ISO code.`);
    }
    currencyCode = curr;
  }

  if (pref.locale !== undefined) {
    if (typeof pref.locale !== "string" || !pref.locale.trim()) {
      throw new Error(`Invalid locale "${pref.locale}": must be a non-empty string.`);
    }
    locale = pref.locale.trim().replace(/_/g, "-");
  }

  const next: MarketPreference = { countryCode, currencyCode, locale };

  const storage = getStorage();
  if (storage) {
    try {
      storage.setItem(MARKET_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Ignore quota or disabled storage write errors
    }
  }

  notifyListeners(next);
  return next;
}

/**
 * Subscribes a listener to market preference updates.
 * Returns an unsubscribe callback.
 */
export function subscribeMarketPreference(listener: MarketPreferenceListener): () => void {
  listeners.add(listener);
  ensureStorageListener();

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && storageListenerRegistered && typeof window !== "undefined") {
      window.removeEventListener("storage", handleStorageEvent);
      storageListenerRegistered = false;
    }
  };
}
