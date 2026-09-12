import { describe, it, expect } from "vitest";
import { toCompactSearchResult } from "../catalog/compact";
import type { SearchProductItem, SearchProductsResult } from "../catalog/repository";

describe("Search Output Reduction Measurements", () => {
  // Construct realistic 30-item product search result based on live catalog data
  const createLegacy30ItemResult = (): SearchProductsResult => {
    const results: SearchProductItem[] = Array.from({ length: 30 }, (_, i) => ({
      id: `product-id-${i + 1}-hex-digest-long-40-chars-sample`,
      name: `Colorful iGame GeForce RTX 5060 Ultra W DUO OC 8GB GDDR7 Graphics Card (White) - Edition ${i + 1}`,
      category: "gpu",
      subcategory: null,
      price: 42990 + i * 100,
      currency: "INR",
      country_code: "IN",
      retailer: "Kryptronix Gaming",
      url: `https://kryptronix.in/product/colorful-igame-rtx-5060-ultra-w-duo-oc-8gb-gddr7-graphics-card-white-sample-${i + 1}/`,
      imageUrl: `https://kryptronix.in/wp-content/uploads/2026/05/1753705230513-26da7800-852c-4c91-bf31-a5adb9bdf17a-300x300-${i + 1}.png`,
      in_stock: true,
      inStock: true,
      registry_key: "nvidia-rtx-5060",
      specs: {
        brand: "NVIDIA",
        model: "NVIDIA GeForce RTX 5060",
        aliases: [
          "GeForce RTX 5060",
          "RTX 5060",
          "5060",
          "NVIDIA RTX 5060",
          "NVIDIA GeForce RTX 5060",
          "RTX 5060 8GB",
          "GeForce RTX 5060 8GB"
        ],
        length_mm: 241,
        tdp_w: 145,
        recommended_psu_w: 550,
        vram_gb: 8,
        slot_width: 2,
        segment: "gaming",
        sources: [
          "https://www.techpowerup.com/gpu-specs/geforce-rtx-5060.c4226",
          "https://www.nvidia.com/en-us/geforce/graphics-cards/50-series/rtx-5060-family/"
        ],
        confidence: "high",
        researched_at: "2026-08-16T15:35:00Z"
      },
      offers: [
        {
          id: `product-id-${i + 1}-hex-digest-long-40-chars-sample`,
          productId: `product-id-${i + 1}-hex-digest-long-40-chars-sample`,
          retailerId: "kryptronix",
          retailer: "Kryptronix Gaming",
          countryCode: "IN",
          currencyCode: "INR",
          price: 42990 + i * 100,
          priceMinor: (42990 + i * 100) * 100,
          destinationUrl: `https://kryptronix.in/product/colorful-igame-rtx-5060-ultra-w-duo-oc-8gb-gddr7-graphics-card-white-sample-${i + 1}/`,
          sourceType: "scraped",
          observedAt: "2026-09-12T09:25:12Z",
          lastUpdated: "2026-09-12T09:25:12Z",
          availability: "in_stock",
          inStock: true,
          imageUrl: `https://kryptronix.in/wp-content/uploads/2026/05/1753705230513-26da7800-852c-4c91-bf31-a5adb9bdf17a-300x300-${i + 1}.png`
        }
      ],
      first_seen: "2026-09-12T09:25:12Z",
      last_scraped: "2026-09-12T09:25:12Z"
    }));

    return {
      results,
      items: results, // duplicate array in legacy output
      total_matching: 98,
      totalCount: 98,
      returned: 30,
      has_more: true,
      batch_price_range: { min: 42990, max: 45890 },
      category_price_range: { min: 4479, max: 2250000 },
      category_total: 1048,
      in_stock_total: 563,
      nearest_above: {
        name: "ASUS Dual GeForce RTX 5050 8GB GDDR6 OC Edition",
        price: 45399,
        retailer: "PrimeABGB",
        registry_key: "nvidia-rtx-5050"
      },
      hint: "Showing 30 of 98 matching in-stock products",
      scope: { country_code: "IN", currency: "INR" }
    };
  };

  it("Tier A: measures field compaction alone on 30 items (replay scenario)", () => {
    const legacy = createLegacy30ItemResult();
    const legacyBytes = Buffer.byteLength(JSON.stringify(legacy), "utf8");

    // Replay compaction preserves all 30 candidates, but drops duplicate items array and non-functional metadata
    const compactReplay = toCompactSearchResult(legacy);
    const compactReplayBytes = Buffer.byteLength(JSON.stringify(compactReplay), "utf8");

    const reductionPercent = ((legacyBytes - compactReplayBytes) / legacyBytes) * 100;

    // Field compaction alone must achieve at least 80% size reduction on 30 items
    expect(reductionPercent).toBeGreaterThan(80);
    expect(compactReplay.results).toHaveLength(30);

    // Legacy was ~60KB-70KB for one search; compact 30-item is ~10KB-12KB
    expect(compactReplayBytes).toBeLessThan(legacyBytes * 0.2);
  });

  it("Tier B: measures field compaction + candidate reduction to 8 items (new live search scenario)", () => {
    const legacy = createLegacy30ItemResult();
    const legacyBytes = Buffer.byteLength(JSON.stringify(legacy), "utf8");

    // Live search clamps to 8 candidates and applies field compaction
    const legacy8Items: SearchProductsResult = {
      ...legacy,
      results: legacy.results.slice(0, 8),
      items: legacy.results.slice(0, 8),
      returned: 8
    };

    const compactLive = toCompactSearchResult(legacy8Items);
    const compactLiveBytes = Buffer.byteLength(JSON.stringify(compactLive), "utf8");

    const totalReductionPercent = ((legacyBytes - compactLiveBytes) / legacyBytes) * 100;

    // Combined reduction must achieve approximately 95% reduction (at least 92%)
    expect(totalReductionPercent).toBeGreaterThan(92);
    expect(compactLive.results).toHaveLength(8);

    // Live search payload drops from ~65KB down to ~3KB
    expect(compactLiveBytes).toBeLessThan(legacyBytes * 0.08);
  });
});
