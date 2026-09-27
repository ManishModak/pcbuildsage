import { describe, expect, it } from "vitest";
import { GET as getMarkets } from "../route";
import type { MarketMetadata } from "@/lib/config/deployment";
import { setCatalogRepository, type CatalogRepository } from "@/lib/catalog";

describe("GET /api/markets", () => {
  it("with an IN-only fixture returns only IN", async () => {
    const inOnlyRepo: Partial<CatalogRepository> = {
      getMarkets: async () => [
        { code: "IN", name: "India", defaultCurrency: "INR", supportedCurrencies: ["INR"], locale: "en-IN" }
      ]
    };
    setCatalogRepository(inOnlyRepo as CatalogRepository);
    try {
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
    } finally {
      setCatalogRepository(null);
    }
  });

  it("returns empty list without hardcoded fallback when repository returns empty", async () => {
    const emptyRepo: Partial<CatalogRepository> = {
      getMarkets: async () => []
    };
    setCatalogRepository(emptyRepo as CatalogRepository);
    try {
      const response = await getMarkets();
      expect(response.status).toBe(200);
      const body = (await response.json()) as { markets: MarketMetadata[] };
      expect(body.markets).toEqual([]);
    } finally {
      setCatalogRepository(null);
    }
  });

  it("returns empty list without hardcoded fallback when repository fails", async () => {
    const failingRepo: Partial<CatalogRepository> = {
      getMarkets: async () => {
        throw new Error("Repository failure");
      }
    };
    setCatalogRepository(failingRepo as CatalogRepository);
    try {
      const response = await getMarkets();
      expect(response.status).toBe(200);
      const body = (await response.json()) as { markets: MarketMetadata[] };
      expect(body.markets).toEqual([]);
    } finally {
      setCatalogRepository(null);
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

