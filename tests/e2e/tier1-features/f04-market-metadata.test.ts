import { describe, it, expect } from "vitest";
import { STANDARD_MARKETS } from "../test-harness";

describe("Tier 1 - Feature 4: Public Market Metadata Endpoint (R1)", () => {
  it("returns standard supported countries with ISO 3166-1 alpha-2 codes", () => {
    const codes = STANDARD_MARKETS.map((m) => m.code);
    expect(codes).toContain("US");
    expect(codes).toContain("UK");
    expect(codes).toContain("IN");
    codes.forEach((c) => {
      expect(c).toMatch(/^[A-Z]{2}$/);
    });
  });

  it("each market specifies name, defaultCurrency, supportedCurrencies, and locale", () => {
    for (const market of STANDARD_MARKETS) {
      expect(market.name).toBeDefined();
      expect(market.defaultCurrency).toMatch(/^[A-Z]{3}$/);
      expect(market.supportedCurrencies.length).toBeGreaterThan(0);
      expect(market.supportedCurrencies).toContain(market.defaultCurrency);
      expect(market.locale).toMatch(/^[a-z]{2}-[A-Z]{2}$/);
    }
  });

  it("market metadata contains no internal scraper selectors or HTML parsing rules", () => {
    const serialized = JSON.stringify(STANDARD_MARKETS);
    expect(serialized).not.toContain("selector");
    expect(serialized).not.toContain("xpath");
    expect(serialized).not.toContain("soup");
    expect(serialized).not.toContain("css");
  });

  it("market metadata contains no category URLs or crawler endpoint definitions", () => {
    const serialized = JSON.stringify(STANDARD_MARKETS);
    expect(serialized).not.toContain("categoryUrl");
    expect(serialized).not.toContain("crawler");
    expect(serialized).not.toContain("scrape");
    expect(serialized).not.toContain("pagination");
  });

  it("market metadata contains no internal database paths or server credentials", () => {
    const serialized = JSON.stringify(STANDARD_MARKETS);
    expect(serialized).not.toContain(".db");
    expect(serialized).not.toContain("password");
    expect(serialized).not.toContain("token");
    expect(serialized).not.toContain("secret");
  });
});
