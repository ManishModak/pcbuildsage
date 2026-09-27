import { describe, expect, it } from "vitest";
import { GET as getMarkets } from "../route";
import type { MarketMetadata } from "@/lib/config/deployment";
import { setCatalogRepository, type CatalogRepository } from "@/lib/catalog";

describe("GET /api/markets", () => {
  it("returns only markets with in-stock products from catalog (India in current catalog)", async () => {
    const response = await getMarkets();
    expect(response.status).toBe(200);
    const body = (await response.json()) as { markets: MarketMetadata[] };
    expect(Array.isArray(body.markets)).toBe(true);
    expect(body.markets).toHaveLength(1);
    expect(body.markets[0].code).toBe("IN");
    expect(body.markets[0].name).toBe("India");

    for (const market of body.markets) {
      expect(market.code).toMatch(/^[A-Z]{2}$/);
      expect(market.name).toBeDefined();
      expect(market.defaultCurrency).toMatch(/^[A-Z]{3}$/);
      expect(market.supportedCurrencies).toContain(market.defaultCurrency);
      expect(market.locale).toMatch(/^[a-z]{2}-[A-Z]{2}$/);
    }
  });

  it("derives markets dynamically from the catalog repository", async () => {
    const customRepo: Partial<CatalogRepository> = {
      getMarkets: async () => [
        { code: "US", name: "United States", defaultCurrency: "USD", supportedCurrencies: ["USD"], locale: "en-US" },
        { code: "IN", name: "India", defaultCurrency: "INR", supportedCurrencies: ["INR"], locale: "en-IN" }
      ]
    };
    setCatalogRepository(customRepo as CatalogRepository);
    try {
      const response = await getMarkets();
      expect(response.status).toBe(200);
      const body = (await response.json()) as { markets: MarketMetadata[] };
      expect(body.markets.map((m) => m.code)).toEqual(["US", "IN"]);
    } finally {
      setCatalogRepository(null);
    }
  });

  it("does not expose scraper internals or filesystem paths", async () => {
    const response = await getMarkets();
    const text = await response.text();
    expect(text).not.toContain("selectors");
    expect(text).not.toContain("sites");
    expect(text).not.toContain("browser_config");
    expect(text).not.toContain("pagination");
    expect(text).not.toContain(".db");
  });
});

