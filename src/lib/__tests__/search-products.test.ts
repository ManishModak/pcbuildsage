import { describe, expect, it, vi } from "vitest";
import type { Product } from "../db-types";

interface MockDb {
  prepare: (sql: string) => {
    all: (...params: unknown[]) => Product[];
    get: (...params: unknown[]) => unknown;
  };
}

const state = vi.hoisted(() => ({
  rows: [] as Product[],
  specs: new Map<string, unknown>(),
  offsets: [] as number[],
  db: {} as unknown as MockDb,
  resolveDbs: [] as unknown[]
}));

vi.mock("../db", () => ({
  getDb: () => state.db
}));

vi.mock("../registry", () => ({
  resolveComponent: (input: { key?: string; category?: string }, options?: { db?: unknown }) => {
    state.resolveDbs.push(options?.db);
    const spec = input.key ? state.specs.get(input.key) : undefined;
    return spec ? { key: input.key, category: input.category, spec, source: "registry", confidence: "high" } : undefined;
  }
}));

function resetDb() {
  state.rows = [];
  state.specs.clear();
  state.offsets = [];
  state.resolveDbs = [];
  state.db = {
    prepare: (sql: string) => ({
      all: (...params: unknown[]) => {
        let index = 0;
        const country = params[index++];
        const currency = params[index++];
        let rows = state.rows.filter((row) => row.country_code === country && row.currency === currency);
        if (sql.includes("category = ?")) {
          const category = params[index++];
          rows = rows.filter((row) => row.category === category);
        }
        if (sql.includes("price_minor >= ?")) {
          const min = Number(params[index++]);
          rows = rows.filter((row) => row.price_minor !== null && row.price_minor >= min);
        }
        if (sql.includes("price_minor <= ?")) {
          const max = Number(params[index++]);
          rows = rows.filter((row) => row.price_minor !== null && row.price_minor <= max);
        }
        if (sql.includes("retailer LIKE ?")) {
          const retailer = String(params[index++]).replaceAll("%", "");
          rows = rows.filter((row) => row.retailer.includes(retailer));
        }
        if (sql.includes("in_stock = ?")) {
          const inStock = params[index++];
          rows = rows.filter((row) => row.in_stock === inStock);
        }
        const limit = Number(params[index++]);
        const offset = Number(params[index++]);
        state.offsets.push(offset);
        return rows.sort((a, b) => (a.price_minor ?? 0) - (b.price_minor ?? 0)).slice(offset, offset + limit);
      },
      get: (...params: unknown[]) => {
        // Category baseline COUNT/MIN/MAX query: (country, currency, category)
        const [country, currency, category] = params;
        const rows = state.rows.filter(
          (row) => row.country_code === country && row.currency === currency && row.category === category
        );
        const prices = rows.map((row) => row.price_minor).filter((price): price is number => price !== null);
        return {
          total: rows.length,
          min_price: prices.length ? Math.min(...prices) : null,
          max_price: prices.length ? Math.max(...prices) : null
        };
      }
    })
  };
  return "temp-products.sqlite";
}

function addProduct(overrides: Partial<Product>) {
  const firstSeen = "2026-01-01T00:00:00.000Z";
  state.rows.push({
    id: overrides.id ?? "unknown",
    name: overrides.name ?? overrides.id ?? "unknown",
    normalized_name: overrides.name ?? overrides.id ?? "unknown",
    registry_key: overrides.registry_key ?? overrides.id ?? null,
    price_minor: overrides.price_minor ?? 1,
    currency: "INR",
    country_code: "IN",
    retailer: "Local",
    url: `https://example.com/${overrides.id}`,
    image_url: null,
    in_stock: overrides.in_stock ?? 1,
    category: overrides.category ?? "unknown",
    specs: null,
    first_seen: firstSeen,
    last_scraped: firstSeen
  });
}

describe("searchProducts", () => {
  it("returns an empty result with a hint instead of throwing", async () => {
    const { searchProducts } = await import("../tools/search-products");
    const dbPath = resetDb();
    await expect(searchProducts({ category: "gpu", price_max: 1, sort_by: "price", order: "asc", limit: 20 }, { dbPath, countryCode: "IN", currency: "INR" })).resolves.toEqual(
      expect.objectContaining({ results: [], hint: expect.any(String) })
    );
  });

  it("reports category_total 0 and a do-not-retry hint for an empty category", async () => {
    const { searchProducts } = await import("../tools/search-products");
    const dbPath = resetDb();
    addProduct({ id: "gpu-1", price_minor: 460000, category: "gpu" });

    const result = await searchProducts(
      { category: "motherboard", sort_by: "price", order: "asc", limit: 20 },
      { dbPath, countryCode: "IN", currency: "INR" }
    );
    expect(result).toMatchObject({ results: [], category_total: 0 });
    expect((result as { hint: string }).hint).toMatch(/do not retry/i);
    expect(result).not.toHaveProperty("category_price_range_minor");
  });

  it("reports the true category price range when filters exclude every match", async () => {
    const { searchProducts } = await import("../tools/search-products");
    const dbPath = resetDb();
    addProduct({ id: "gpu-cheap", price_minor: 460000, category: "gpu" });
    addProduct({ id: "gpu-dear", price_minor: 5499900, category: "gpu" });

    const result = await searchProducts(
      { category: "gpu", price_max: 1, sort_by: "price", order: "asc", limit: 20 },
      { dbPath, countryCode: "IN", currency: "INR" }
    );
    expect(result).toMatchObject({
      results: [],
      category_total: 2,
      category_price_range_minor: { min: 460000, max: 5499900 }
    });
  });

  it("includes category_total on a successful search", async () => {
    const { searchProducts } = await import("../tools/search-products");
    const dbPath = resetDb();
    addProduct({ id: "gpu-1", price_minor: 460000, category: "gpu" });
    addProduct({ id: "gpu-2", price_minor: 999900, category: "gpu" });

    const result = await searchProducts(
      { category: "gpu", sort_by: "price", order: "asc", limit: 20 },
      { dbPath, countryCode: "IN", currency: "INR" }
    );
    expect(result).toMatchObject({ category_total: 2 });
    expect((result as { results: unknown[] }).results).toHaveLength(2);
  });

  it("filters by registry specs after reading product registry keys", async () => {
    const { searchProducts } = await import("../tools/search-products");
    const dbPath = resetDb();
    state.specs.set("intel-core-i9-14900k", { brand: "Intel", model: "Intel Core i9-14900K", aliases: [], socket: "LGA 1700", ddr: "DDR5", tdp_w: 125 });
    addProduct({ id: "cpu-1", name: "Intel Core i9-14900K", registry_key: "intel-core-i9-14900k", price_minor: 50000, category: "cpu" });

    const result = await searchProducts({ category: "cpu", socket: "LGA 1700", ddr: "DDR5", sort_by: "price", order: "asc", limit: 20 }, { dbPath, countryCode: "IN", currency: "INR" });
    expect(result).toMatchObject({ results: [expect.objectContaining({ id: "cpu-1", specs: expect.objectContaining({ socket: "LGA 1700" }) })] });
    expect(state.resolveDbs).toContain(state.db);
  });

  it("continues scanning later DB batches until registry-filtered matches are found", async () => {
    const { searchProducts } = await import("../tools/search-products");
    const dbPath = resetDb();
    for (let index = 0; index < 300; index += 1) {
      const key = `gpu-${index}`;
      state.specs.set(key, { brand: "NVIDIA", model: `GPU ${index}`, aliases: [], vram_gb: index === 275 ? 16 : 8 });
      addProduct({ id: key, registry_key: key, price_minor: index + 1, category: "gpu" });
    }

    const result = await searchProducts({ category: "gpu", min_vram_gb: 16, sort_by: "price", order: "asc", limit: 1 }, { dbPath, countryCode: "IN", currency: "INR" });
    expect(state.offsets).toEqual([0, 250]);
    expect(result).toMatchObject({ results: [expect.objectContaining({ id: "gpu-275" })] });
  });

  it("enforces the schema limit cap", () => {
    return import("../tools/search-products").then(({ searchProductsInputSchema }) => {
      expect(searchProductsInputSchema.safeParse({ limit: 50 }).success).toBe(true);
      expect(searchProductsInputSchema.safeParse({ limit: 51 }).success).toBe(false);
    });
  });
});
