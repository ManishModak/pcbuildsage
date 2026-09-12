import { describe, expect, it } from "vitest";
import { getMarketByCode, listMarkets } from "../markets";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

describe("Market Metadata Resolution (markets.ts)", () => {
  it("returns standard market metadata by default", () => {
    const markets = listMarkets();
    expect(markets.length).toBeGreaterThanOrEqual(5);
    const inMarket = markets.find((m) => m.code === "IN");
    expect(inMarket).toBeDefined();
    expect(inMarket?.name).toBe("India");
    expect(inMarket?.defaultCurrency).toBe("INR");
    expect(inMarket?.supportedCurrencies).toContain("INR");
    expect(inMarket?.locale).toBe("en-IN");
  });

  it("dynamically discovers and augments markets from custom profile directory", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "pcbuildsage-markets-test-"));
    try {
      // Create a profile for Japan (JP)
      writeFileSync(
        path.join(tempDir, "japan.json"),
        JSON.stringify({
          country_code: "JP",
          default_currency: "JPY",
          sites: [{ site_name: "Amazon JP" }] // Scraper internals
        })
      );

      const markets = listMarkets(tempDir);
      const jp = markets.find((m) => m.code === "JP");
      expect(jp).toBeDefined();
      expect(jp?.code).toBe("JP");
      expect(jp?.defaultCurrency).toBe("JPY");
      expect(jp?.supportedCurrencies).toContain("JPY");

      // Verify no scraper internals are exposed
      const serialized = JSON.stringify(markets);
      expect(serialized).not.toContain("Amazon JP");
      expect(serialized).not.toContain("sites");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("deduplicates multiple profiles targeting the same country code", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "pcbuildsage-dedup-test-"));
    try {
      writeFileSync(
        path.join(tempDir, "profile1.json"),
        JSON.stringify({
          country_code: "IN",
          default_currency: "INR"
        })
      );
      writeFileSync(
        path.join(tempDir, "profile2.json"),
        JSON.stringify({
          country_code: "IN",
          default_currency: "INR"
        })
      );

      const markets = listMarkets(tempDir);
      const inEntries = markets.filter((m) => m.code === "IN");
      expect(inEntries.length).toBe(1);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("looks up market by code safely", () => {
    const us = getMarketByCode("us");
    expect(us).toBeDefined();
    expect(us?.code).toBe("US");

    const nonExistent = getMarketByCode("ZZ");
    expect(nonExistent).toBeUndefined();

    const empty = getMarketByCode("");
    expect(empty).toBeUndefined();
  });
});
