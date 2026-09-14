/**
 * src/lib/catalog/__tests__/sqlite-repository.test.ts
 *
 * Comprehensive unit and contract tests for SqliteCatalogRepository (Phase 1).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initializeSchema } from "@/lib/db";
import { createValidateBuildTool } from "@/lib/tools/validate-build";
import type { Product } from "@/types/db";
import {
  SqliteCatalogRepository,
  getCatalogRepository,
  resetCatalogRepositoryRegistry,
  type CatalogScope
} from "@/lib/catalog";

function createInMemoryDb(): Database.Database {
  const db = new Database(":memory:");
  initializeSchema(db);
  return db;
}

function insertProduct(
  db: Database.Database,
  product: Partial<Omit<Product, "specs">> & { specs?: string | Record<string, unknown> | null }
) {
  const now = new Date().toISOString();
  const row = {
    id: product.id ?? `prod-${Math.random().toString(36).slice(2, 8)}`,
    name: product.name ?? "Test Product",
    normalized_name: product.normalized_name ?? product.name?.toLowerCase() ?? "test product",
    registry_key: product.registry_key ?? null,
    price: product.price !== undefined ? product.price : 100,
    currency: product.currency ?? "USD",
    country_code: product.country_code ?? "US",
    retailer: product.retailer ?? "RetailerX",
    url: product.url ?? `https://example.com/${product.id}`,
    image_url: product.image_url ?? null,
    in_stock: product.in_stock !== undefined ? product.in_stock : 1,
    category: product.category ?? "cpu",
    subcategory: product.subcategory ?? null,
    specs: typeof product.specs === "object" ? JSON.stringify(product.specs) : (product.specs ?? null),
    first_seen: product.first_seen ?? now,
    last_scraped: product.last_scraped ?? now
  };

  db.prepare(`
    INSERT INTO products (
      id, name, normalized_name, registry_key, price, currency,
      country_code, retailer, url, image_url, in_stock, category,
      subcategory, specs, first_seen, last_scraped
    ) VALUES (
      @id, @name, @normalized_name, @registry_key, @price, @currency,
      @country_code, @retailer, @url, @image_url, @in_stock, @category,
      @subcategory, @specs, @first_seen, @last_scraped
    )
  `).run(row);
  return row;
}

describe("SqliteCatalogRepository", () => {
  let db: Database.Database;
  let repo: SqliteCatalogRepository;
  const scopeUS: CatalogScope = { countryCode: "US", currency: "USD" };
  const scopeIN: CatalogScope = { countryCode: "IN", currency: "INR" };

  beforeEach(() => {
    resetCatalogRepositoryRegistry();
    db = createInMemoryDb();
    repo = new SqliteCatalogRepository(db);
  });

  afterEach(async () => {
    await repo.close();
    resetCatalogRepositoryRegistry();
  });

  it("looks up exact offer IDs within market scope, including retired offers", async () => {
    insertProduct(db, { id: "selected", name: "Selected CPU", in_stock: 0 });
    insertProduct(db, { id: "unselected", name: "Other CPU" });
    insertProduct(db, { id: "foreign", country_code: "IN", currency: "INR" });
    const result = await repo.searchProducts({ product_ids: ["selected", "foreign"], in_stock: false }, scopeUS);
    expect(result.results.map((product) => product.id)).toEqual(["selected"]);
    expect((await repo.searchProducts({ product_ids: [] }, scopeUS)).results).toEqual([]);
  });

  it("validates actual in-stock and retired catalog IDs through the tool", async () => {
    insertProduct(db, { id: "active-cpu", name: "AMD Ryzen 5 5500 Processor", registry_key: "amd-ryzen-5-5500", in_stock: 1 });
    insertProduct(db, { id: "retired-gpu", category: "gpu", name: "Sapphire PURE RX 7700 XT 12GB", registry_key: "sapphire-pure-rx-7700-xt", in_stock: 0 });
    const tool = createValidateBuildTool(scopeUS, repo);
    const output = await tool.execute!({ parts: { cpu: { product_id: "active-cpu" }, gpu: { product_id: "retired-gpu" } } }, { toolCallId: "test", messages: [], context: {} });
    expect(output).toMatchObject({ resolved: { cpu: { key: "active-cpu", spec: { socket: "AM4" } } } });
    expect(output).toMatchObject({ resolved: { gpu: { key: "retired-gpu", spec: { vram_gb: 12 } } } });
  });

  it("excludes mislinked 8GB cards from 16GB searches and exposes the conflict", async () => {
    insertProduct(db, { id: "eight", category: "gpu", name: "ASRock RX 9060 XT Steel Legend 8GB OC", registry_key: "amd-rx-9060-xt-16gb" });
    const all = await repo.searchProducts({ category: "gpu" }, scopeUS);
    expect(all.results[0].specs).toMatchObject({ vram_gb: 8, spec_conflict: expect.any(String) });
    expect(all.results[0].registry_key).toBe("amd-rx-9060-xt-8gb");
    const sixteen = await repo.searchProducts({ category: "gpu", min_vram_gb: 16 }, scopeUS);
    expect(sixteen.results).toHaveLength(0);
    const tool = createValidateBuildTool(scopeUS, repo);
    const result = await tool.execute!({ parts: { gpu: { product_id: "eight" } } }, { toolCallId: "variant", messages: [], context: {} });
    expect(result).toMatchObject({ checks: expect.arrayContaining([expect.objectContaining({ rule: "spec_resolution", status: "unverified", components: ["eight"] })]) });
  });

  describe("Factory Registration and Instantiation", () => {
    it("is resolved as default local catalog repository from getCatalogRepository('local')", () => {
      const defaultRepo = getCatalogRepository("local");
      expect(defaultRepo).toBeDefined();
      expect(defaultRepo).toBeInstanceOf(SqliteCatalogRepository);
      expect(typeof defaultRepo.getCatalog).toBe("function");
      expect(typeof defaultRepo.searchProducts).toBe("function");
      expect(typeof defaultRepo.getCategoryBaseline).toBe("function");
      expect(typeof defaultRepo.getFreshness).toBe("function");
    });

    it("allows dependency injection of custom in-memory database", async () => {
      insertProduct(db, { id: "cpu-custom", name: "Custom CPU", category: "cpu", price: 350 });
      const baseline = await repo.getCategoryBaseline("cpu", scopeUS);
      expect(baseline.total).toBe(1);
      expect(baseline.max_price).toBe(350);
    });

    it("provides idempotent close() implementation", async () => {
      await repo.close();
      await expect(repo.close()).resolves.toBeUndefined();
    });

    it("returns standard markets metadata via getMarkets()", async () => {
      const markets = await repo.getMarkets();
      expect(Array.isArray(markets)).toBe(true);
      expect(markets.length).toBeGreaterThan(0);
      expect(markets.map((m) => m.code)).toContain("US");
      expect(markets.map((m) => m.code)).toContain("IN");
    });
  });

  describe("getCatalog", () => {
    it("aggregates categories with count, stock, min and max prices", async () => {
      insertProduct(db, { id: "gpu-1", category: "gpu", price: 500, in_stock: 1 });
      insertProduct(db, { id: "gpu-2", category: "gpu", price: 800, in_stock: 1 });
      insertProduct(db, { id: "gpu-3", category: "gpu", price: 1200, in_stock: 0 });

      const catalog = await repo.getCatalog(scopeUS);
      expect(catalog.scope).toEqual({ country_code: "US", currency: "USD" });

      const gpu = catalog.categories.find((c) => c.category === "gpu");
      expect(gpu).toBeDefined();
      expect(gpu?.count).toBe(3);
      expect(gpu?.in_stock_count).toBe(2);
      expect(gpu?.price_min).toBe(500);
      expect(gpu?.price_max).toBe(1200);
    });

    it("returns all 8 component categories even when empty with explicit guidance note", async () => {
      const catalog = await repo.getCatalog(scopeUS);
      expect(catalog.categories).toHaveLength(8);

      for (const cat of catalog.categories) {
        expect(cat.count).toBe(0);
        expect(cat.in_stock_count).toBe(0);
        expect(cat.price_min).toBeNull();
        expect(cat.price_max).toBeNull();
        expect(cat.note).toMatch(/No products in the catalog for this category/i);
      }
    });

    it("separates build-relevant storage parts from accessory subcategories", async () => {
      insertProduct(db, { id: "ssd-1", category: "storage", subcategory: "internal", price: 100 });
      insertProduct(db, { id: "usb-1", category: "storage", subcategory: "removable", price: 15 });
      insertProduct(db, { id: "ext-1", category: "storage", subcategory: "external", price: 80 });

      const catalog = await repo.getCatalog(scopeUS);
      const storage = catalog.categories.find((c) => c.category === "storage");

      expect(storage).toBeDefined();
      expect(storage?.count).toBe(1); // Only internal
      expect(storage?.price_min).toBe(100);
      expect(storage?.subcategories).toBeDefined();
      expect(storage?.subcategories?.removable.count).toBe(1);
      expect(storage?.subcategories?.removable.price_min).toBe(15);
      expect(storage?.subcategories?.external.count).toBe(1);
      expect(storage?.note).toMatch(/stocked accessories, not build parts/i);
    });

    it("isolates results by countryCode and currency", async () => {
      insertProduct(db, { id: "cpu-us", category: "cpu", country_code: "US", currency: "USD", price: 300 });
      insertProduct(db, { id: "cpu-in", category: "cpu", country_code: "IN", currency: "INR", price: 25000 });

      const catalogUS = await repo.getCatalog(scopeUS);
      const cpuUS = catalogUS.categories.find((c) => c.category === "cpu");
      expect(cpuUS?.count).toBe(1);
      expect(cpuUS?.price_min).toBe(300);

      const catalogIN = await repo.getCatalog(scopeIN);
      const cpuIN = catalogIN.categories.find((c) => c.category === "cpu");
      expect(cpuIN?.count).toBe(1);
      expect(cpuIN?.price_min).toBe(25000);
    });
  });

  describe("searchProducts", () => {
    it("sorts by price descending by default (best within budget first)", async () => {
      insertProduct(db, { id: "gpu-low", name: "GPU Low", category: "gpu", price: 300 });
      insertProduct(db, { id: "gpu-mid", name: "GPU Mid", category: "gpu", price: 600 });
      insertProduct(db, { id: "gpu-high", name: "GPU High", category: "gpu", price: 900 });

      const result = await repo.searchProducts({ category: "gpu" }, scopeUS);
      expect(result.results).toHaveLength(3);
      expect(result.results[0].id).toBe("gpu-high");
      expect(result.results[1].id).toBe("gpu-mid");
      expect(result.results[2].id).toBe("gpu-low");
    });

    it("respects explicit sort order 'asc'", async () => {
      insertProduct(db, { id: "gpu-low", name: "GPU Low", category: "gpu", price: 300 });
      insertProduct(db, { id: "gpu-high", name: "GPU High", category: "gpu", price: 900 });

      const result = await repo.searchProducts({ category: "gpu", order: "asc" }, scopeUS);
      expect(result.results[0].id).toBe("gpu-low");
      expect(result.results[1].id).toBe("gpu-high");
    });

    it("filters by price_min and price_max", async () => {
      insertProduct(db, { id: "p1", category: "ram", price: 50 });
      insertProduct(db, { id: "p2", category: "ram", price: 120 });
      insertProduct(db, { id: "p3", category: "ram", price: 200 });

      const result = await repo.searchProducts({ category: "ram", price_min: 60, price_max: 150 }, scopeUS);
      expect(result.results).toHaveLength(1);
      expect(result.results[0].id).toBe("p2");
    });

    it("supports minPrice and maxPrice aliases", async () => {
      insertProduct(db, { id: "p1", category: "ram", price: 50 });
      insertProduct(db, { id: "p2", category: "ram", price: 120 });

      const result = await repo.searchProducts({ category: "ram", minPrice: 100, maxPrice: 150 }, scopeUS);
      expect(result.results).toHaveLength(1);
      expect(result.results[0].id).toBe("p2");
    });

    it("attaches normalized ProductOffer with sourceType: 'scraped' and priceMinor", async () => {
      insertProduct(db, {
        id: "gpu-4070",
        name: "GeForce RTX 4070",
        category: "gpu",
        price: 599.99,
        retailer: "BestBuy",
        url: "https://bestbuy.com/rtx-4070"
      });

      const res = await repo.searchProducts({ category: "gpu" }, scopeUS);
      expect(res.results).toHaveLength(1);

      const item = res.results[0];
      expect(item.offers).toBeDefined();
      expect(item.offers).toHaveLength(1);

      const offer = item.offers![0];
      expect(offer.productId).toBe("gpu-4070");
      expect(offer.sourceType).toBe("scraped");
      expect(offer.retailer).toBe("BestBuy");
      expect(offer.countryCode).toBe("US");
      expect(offer.currencyCode).toBe("USD");
      expect(offer.price).toBe(599.99);
      expect(offer.priceMinor).toBe(59999);
      expect(offer.inStock).toBe(true);
      expect(offer.availability).toBe("in_stock");
      expect(offer.destinationUrl).toBe("https://bestbuy.com/rtx-4070");
    });

    it("filters out out-of-stock items by default, returning them when in_stock: false", async () => {
      insertProduct(db, { id: "live", category: "cpu", in_stock: 1, price: 200 });
      insertProduct(db, { id: "retired", category: "cpu", in_stock: 0, price: 150 });

      const liveResult = await repo.searchProducts({ category: "cpu" }, scopeUS);
      expect(liveResult.results.map((r) => r.id)).toEqual(["live"]);

      const retiredResult = await repo.searchProducts({ category: "cpu", in_stock: false }, scopeUS);
      expect(retiredResult.results.map((r) => r.id)).toEqual(["retired"]);
    });

    it("returns both in-stock and out-of-stock items when inStockOnly: false", async () => {
      insertProduct(db, { id: "live", category: "cpu", in_stock: 1, price: 200 });
      insertProduct(db, { id: "retired", category: "cpu", in_stock: 0, price: 150 });

      const allResult = await repo.searchProducts({ category: "cpu", inStockOnly: false }, scopeUS);
      expect(allResult.results).toHaveLength(2);
    });

    it("performs case-insensitive parameterized search on term/query", async () => {
      insertProduct(db, { id: "c1", name: "AMD Ryzen 7 7800X3D Processor", normalized_name: "amd ryzen 7 7800x3d" });
      insertProduct(db, { id: "c2", name: "Intel Core i7-14700K Processor", normalized_name: "intel core i7 14700k" });

      const resTerm = await repo.searchProducts({ term: "RYZEN" }, scopeUS);
      expect(resTerm.results).toHaveLength(1);
      expect(resTerm.results[0].id).toBe("c1");

      const resQuery = await repo.searchProducts({ query: "14700k" }, scopeUS);
      expect(resQuery.results).toHaveLength(1);
      expect(resQuery.results[0].id).toBe("c2");
    });

    it("handles SQL injection strings safely without throwing", async () => {
      const res = await repo.searchProducts({ term: "'; DROP TABLE products; --" }, scopeUS);
      expect(res.results).toEqual([]);
      expect(res.totalCount).toBe(0);
    });

    it("filters by subcategory and defaults to build-relevant internal rows", async () => {
      insertProduct(db, { id: "ssd-int", category: "storage", subcategory: "internal", price: 100 });
      insertProduct(db, { id: "usb-ext", category: "storage", subcategory: "external", price: 80 });

      const defaultSearch = await repo.searchProducts({ category: "storage" }, scopeUS);
      expect(defaultSearch.results.map((r) => r.id)).toEqual(["ssd-int"]);

      const explicitSearch = await repo.searchProducts({ category: "storage", subcategory: "external" }, scopeUS);
      expect(explicitSearch.results.map((r) => r.id)).toEqual(["usb-ext"]);
    });

    it("filters products by registry specifications", async () => {
      insertProduct(db, {
        id: "cpu-am5",
        name: "AMD Ryzen 5 7600",
        category: "cpu",
        price: 200,
        specs: { socket: "AM5", ddr: "DDR5", tdp_w: 65 }
      });
      insertProduct(db, {
        id: "cpu-lga1700",
        name: "Intel Core i5-13600K",
        category: "cpu",
        price: 280,
        specs: { socket: "LGA 1700", ddr: "DDR5", tdp_w: 125 }
      });

      const am5Result = await repo.searchProducts({ category: "cpu", socket: "AM5" }, scopeUS);
      expect(am5Result.results.map((r) => r.id)).toEqual(["cpu-am5"]);

      const tdpResult = await repo.searchProducts({ category: "cpu", max_tdp_w: 100 }, scopeUS);
      expect(tdpResult.results.map((r) => r.id)).toEqual(["cpu-am5"]);
    });

    it("handles limit 0 safely by returning 0 items with accurate totalCount", async () => {
      insertProduct(db, { id: "p1", category: "cooler", price: 50 });
      insertProduct(db, { id: "p2", category: "cooler", price: 90 });

      const res = await repo.searchProducts({ category: "cooler", limit: 0 }, scopeUS);
      expect(res.results).toHaveLength(0);
      expect(res.items).toHaveLength(0);
      expect(res.totalCount).toBe(2);
    });

    it("handles offset pagination correctly", async () => {
      for (let i = 1; i <= 6; i++) {
        insertProduct(db, { id: `item-${i}`, category: "case", price: i * 20 });
      }

      const page1 = await repo.searchProducts({ category: "case", limit: 2, offset: 0 }, scopeUS);
      expect(page1.results).toHaveLength(2);
      expect(page1.totalCount).toBe(6);

      const page2 = await repo.searchProducts({ category: "case", limit: 2, offset: 2 }, scopeUS);
      expect(page2.results).toHaveLength(2);
      expect(page2.results[0].id).not.toBe(page1.results[0].id);
    });

    it("reports nearest_above and nearest_below when search bounds exclude price gap", async () => {
      insertProduct(db, { id: "budget", name: "Budget CPU", category: "cpu", price: 100, in_stock: 1 });
      insertProduct(db, { id: "premium", name: "Premium CPU", category: "cpu", price: 300, in_stock: 1 });

      const gapResult = await repo.searchProducts(
        { category: "cpu", price_min: 150, price_max: 250 },
        scopeUS
      );

      expect(gapResult.results).toHaveLength(0);
      expect(gapResult.nearest_below).toEqual(expect.objectContaining({ name: "Budget CPU", price: 100 }));
      expect(gapResult.nearest_above).toEqual(expect.objectContaining({ name: "Premium CPU", price: 300 }));
      expect(gapResult.hint).toMatch(/nearest cheaper option is budget cpu/i);
    });
  });

  describe("getCategoryBaseline", () => {
    it("returns baseline counts and in-stock price bounds", async () => {
      insertProduct(db, { id: "p1", category: "psu", price: 80, in_stock: 1 });
      insertProduct(db, { id: "p2", category: "psu", price: 140, in_stock: 1 });
      insertProduct(db, { id: "p3", category: "psu", price: 40, in_stock: 0 }); // out of stock

      const baseline = await repo.getCategoryBaseline("psu", scopeUS);
      expect(baseline.total).toBe(3);
      expect(baseline.in_stock_total).toBe(2);
      expect(baseline.min_price).toBe(80); // ignores out of stock 40
      expect(baseline.max_price).toBe(140);

      // Aliases
      expect(baseline.totalCount).toBe(3);
      expect(baseline.inStockTotal).toBe(2);
      expect(baseline.minPrice).toBe(80);
      expect(baseline.maxPrice).toBe(140);
    });

    it("returns zeros and nulls for empty category", async () => {
      const baseline = await repo.getCategoryBaseline("motherboard", scopeUS);
      expect(baseline.total).toBe(0);
      expect(baseline.in_stock_total).toBe(0);
      expect(baseline.min_price).toBeNull();
      expect(baseline.max_price).toBeNull();
    });
  });

  describe("getFreshness", () => {
    it("returns product count and latest scrape timestamp", async () => {
      insertProduct(db, { id: "p1", last_scraped: "2026-09-01T10:00:00.000Z", country_code: "US" });
      insertProduct(db, { id: "p2", last_scraped: "2026-09-02T12:00:00.000Z", country_code: "US" });
      insertProduct(db, { id: "p3", last_scraped: "2026-09-01T08:00:00.000Z", country_code: "IN" });

      const globalFreshness = await repo.getFreshness();
      expect(globalFreshness.productCount).toBe(3);
      expect(globalFreshness.lastScraped).toBe("2026-09-02T12:00:00.000Z");

      const inFreshness = await repo.getFreshness("IN");
      expect(inFreshness.productCount).toBe(1);
      expect(inFreshness.lastScraped).toBe("2026-09-01T08:00:00.000Z");
      expect(inFreshness.countryCode).toBe("IN");
    });
  });
});
