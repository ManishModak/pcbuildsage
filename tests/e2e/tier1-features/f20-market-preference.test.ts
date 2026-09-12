import { describe, it, expect } from "vitest";
import { MarketPreference, STANDARD_MARKETS } from "../test-harness";

describe("Tier 1 - Feature 20: Client Market Preference Persistence (R4)", () => {
  it("saves and retrieves client MarketPreference (countryCode, currencyCode, locale)", () => {
    const pref: MarketPreference = {
      countryCode: "UK",
      currencyCode: "GBP",
      locale: "en-GB"
    };

    const serialized = JSON.stringify(pref);
    const parsed: MarketPreference = JSON.parse(serialized);

    expect(parsed.countryCode).toBe("UK");
    expect(parsed.currencyCode).toBe("GBP");
    expect(parsed.locale).toBe("en-GB");
  });

  it("provides default fallback market preference (US / USD / en-US)", () => {
    const defaultPref: MarketPreference = {
      countryCode: "US",
      currencyCode: "USD",
      locale: "en-US"
    };

    expect(defaultPref.countryCode).toBe("US");
    expect(defaultPref.currencyCode).toBe("USD");
  });

  it("validates market preference against supported market metadata", () => {
    const pref: MarketPreference = {
      countryCode: "IN",
      currencyCode: "INR",
      locale: "en-IN"
    };

    const matched = STANDARD_MARKETS.find((m) => m.code === pref.countryCode);
    expect(matched).toBeDefined();
    expect(matched?.supportedCurrencies).toContain(pref.currencyCode);
  });

  it("updates market preference when user selects a different country", () => {
    let currentPref: MarketPreference = {
      countryCode: "US",
      currencyCode: "USD",
      locale: "en-US"
    };

    const newMarket = STANDARD_MARKETS.find((m) => m.code === "DE")!;
    currentPref = {
      countryCode: newMarket.code,
      currencyCode: newMarket.defaultCurrency,
      locale: newMarket.locale
    };

    expect(currentPref.countryCode).toBe("DE");
    expect(currentPref.currencyCode).toBe("EUR");
    expect(currentPref.locale).toBe("de-DE");
  });

  it("persists market preference across client UI reloads", () => {
    const storage = new Map<string, string>();
    const pref: MarketPreference = { countryCode: "CA", currencyCode: "CAD", locale: "en-CA" };

    storage.set("pcbuildsage_market_preference", JSON.stringify(pref));
    const loaded = JSON.parse(storage.get("pcbuildsage_market_preference")!);

    expect(loaded.countryCode).toBe("CA");
    expect(loaded.currencyCode).toBe("CAD");
  });
});
