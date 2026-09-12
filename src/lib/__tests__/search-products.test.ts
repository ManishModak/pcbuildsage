import { describe, expect, it, vi } from "vitest";
import type { Product } from "@/types";
import Database from "better-sqlite3";
import { initializeSchema } from "../db";

const state = vi.hoisted(() => ({
  specs: new Map<string, unknown>(),
  offsets: [] as number[],
  resolveDbs: [] as unknown[],
  memoryDb: null as InstanceType<typeof Database> | null
}));

vi.mock("../db", async (importOriginal) => {
  const original = await importOriginal<typeof import("../db")>();
  return {
    ...original,
    getDb: () => state.memoryDb
  };
});

vi.mock("../registry", () => ({
  resolveComponent: (input: { key?: string; category?: string }, options?: { db?: unknown }) => {
    state.resolveDbs.push(options?.db);
    const spec = input.key ? state.specs.get(input.key) : undefined;
    return spec ? { key: input.key, category: input.category, spec, source: "registry", confidence: "high" } : undefined;
  }
}));

function resetDb() {
  if (state.memoryDb) {
    state.memoryDb.close();
  }
  state.memoryDb = new Database(":memory:");
  initializeSchema(state.memoryDb);
  
  state.specs.clear();
  state.offsets = [];
  state.resolveDbs = [];

  const originalPrepare = state.memoryDb.prepare.bind(state.memoryDb);
  state.memoryDb.prepare = ((sql: string) => {
    const statement = originalPrepare(sql);
    const originalAll = statement.all.bind(statement);
    statement.all = function (this: unknown, ...params: unknown[]) {
      if (sql.includes("LIMIT ? OFFSET ?") || sql.includes("OFFSET")) {
        const offset = params[params.length - 1];
        if (typeof offset === "number") {
          state.offsets.push(offset);
        }
      }
      return originalAll(...params);
    } as typeof statement.all;
    return statement;
  }) as typeof state.memoryDb.prepare;

  return ":memory:";
}

function addProduct(overrides: Partial<Product>) {
  const firstSeen = "2026-01-01T00:00:00.000Z";
  const product = {
    id: overrides.id ?? "unknown",
    name: overrides.name ?? overrides.id ?? "unknown",
    normalized_name: overrides.normalized_name ?? overrides.name ?? overrides.id ?? "unknown",
    registry_key: overrides.registry_key ?? overrides.id ?? null,
    price: overrides.price ?? 1,
    currency: overrides.currency ?? "INR",
    country_code: overrides.country_code ?? "IN",
    retailer: overrides.retailer ?? "Local",
    url: overrides.url ?? `https://example.com/${overrides.id}`,
    image_url: overrides.image_url ?? null,
    in_stock: overrides.in_stock ?? 1,
    category: overrides.category ?? "unknown",
    subcategory: overrides.subcategory ?? null,
    specs: overrides.specs ?? null,
    first_seen: overrides.first_seen ?? firstSeen,
    last_scraped: overrides.last_scraped ?? firstSeen
  };

  state.memoryDb!.prepare(`
    INSERT INTO products (id, name, normalized_name, registry_key, price, currency, country_code, retailer, url, image_url, in_stock, category, subcategory, specs, first_seen, last_scraped)
    VALUES (@id, @name, @normalized_name, @registry_key, @price, @currency, @country_code, @retailer, @url, @image_url, @in_stock, @category, @subcategory, @specs, @first_seen, @last_scraped)
  `).run(product);
}

describe("searchProducts", () => {
  it("returns an empty result with a hint instead of throwing", async () => {
    const { searchProducts } = await import("../tools/search-products");
    const dbPath = resetDb();
    await expect(searchProducts({ category: "gpu", price_max: 1, in_stock: true, sort_by: "price", order: "asc", limit: 20 }, { dbPath, countryCode: "IN", currency: "INR" })).resolves.toEqual(
      expect.objectContaining({ results: [], hint: expect.any(String) })
    );
  });

  it("reports category_total 0 and a do-not-retry hint for an empty category", async () => {
    const { searchProducts } = await import("../tools/search-products");
    const dbPath = resetDb();
    addProduct({ id: "gpu-1", price: 4600, category: "gpu" });

    const result = await searchProducts(
      { category: "motherboard", in_stock: true, sort_by: "price", order: "asc", limit: 20 },
      { dbPath, countryCode: "IN", currency: "INR" }
    );
    expect(result).toMatchObject({ results: [], category_total: 0 });
    expect((result as { hint: string }).hint).toMatch(/do not retry/i);
    expect(result).not.toHaveProperty("category_price_range");
  });

  it("reports the true category price range when filters exclude every match", async () => {
    const { searchProducts } = await import("../tools/search-products");
    const dbPath = resetDb();
    addProduct({ id: "gpu-cheap", price: 4600, category: "gpu" });
    addProduct({ id: "gpu-dear", price: 54999, category: "gpu" });

    const result = await searchProducts(
      { category: "gpu", price_max: 1, in_stock: true, sort_by: "price", order: "asc", limit: 20 },
      { dbPath, countryCode: "IN", currency: "INR" }
    );
    expect(result).toMatchObject({
      results: [],
      category_total: 2,
      category_price_range: { min: 4600, max: 54999 }
    });
  });

  it("includes category_total on a successful search", async () => {
    const { searchProducts } = await import("../tools/search-products");
    const dbPath = resetDb();
    addProduct({ id: "gpu-1", price: 4600, category: "gpu" });
    addProduct({ id: "gpu-2", price: 9999, category: "gpu" });

    const result = await searchProducts(
      { category: "gpu", in_stock: true, sort_by: "price", order: "asc", limit: 20 },
      { dbPath, countryCode: "IN", currency: "INR" }
    );
    expect(result).toMatchObject({ category_total: 2 });
    expect((result as { results: unknown[] }).results).toHaveLength(2);
  });

  it("filters by registry specs after reading product registry keys", async () => {
    const { searchProducts } = await import("../tools/search-products");
    const dbPath = resetDb();
    state.specs.set("intel-core-i9-14900k", { brand: "Intel", model: "Intel Core i9-14900K", aliases: [], socket: "LGA 1700", ddr: "DDR5", tdp_w: 125 });
    addProduct({ id: "cpu-1", name: "Intel Core i9-14900K", registry_key: "intel-core-i9-14900k", price: 50000, category: "cpu" });

    const result = await searchProducts({ category: "cpu", socket: "LGA 1700", ddr: "DDR5", in_stock: true, sort_by: "price", order: "asc", limit: 20 }, { dbPath, countryCode: "IN", currency: "INR" });
    expect(result).toMatchObject({ results: [expect.objectContaining({ id: "cpu-1", specs: expect.objectContaining({ socket: "LGA 1700" }) })] });
    expect(state.resolveDbs).toContain(state.memoryDb);
  });

  it("continues scanning later DB batches until registry-filtered matches are found", async () => {
    const { searchProducts } = await import("../tools/search-products");
    const dbPath = resetDb();
    for (let index = 0; index < 300; index += 1) {
      const key = `gpu-${index}`;
      state.specs.set(key, { brand: "NVIDIA", model: `GPU ${index}`, aliases: [], vram_gb: index === 275 ? 16 : 8 });
      addProduct({ id: key, registry_key: key, price: index + 1, category: "gpu" });
    }

    const result = await searchProducts({ category: "gpu", min_vram_gb: 16, in_stock: true, sort_by: "price", order: "asc", limit: 1 }, { dbPath, countryCode: "IN", currency: "INR" });
    expect(state.offsets).toEqual([0, 250]);
    expect(result).toMatchObject({ results: [expect.objectContaining({ id: "gpu-275" })] });
  });

  it("defaults to build-relevant products (subcategory IS NULL or 'internal') if subcategory is omitted", async () => {
    const { searchProducts } = await import("../tools/search-products");
    const dbPath = resetDb();
    addProduct({ id: "drive-internal", category: "storage", subcategory: "internal", price: 5000 });
    addProduct({ id: "drive-external", category: "storage", subcategory: "external", price: 6000 });
    addProduct({ id: "drive-null", category: "storage", subcategory: null, price: 4000 });

    const result = await searchProducts(
      { category: "storage", in_stock: true, sort_by: "price", order: "asc", limit: 20 },
      { dbPath, countryCode: "IN", currency: "INR" }
    );
    const ids = (result.results ?? []).map((r: { id: string }) => r.id);
    expect(ids).toContain("drive-internal");
    expect(ids).toContain("drive-null");
    expect(ids).not.toContain("drive-external");
  });

  it("filters by subcategory exactly when explicit override is provided", async () => {
    const { searchProducts } = await import("../tools/search-products");
    const dbPath = resetDb();
    addProduct({ id: "drive-internal", category: "storage", subcategory: "internal", price: 5000 });
    addProduct({ id: "drive-external", category: "storage", subcategory: "external", price: 6000 });
    addProduct({ id: "drive-removable", category: "storage", subcategory: "removable", price: 1000 });

    const result = await searchProducts(
      { category: "storage", subcategory: "external", in_stock: true, sort_by: "price", order: "asc", limit: 20 },
      { dbPath, countryCode: "IN", currency: "INR" }
    );
    const ids = (result.results ?? []).map((r: { id: string }) => r.id);
    expect(ids).toEqual(["drive-external"]);
  });

  it("reports price range and count of the specific subcategory slice in zero-result hint", async () => {
    const { searchProducts } = await import("../tools/search-products");
    const dbPath = resetDb();
    addProduct({ id: "drive-internal", category: "storage", subcategory: "internal", price: 5000 });
    addProduct({ id: "drive-external", category: "storage", subcategory: "external", price: 6000 });

    const emptyResult = await searchProducts(
      { category: "storage", subcategory: "removable", in_stock: true, sort_by: "price", order: "asc", limit: 20 },
      { dbPath, countryCode: "IN", currency: "INR" }
    );
    expect(emptyResult.hint).toMatch(/No removable storage products exist/i);

    const filterOutResult = await searchProducts(
      { category: "storage", subcategory: "external", price_min: 10000, in_stock: true, sort_by: "price", order: "asc", limit: 20 },
      { dbPath, countryCode: "IN", currency: "INR" }
    );
    expect(filterOutResult.hint).toMatch(/1 of 1 external storage products are in stock but none match/i);
    expect(filterOutResult.hint).toMatch(/In-stock prices range 6000-6000/i);
  });

  it("reports nearest_above and nearest_below when search filters exclude a price gap", async () => {
    const { searchProducts } = await import("../tools/search-products");
    const dbPath = resetDb();
    addProduct({ id: "cpu-budget", category: "cpu", price: 12000, in_stock: 1, name: "Ryzen 5 5600" });
    addProduct({ id: "cpu-premium", category: "cpu", price: 22000, in_stock: 1, name: "Ryzen 5 7600" });

    // Model queries a price gap between 14,000 and 18,000 where no product exists
    const gapResult = await searchProducts(
      { category: "cpu", price_min: 14000, price_max: 18000, in_stock: true, sort_by: "price", order: "asc", limit: 20 },
      { dbPath, countryCode: "IN", currency: "INR" }
    );

    expect(gapResult).toMatchObject({
      results: [],
      category_total: 2,
      in_stock_total: 2,
      nearest_below: expect.objectContaining({ name: "Ryzen 5 5600", price: 12000 }),
      nearest_above: expect.objectContaining({ name: "Ryzen 5 7600", price: 22000 })
    });
    expect((gapResult as { hint: string }).hint).toMatch(/Nearest cheaper option is Ryzen 5 5600 at 12000/i);
    expect((gapResult as { hint: string }).hint).toMatch(/nearest higher option is Ryzen 5 7600 at 22000/i);
  });

  it("filters by segment for registry-resolved specs", async () => {
    const { searchProducts } = await import("../tools/search-products");
    const dbPath = resetDb();
    state.specs.set("nvidia-rtx-5090", { brand: "NVIDIA", model: "RTX 5090", aliases: [], segment: "gaming" });
    state.specs.set("nvidia-rtx-a400", { brand: "NVIDIA", model: "RTX A400", aliases: [], segment: "workstation" });

    addProduct({ id: "gpu-gaming", registry_key: "nvidia-rtx-5090", category: "gpu" });
    addProduct({ id: "gpu-workstation", registry_key: "nvidia-rtx-a400", category: "gpu" });

    const result = await searchProducts(
      { category: "gpu", segment: "gaming", in_stock: true, sort_by: "price", order: "asc", limit: 20 },
      { dbPath, countryCode: "IN", currency: "INR" }
    );
    const ids = (result.results ?? []).map((r: { id: string }) => r.id);
    expect(ids).toEqual(["gpu-gaming"]);
  });

  it("excludes out-of-stock rows by default so a retired listing cannot enter a build", async () => {
    const { searchProducts, searchProductsInputSchema } = await import("../tools/search-products");
    const dbPath = resetDb();
    addProduct({ id: "gpu-live", price: 40000, category: "gpu", in_stock: 1 });
    addProduct({ id: "gpu-retired", price: 4600, category: "gpu", in_stock: 0 });

    // Parse through the schema so the test exercises the default, not a hand-passed flag.
    const input = searchProductsInputSchema.parse({ category: "gpu", limit: 20 });
    const result = await searchProducts(input, { dbPath, countryCode: "IN", currency: "INR" });
    const ids = (result.results ?? []).map((row: { id: string }) => row.id);
    expect(ids).toEqual(["gpu-live"]);
  });

  it("returns retired rows only when in_stock is explicitly false", async () => {
    const { searchProducts } = await import("../tools/search-products");
    const dbPath = resetDb();
    addProduct({ id: "gpu-live", price: 40000, category: "gpu", in_stock: 1 });
    addProduct({ id: "gpu-retired", price: 4600, category: "gpu", in_stock: 0 });

    const result = await searchProducts(
      { category: "gpu", in_stock: false, sort_by: "price", order: "asc", limit: 20 },
      { dbPath, countryCode: "IN", currency: "INR" }
    );
    const ids = (result.results ?? []).map((row: { id: string }) => row.id);
    expect(ids).toEqual(["gpu-retired"]);
  });

  it("tells the model a fully retired category is unavailable rather than to widen filters", async () => {
    const { searchProducts } = await import("../tools/search-products");
    const dbPath = resetDb();
    addProduct({ id: "gpu-a", price: 4600, category: "gpu", in_stock: 0 });
    addProduct({ id: "gpu-b", price: 54999, category: "gpu", in_stock: 0 });

    const result = await searchProducts(
      { category: "gpu", in_stock: true, sort_by: "price", order: "asc", limit: 20 },
      { dbPath, countryCode: "IN", currency: "INR" }
    );
    expect(result).toMatchObject({ results: [], category_total: 2, in_stock_total: 0 });
    expect((result as { hint: string }).hint).toMatch(/out of stock/i);
    // The "adjust your price bounds" branch must not fire: there is no band to aim at.
    expect(result).not.toHaveProperty("category_price_range");
  });

  it("reports the in-stock price band, ignoring retired listings", async () => {
    const { searchProducts } = await import("../tools/search-products");
    const dbPath = resetDb();
    addProduct({ id: "gpu-live-low", price: 30000, category: "gpu", in_stock: 1 });
    addProduct({ id: "gpu-live-high", price: 60000, category: "gpu", in_stock: 1 });
    addProduct({ id: "gpu-retired", price: 999, category: "gpu", in_stock: 0 });

    const result = await searchProducts(
      { category: "gpu", price_max: 1, in_stock: true, sort_by: "price", order: "asc", limit: 20 },
      { dbPath, countryCode: "IN", currency: "INR" }
    );
    expect(result).toMatchObject({
      results: [],
      category_total: 3,
      in_stock_total: 2,
      category_price_range: { min: 30000, max: 60000 }
    });
  });

  it("reports pagination metadata and composable hints when results exceed limit", async () => {
    const { searchProducts } = await import("../tools/search-products");
    const dbPath = resetDb();
    for (let i = 1; i <= 10; i++) {
      addProduct({ id: `gpu-${i}`, name: `GPU Model ${i}`, price: 10000 + i * 2000, category: "gpu", in_stock: 1 });
    }
    // Also add one item above price_max to test nearest_above preservation
    addProduct({ id: "gpu-expensive", name: "GPU Super", price: 50000, category: "gpu", in_stock: 1 });

    const result = await searchProducts(
      { category: "gpu", price_max: 35000, in_stock: true, sort_by: "price", order: "asc", limit: 3 },
      { dbPath, countryCode: "IN", currency: "INR" }
    );

    expect(result).toMatchObject({
      returned: 3,
      total_matching: 10,
      has_more: true,
      batch_price_range: { min: 12000, max: 16000 },
      nearest_above: expect.objectContaining({ name: "GPU Super", price: 50000 })
    });
    expect((result as { hint: string }).hint).toContain("Showing 3 of 10 matching in-stock products");
    expect((result as { hint: string }).hint).toContain("Closest in-stock option above your price_max (35000) is GPU Super at 50000");
  });

  it("filters storage by min_capacity_gb and interface", async () => {
    const { searchProducts } = await import("../tools/search-products");
    const dbPath = resetDb();
    state.specs.set("drive-256-sata", { capacity_gb: 256, interface: "sata" });
    state.specs.set("drive-512-sata", { capacity_gb: 512, interface: "sata" });
    state.specs.set("drive-512-nvme", { capacity_gb: 512, interface: "nvme" });
    state.specs.set("drive-1000-nvme", { capacity_gb: 1000, interface: "nvme" });

    addProduct({ id: "drive-256-sata", price: 3000, category: "storage", registry_key: "drive-256-sata", in_stock: 1 });
    addProduct({ id: "drive-512-sata", price: 5800, category: "storage", registry_key: "drive-512-sata", in_stock: 1 });
    addProduct({ id: "drive-512-nvme", price: 6800, category: "storage", registry_key: "drive-512-nvme", in_stock: 1 });
    addProduct({ id: "drive-1000-nvme", price: 12000, category: "storage", registry_key: "drive-1000-nvme", in_stock: 1 });

    const result = await searchProducts(
      { category: "storage", min_capacity_gb: 500, interface: "nvme", sort_by: "price", order: "asc", limit: 10 },
      { dbPath, countryCode: "IN", currency: "INR" }
    );

    expect((result as { results: Array<{ id: string }> }).results.map((r) => r.id)).toEqual(["drive-512-nvme", "drive-1000-nvme"]);
  });

  it("filters PSU by min_wattage", async () => {
    const { searchProducts } = await import("../tools/search-products");
    const dbPath = resetDb();
    state.specs.set("psu-550", { wattage_w: 550 });
    state.specs.set("psu-650", { wattage_w: 650 });
    state.specs.set("psu-750", { wattage_w: 750 });

    addProduct({ id: "psu-550", price: 2300, category: "psu", registry_key: "psu-550", in_stock: 1 });
    addProduct({ id: "psu-650", price: 3300, category: "psu", registry_key: "psu-650", in_stock: 1 });
    addProduct({ id: "psu-750", price: 4500, category: "psu", registry_key: "psu-750", in_stock: 1 });

    const result = await searchProducts(
      { category: "psu", min_wattage: 650, sort_by: "price", order: "asc", limit: 10 },
      { dbPath, countryCode: "IN", currency: "INR" }
    );

    expect((result as { results: Array<{ id: string }> }).results.map((r) => r.id)).toEqual(["psu-650", "psu-750"]);
  });

  it("enforces the schema limit cap", () => {
    return import("../tools/search-products").then(({ searchProductsInputSchema }) => {
      expect(searchProductsInputSchema.safeParse({ limit: 50 }).success).toBe(true);
      expect(searchProductsInputSchema.safeParse({ limit: 51 }).success).toBe(false);
    });
  });

  it("supports full-text search via term and query filters", async () => {
    const { searchProducts } = await import("../tools/search-products");
    const dbPath = resetDb();

    addProduct({ id: "gpu-4070", name: "Zotac RTX 4070 Super", price: 58000, category: "gpu", in_stock: 1 });
    addProduct({ id: "gpu-4060", name: "Asus RTX 4060 Dual", price: 32000, category: "gpu", in_stock: 1 });

    // Test with canonical 'term'
    const resultTerm = await searchProducts(
      { term: "4070", category: "gpu" },
      { dbPath, countryCode: "IN", currency: "INR" }
    );
    expect(resultTerm.error).toBeUndefined();
    expect(resultTerm.results.map((r) => r.id)).toEqual(["gpu-4070"]);

    // Test with alias 'query'
    const resultQuery = await searchProducts(
      { query: "4070", category: "gpu" },
      { dbPath, countryCode: "IN", currency: "INR" }
    );
    expect(resultQuery.error).toBeUndefined();
    expect(resultQuery.results.map((r) => r.id)).toEqual(["gpu-4070"]);
  });
});
