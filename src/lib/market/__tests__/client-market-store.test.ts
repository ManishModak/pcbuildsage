import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MARKET_PREFERENCE,
  MARKET_STORAGE_KEY,
  LEGACY_MARKET_STORAGE_KEY,
  getMarketPreference,
  setMarketPreference,
  subscribeMarketPreference,
  validateMarketPreference,
  setLocalStorageForTesting,
  resetMarketStoreForTesting,
  type MarketPreference
} from "../client-market-store";

class MockStorage implements Storage {
  private store = new Map<string, string>();

  get length(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
}

describe("client-market-store", () => {
  let mockStorage: MockStorage;

  beforeEach(() => {
    mockStorage = new MockStorage();
    setLocalStorageForTesting(mockStorage);
    resetMarketStoreForTesting();
    setLocalStorageForTesting(mockStorage);
  });

  describe("getMarketPreference", () => {
    it("returns default market preference (IN / INR / en-IN) when storage is empty", () => {
      const pref = getMarketPreference();
      expect(pref).toEqual({
        countryCode: "IN",
        currencyCode: "INR",
        locale: "en-IN"
      });
      expect(pref).toEqual(DEFAULT_MARKET_PREFERENCE);
    });

    it("reads and parses valid market preference from localStorage", () => {
      const stored: MarketPreference = {
        countryCode: "US",
        currencyCode: "USD",
        locale: "en-US"
      };
      mockStorage.setItem(MARKET_STORAGE_KEY, JSON.stringify(stored));

      const pref = getMarketPreference();
      expect(pref).toEqual(stored);
    });

    it("falls back to legacy storage key if primary is absent", () => {
      const stored: MarketPreference = {
        countryCode: "UK",
        currencyCode: "GBP",
        locale: "en-GB"
      };
      mockStorage.setItem(LEGACY_MARKET_STORAGE_KEY, JSON.stringify(stored));

      const pref = getMarketPreference();
      expect(pref).toEqual(stored);
    });

    it("handles corrupted JSON safely by falling back to defaults", () => {
      mockStorage.setItem(MARKET_STORAGE_KEY, "INVALID_JSON{[[");
      const pref = getMarketPreference();
      expect(pref).toEqual(DEFAULT_MARKET_PREFERENCE);
    });

    it("sanitizes individual invalid fields from storage, falling back to defaults", () => {
      mockStorage.setItem(
        MARKET_STORAGE_KEY,
        JSON.stringify({
          countryCode: "TOO_LONG",
          currencyCode: "1234",
          locale: ""
        })
      );
      const pref = getMarketPreference();
      expect(pref.countryCode).toBe("IN");
      expect(pref.currencyCode).toBe("INR");
      expect(pref.locale).toBe("en-IN");
    });
  });

  describe("setMarketPreference", () => {
    it("updates full market preference and persists to localStorage", () => {
      const updated = setMarketPreference({
        countryCode: "DE",
        currencyCode: "EUR",
        locale: "de-DE"
      });

      expect(updated).toEqual({
        countryCode: "DE",
        currencyCode: "EUR",
        locale: "de-DE"
      });

      const raw = mockStorage.getItem(MARKET_STORAGE_KEY);
      expect(raw).not.toBeNull();
      expect(JSON.parse(raw!)).toEqual(updated);
    });

    it("supports partial updates preserving unmodified fields", () => {
      setMarketPreference({
        countryCode: "CA",
        currencyCode: "CAD",
        locale: "en-CA"
      });

      const partial = setMarketPreference({ currencyCode: "USD" });
      expect(partial.countryCode).toBe("CA");
      expect(partial.currencyCode).toBe("USD");
      expect(partial.locale).toBe("en-CA");
    });

    it("normalizes lowercase country and currency codes to uppercase", () => {
      const pref = setMarketPreference({
        countryCode: "uk",
        currencyCode: "gbp"
      });

      expect(pref.countryCode).toBe("UK");
      expect(pref.currencyCode).toBe("GBP");
    });

    it("normalizes underscores in locale to standard hyphens", () => {
      const pref = setMarketPreference({ locale: "en_GB" });
      expect(pref.locale).toBe("en-GB");
    });

    it("throws clear error on invalid country code", () => {
      expect(() => setMarketPreference({ countryCode: "USA" })).toThrow(/countryCode/i);
      expect(() => setMarketPreference({ countryCode: "1" })).toThrow(/countryCode/i);
      expect(() => setMarketPreference({ countryCode: "12" })).toThrow(/countryCode/i);
      expect(() => setMarketPreference({ countryCode: "" })).toThrow(/countryCode/i);
    });

    it("throws clear error on invalid currency code", () => {
      expect(() => setMarketPreference({ currencyCode: "US" })).toThrow(/currencyCode/i);
      expect(() => setMarketPreference({ currencyCode: "USDD" })).toThrow(/currencyCode/i);
      expect(() => setMarketPreference({ currencyCode: "123" })).toThrow(/currencyCode/i);
      expect(() => setMarketPreference({ currencyCode: "" })).toThrow(/currencyCode/i);
    });

    it("throws clear error on invalid locale", () => {
      expect(() => setMarketPreference({ locale: "" })).toThrow(/locale/i);
      expect(() => setMarketPreference({ locale: "   " })).toThrow(/locale/i);
    });

    it("gracefully returns current preference when given invalid input object", () => {
      // @ts-expect-error test non-object argument
      const result = setMarketPreference(null);
      expect(result).toEqual(DEFAULT_MARKET_PREFERENCE);
    });
  });

  describe("subscribeMarketPreference", () => {
    it("notifies subscriber when preference is updated", () => {
      const listener = vi.fn();
      const unsubscribe = subscribeMarketPreference(listener);

      setMarketPreference({ countryCode: "US", currencyCode: "USD" });

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          countryCode: "US",
          currencyCode: "USD"
        })
      );

      unsubscribe();
    });

    it("stops notifying after unsubscribing", () => {
      const listener = vi.fn();
      const unsubscribe = subscribeMarketPreference(listener);

      setMarketPreference({ countryCode: "US", currencyCode: "USD" });
      expect(listener).toHaveBeenCalledTimes(1);

      unsubscribe();

      setMarketPreference({ countryCode: "DE", currencyCode: "EUR" });
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("notifies multiple subscribers independently", () => {
      const listenerA = vi.fn();
      const listenerB = vi.fn();

      const unsubA = subscribeMarketPreference(listenerA);
      const unsubB = subscribeMarketPreference(listenerB);

      setMarketPreference({ countryCode: "CA", currencyCode: "CAD" });

      expect(listenerA).toHaveBeenCalledTimes(1);
      expect(listenerB).toHaveBeenCalledTimes(1);

      unsubA();

      setMarketPreference({ currencyCode: "USD" });
      expect(listenerA).toHaveBeenCalledTimes(1);
      expect(listenerB).toHaveBeenCalledTimes(2);

      unsubB();
    });
  });

  describe("validateMarketPreference", () => {
    it("returns defaults for null or non-object values", () => {
      expect(validateMarketPreference(null)).toEqual(DEFAULT_MARKET_PREFERENCE);
      expect(validateMarketPreference("invalid")).toEqual(DEFAULT_MARKET_PREFERENCE);
      expect(validateMarketPreference(123)).toEqual(DEFAULT_MARKET_PREFERENCE);
    });

    it("validates and extracts uppercase codes", () => {
      const result = validateMarketPreference({
        countryCode: "  jp  ",
        currencyCode: "  jpy  ",
        locale: "ja_JP"
      });

      expect(result).toEqual({
        countryCode: "JP",
        currencyCode: "JPY",
        locale: "ja-JP"
      });
    });
  });
});
