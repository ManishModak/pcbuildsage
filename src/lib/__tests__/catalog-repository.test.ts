import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  getCatalogRepository,
  setCatalogRepository,
  registerCatalogRepository,
  resetCatalogRepositoryRegistry,
  type CatalogRepository,
  type CatalogScope,
  type SearchProductsInput,
  type ProductOffer,
  type MarketPreference,
  toPriceMinor,
  fromPriceMinor,
  isOfferInStock
} from "@/lib/catalog";

describe("CatalogRepository & Source-Neutral Offer Model (Phase 1)", () => {
  beforeEach(() => {
    resetCatalogRepositoryRegistry();
  });

  afterEach(() => {
    resetCatalogRepositoryRegistry();
  });

  describe("ProductOffer domain model", () => {
    it("validates ProductOffer fields with native currency and priceMinor", () => {
      const offer: ProductOffer = {
        productId: "gpu-rtx-4070-super",
        retailerId: "mdcomputers",
        retailer: "MDComputers",
        countryCode: "IN",
        currencyCode: "INR",
        price: 59999,
        priceMinor: 5999900,
        destinationUrl: "https://mdcomputers.in/product/rtx-4070-super",
        sourceType: "scraped",
        observedAt: "2026-09-02T12:00:00Z",
        availability: "in_stock",
        inStock: true,
        lastUpdated: "2026-09-02T12:00:00Z"
      };

      expect(offer.productId).toBe("gpu-rtx-4070-super");
      expect(offer.retailerId).toBe("mdcomputers");
      expect(offer.retailer).toBe("MDComputers");
      expect(offer.countryCode).toBe("IN");
      expect(offer.currencyCode).toBe("INR");
      expect(offer.price).toBe(59999);
      expect(offer.priceMinor).toBe(5999900);
      expect(offer.sourceType).toBe("scraped");
      expect(offer.destinationUrl).toContain("mdcomputers.in");
      expect(offer.availability).toBe("in_stock");
      expect(isOfferInStock(offer)).toBe(true);
    });

    it("supports all valid sourceType enum values without bias", () => {
      const sources: Array<ProductOffer["sourceType"]> = ["scraped", "retailer-feed", "manual", "affiliate"];
      for (const st of sources) {
        const offer: ProductOffer = {
          productId: "p1",
          countryCode: "US",
          currencyCode: "USD",
          price: 99.99,
          destinationUrl: "https://example.com",
          sourceType: st
        };
        expect(offer.sourceType).toBe(st);
      }
    });

    it("accurately converts standard major price to minor units (and reverse)", () => {
      expect(toPriceMinor(249.99, "USD")).toBe(24999);
      expect(toPriceMinor(35000, "INR")).toBe(3500000);
      expect(toPriceMinor(5000, "JPY")).toBe(5000); // zero-decimal

      expect(fromPriceMinor(24999, "USD")).toBe(249.99);
      expect(fromPriceMinor(3500000, "INR")).toBe(35000);
      expect(fromPriceMinor(5000, "JPY")).toBe(5000);
    });

    it("evaluates availability states correctly", () => {
      const inStockOffer: ProductOffer = {
        productId: "p1",
        countryCode: "US",
        currencyCode: "USD",
        price: 100,
        destinationUrl: "https://example.com",
        sourceType: "retailer-feed",
        availability: "in_stock"
      };
      const outOfStockOffer: ProductOffer = {
        productId: "p1",
        countryCode: "US",
        currencyCode: "USD",
        price: 100,
        destinationUrl: "https://example.com",
        sourceType: "retailer-feed",
        availability: "out_of_stock",
        inStock: false
      };

      expect(isOfferInStock(inStockOffer)).toBe(true);
      expect(isOfferInStock(outOfStockOffer)).toBe(false);
    });
  });

  describe("MarketPreference domain model", () => {
    it("instantiates valid MarketPreference structure", () => {
      const pref: MarketPreference = {
        countryCode: "IN",
        currencyCode: "INR",
        locale: "en-IN"
      };

      expect(pref.countryCode).toBe("IN");
      expect(pref.currencyCode).toBe("INR");
      expect(pref.locale).toBe("en-IN");
    });
  });

  describe("getCatalogRepository factory", () => {
    it("returns default local SQLite repository when mode is 'local' or unset", async () => {
      const repo = getCatalogRepository("local");
      expect(repo).toBeDefined();
      expect(typeof repo.getCatalog).toBe("function");
      expect(typeof repo.searchProducts).toBe("function");
      expect(typeof repo.getCategoryBaseline).toBe("function");
      expect(typeof repo.getFreshness).toBe("function");
    });

    it("throws a descriptive error in hosted-demo mode when unconfigured", () => {
      expect(() => getCatalogRepository("hosted-demo")).toThrow(/Turso repository adapter is not registered/);
    });

    it("allows registering and resolving a custom factory for hosted-demo mode", async () => {
      const mockHostedRepo: CatalogRepository = {
        getCatalog: async () => ({ categories: [], scope: { country_code: "US", currency: "USD" } }),
        searchProducts: async () => ({ results: [], items: [], totalCount: 0 }),
        listModels: async () => ({ models: [], total_matching_models: 0, returned_models: 0, truncated: false, scope: { country_code: "US", currency: "USD" } }),
        getCategoryBaseline: async () => ({ total: 0, in_stock_total: 0, min_price: null, max_price: null }),
        getFreshness: async () => ({ lastScraped: null, productCount: 0 })
      };

      registerCatalogRepository("hosted-demo", () => mockHostedRepo);
      const repo = getCatalogRepository("hosted-demo");
      expect(repo).toBe(mockHostedRepo);
    });

    it("allows setting an explicit singleton instance via setCatalogRepository", async () => {
      const mockCustomRepo: CatalogRepository = {
        getCatalog: async () => ({ categories: [], scope: { country_code: "UK", currency: "GBP" } }),
        searchProducts: async () => ({ results: [], items: [], totalCount: 0 }),
        listModels: async () => ({ models: [], total_matching_models: 0, returned_models: 0, truncated: false, scope: { country_code: "UK", currency: "GBP" } }),
        getCategoryBaseline: async () => ({ total: 0, in_stock_total: 0, min_price: null, max_price: null }),
        getFreshness: async () => ({ lastScraped: "2026-09-02T10:00:00Z", productCount: 42 })
      };

      setCatalogRepository(mockCustomRepo);
      expect(getCatalogRepository("local")).toBe(mockCustomRepo);
      expect(getCatalogRepository("hosted-demo")).toBe(mockCustomRepo);

      const freshness = await getCatalogRepository().getFreshness();
      expect(freshness.productCount).toBe(42);
    });
  });

  describe("CatalogRepository methods contract adherence", () => {
    it("verifies getCatalog returns GetCatalogResult structure with categories array", async () => {
      const repo = getCatalogRepository("local");
      const scope: CatalogScope = { countryCode: "IN", currency: "INR" };
      const res = await repo.getCatalog(scope);

      expect(res).toHaveProperty("categories");
      expect(res).toHaveProperty("scope");
      expect(Array.isArray(res.categories)).toBe(true);
      expect(res.scope.country_code).toBe("IN");
    });

    it("verifies searchProducts returns SearchProductsResult with results and items", async () => {
      const repo = getCatalogRepository("local");
      const scope: CatalogScope = { countryCode: "IN", currency: "INR" };
      const input: SearchProductsInput = { category: "gpu", limit: 5 };

      const res = await repo.searchProducts(input, scope);
      expect(res).toHaveProperty("results");
      expect(Array.isArray(res.results)).toBe(true);
      expect(Array.isArray(res.items)).toBe(true);
    });

    it("verifies getCategoryBaseline returns CategoryBaselineResult with numeric metrics", async () => {
      const repo = getCatalogRepository("local");
      const scope: CatalogScope = { countryCode: "IN", currency: "INR" };

      const baseline = await repo.getCategoryBaseline("cpu", scope);
      expect(typeof baseline.total).toBe("number");
      expect(typeof baseline.in_stock_total).toBe("number");
      expect(baseline).toHaveProperty("min_price");
      expect(baseline).toHaveProperty("max_price");
    });

    it("verifies getFreshness returns CatalogFreshnessResult", async () => {
      const repo = getCatalogRepository("local");
      const freshness = await repo.getFreshness("IN");

      expect(freshness).toHaveProperty("lastScraped");
      expect(freshness).toHaveProperty("productCount");
      expect(typeof freshness.productCount).toBe("number");
    });
  });
});
