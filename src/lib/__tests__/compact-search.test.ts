import { describe, it, expect } from "vitest";
import {
  toCompactProductItem,
  toCompactFunctionalSpecs,
  toCompactSearchResult
} from "../catalog/compact";
import { searchProductsInputSchema, searchProducts } from "../tools/search-products";
import type { SearchProductItem, SearchProductsResult } from "../catalog/repository";

describe("Compact Search Module", () => {
  it("preserves functional hardware specs and strips research/aliases overhead", () => {
    const rawSpecs = {
      brand: "AMD",
      model: "Ryzen 5 7600",
      socket: "AM5",
      tdp_w: 65,
      ddr: "DDR5",
      cores: 6,
      boost_clock_ghz: 5.1,
      aliases: ["AMD Ryzen 5 7600", "R5 7600", "7600"],
      sources: ["https://example.com/cpu"],
      researched_at: "2026-08-16T10:05:00Z",
      $schema: "some-schema",
      confidence: "high"
    };

    const compact = toCompactFunctionalSpecs(rawSpecs);
    expect(compact).toBeDefined();
    expect(compact?.socket).toBe("AM5");
    expect(compact?.tdp_w).toBe(65);
    expect(compact?.ddr).toBe("DDR5");
    expect(compact?.cores).toBe(6);
    expect(compact?.boost_clock_ghz).toBe(5.1);
    expect(compact?.confidence).toBe("high");

    // Must NOT contain overhead
    expect(compact?.aliases).toBeUndefined();
    expect(compact?.sources).toBeUndefined();
    expect(compact?.researched_at).toBeUndefined();
    expect(compact?.$schema).toBeUndefined();
    // Must NOT fabricate verified: true
    expect((compact as Record<string, unknown>).verified).toBeUndefined();
  });

  it("preserves confidence provenance accurately without fabricating verified", () => {
    expect(toCompactFunctionalSpecs({ socket: "AM5", confidence: "medium" })?.confidence).toBe("medium");
    expect(toCompactFunctionalSpecs({ socket: "AM5", confidence: "low" })?.confidence).toBe("low");
    expect(toCompactFunctionalSpecs({ socket: "AM5", confidence: "custom" })?.confidence).toBe("unknown");
    expect(toCompactFunctionalSpecs({ socket: "AM5" })?.confidence).toBeUndefined();
  });

  it("compacts product items by stripping offers and scrape timestamps", () => {
    const rawItem: SearchProductItem = {
      id: "gpu-1",
      name: "INNO3D RTX 5050 Twin X2",
      category: "gpu",
      subcategory: null,
      price: 45000,
      currency: "INR",
      country_code: "IN",
      retailer: "PCStudio",
      url: "https://example.com/gpu",
      imageUrl: "https://example.com/gpu.jpg",
      in_stock: true,
      inStock: true,
      registry_key: "nvidia-rtx-5050",
      specs: {
        brand: "NVIDIA",
        vram_gb: 8,
        tdp_w: 130,
        aliases: ["RTX 5050"],
        sources: ["https://techpowerup.com/5050"]
      },
      offers: [
        {
          id: "gpu-1",
          productId: "gpu-1",
          retailer: "PCStudio",
          countryCode: "IN",
          currencyCode: "INR",
          price: 45000,
          destinationUrl: "https://example.com/gpu",
          sourceType: "scraped",
          observedAt: "2026-09-12T09:33:49Z",
          lastUpdated: "2026-09-12T09:33:49Z",
          availability: "in_stock",
          inStock: true
        }
      ],
      first_seen: "2026-09-12T09:33:49Z",
      last_scraped: "2026-09-12T09:33:49Z"
    };

    const compact = toCompactProductItem(rawItem);
    expect(compact).toEqual({
      id: "gpu-1",
      name: "INNO3D RTX 5050 Twin X2",
      category: "gpu",
      subcategory: null,
      price: 45000,
      currency: "INR",
      country_code: "IN",
      retailer: "PCStudio",
      url: "https://example.com/gpu",
      in_stock: true,
      registry_key: "nvidia-rtx-5050",
      specs: {
        brand: "NVIDIA",
        vram_gb: 8,
        tdp_w: 130
      }
    });

    expect((compact as Record<string, unknown>).offers).toBeUndefined();
    expect((compact as Record<string, unknown>).inStock).toBeUndefined();
    expect((compact as Record<string, unknown>).first_seen).toBeUndefined();
    expect((compact as Record<string, unknown>).last_scraped).toBeUndefined();
  });

  it("preserves full response contract in toCompactSearchResult", () => {
    const rawResult: SearchProductsResult = {
      results: [
        {
          id: "p1",
          name: "Part 1",
          category: "ram",
          price: 8000,
          currency: "INR",
          country_code: "IN",
          retailer: "MDComputers",
          url: "https://example.com/p1",
          in_stock: true
        }
      ],
      items: [
        {
          id: "p1",
          name: "Part 1",
          category: "ram",
          price: 8000,
          currency: "INR",
          country_code: "IN",
          retailer: "MDComputers",
          url: "https://example.com/p1",
          in_stock: true
        }
      ],
      total_matching: 42,
      totalCount: 42,
      returned: 1,
      has_more: true,
      scope: { country_code: "IN", currency: "INR" },
      category_total: 100,
      in_stock_total: 80,
      batch_price_range: { min: 8000, max: 8000 },
      category_price_range: { min: 5000, max: 20000 },
      nearest_above: { name: "Higher Part", price: 9000 },
      nearest_below: { name: "Lower Part", price: 7000 },
      hint: "Showing 1 of 42",
      error: undefined,
      valid_filters: ["category", "price_max"]
    };

    const compact = toCompactSearchResult(rawResult);
    expect(compact.results).toHaveLength(1);
    expect((compact as Record<string, unknown>).items).toBeUndefined();
    expect(compact.total_matching).toBe(42);
    expect(compact.totalCount).toBe(42);
    expect(compact.returned).toBe(1);
    expect(compact.has_more).toBe(true);
    expect(compact.scope).toEqual({ country_code: "IN", currency: "INR" });
    expect(compact.category_total).toBe(100);
    expect(compact.in_stock_total).toBe(80);
    expect(compact.batch_price_range).toEqual({ min: 8000, max: 8000 });
    expect(compact.category_price_range).toEqual({ min: 5000, max: 20000 });
    expect(compact.nearest_above).toEqual({ name: "Higher Part", price: 9000 });
    expect(compact.nearest_below).toEqual({ name: "Lower Part", price: 7000 });
    expect(compact.hint).toBe("Showing 1 of 42");
    expect(compact.valid_filters).toEqual(["category", "price_max"]);
  });

  it("enforces schema limit validation (default 8, max 12)", () => {
    expect(searchProductsInputSchema.parse({}).limit).toBe(8);
    expect(searchProductsInputSchema.safeParse({ limit: 8 }).success).toBe(true);
    expect(searchProductsInputSchema.safeParse({ limit: 12 }).success).toBe(true);
    expect(searchProductsInputSchema.safeParse({ limit: 13 }).success).toBe(false);
    expect(searchProductsInputSchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(searchProductsInputSchema.safeParse({ limit: -5 }).success).toBe(false);
  });

  it("defensively normalizes non-finite and fractional limits without mutating input", async () => {
    let capturedInput: Parameters<typeof searchProducts>[0] | undefined;
    const mockRepo = {
      searchProducts: async (inp: Parameters<typeof searchProducts>[0]) => {
        capturedInput = inp;
        return { results: [], items: [], totalCount: 0, returned: 0 };
      },
      getCatalog: async () => ({ categories: [], scope: { country_code: "IN", currency: "INR" } })
    };

    const originalInput = { category: "gpu", limit: 30 };
    await searchProducts(originalInput, { countryCode: "IN", currency: "INR" }, mockRepo as unknown as Parameters<typeof searchProducts>[2]);

    // Original input object was NOT mutated
    expect(originalInput.limit).toBe(30);
    // Repository received clamped limit of 12
    expect(capturedInput?.limit).toBe(12);

    // Fractional limit
    await searchProducts({ category: "gpu", limit: 5.7 }, { countryCode: "IN", currency: "INR" }, mockRepo as unknown as Parameters<typeof searchProducts>[2]);
    expect(capturedInput?.limit).toBe(6);

    // Non-finite limit
    await searchProducts({ category: "gpu", limit: NaN }, { countryCode: "IN", currency: "INR" }, mockRepo as unknown as Parameters<typeof searchProducts>[2]);
    expect(capturedInput?.limit).toBe(8);
  });
});
