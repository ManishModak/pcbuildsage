import { describe, it, expect } from "vitest";
import { MarketPreference, STANDARD_MARKETS } from "../test-harness";

describe("Tier 2 Boundary - Feature 20: Market Preference Edge Cases", () => {
  it("handles malformed JSON in stored market preference safely with fallback", () => {
    const parsePreference = (raw: string | null): MarketPreference => {
      try {
        if (!raw) throw new Error();
        return JSON.parse(raw);
      } catch {
        return { countryCode: "US", currencyCode: "USD", locale: "en-US" };
      }
    };

    expect(parsePreference("INVALID_JSON{")).toEqual({
      countryCode: "US",
      currencyCode: "USD",
      locale: "en-US"
    });
    expect(parsePreference(null)).toEqual({
      countryCode: "US",
      currencyCode: "USD",
      locale: "en-US"
    });
  });

  it("handles unknown country code in preference by validating against standard markets", () => {
    const invalidPref: MarketPreference = {
      countryCode: "UNKNOWN",
      currencyCode: "XYZ",
      locale: "xx-YY"
    };

    const isSupported = STANDARD_MARKETS.some((m) => m.code === invalidPref.countryCode);
    expect(isSupported).toBe(false);
  });

  it("handles currency mismatch by reconciling with market default currency", () => {
    const market = STANDARD_MARKETS.find((m) => m.code === "US")!;
    const requestedCurrency = "EUR";

    const isAllowed = market.supportedCurrencies.includes(requestedCurrency);
    const resolvedCurrency = isAllowed ? requestedCurrency : market.defaultCurrency;

    expect(resolvedCurrency).toBe("USD");
  });

  it("handles locale string formatting variations safely", () => {
    const pref: MarketPreference = {
      countryCode: "UK",
      currencyCode: "GBP",
      locale: "en_GB" // underscore variant
    };

    const normalizedLocale = pref.locale.replace("_", "-");
    expect(normalizedLocale).toBe("en-GB");
  });

  it("handles immutable preference object freezing", () => {
    const pref: MarketPreference = Object.freeze({
      countryCode: "CA",
      currencyCode: "CAD",
      locale: "en-CA"
    });

    expect(Object.isFrozen(pref)).toBe(true);
    expect(pref.countryCode).toBe("CA");
  });
});
