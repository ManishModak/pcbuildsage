import { describe, expect, it, vi } from "vitest";
import type { Product } from "../db-types";

interface MockDb {
  prepare: (sql: string) => {
    all: (...params: unknown[]) => unknown[];
  };
}

const state = vi.hoisted(() => ({
  rows: [] as Product[],
  db: {} as unknown as MockDb
}));

vi.mock("../db", () => ({
  getDb: () => state.db
}));

function resetDb() {
  state.rows = [];
  state.db = {
    prepare: (_sql: string) => ({
      all: (...params: unknown[]) => {
        const [country, currency] = params;
        const scoped = state.rows.filter((row) => row.country_code === country && row.currency === currency);
        const groups = new Map<string, Product[]>();
        for (const row of scoped) {
          const bucket = groups.get(row.category) ?? [];
          bucket.push(row);
          groups.set(row.category, bucket);
        }
        const aggregated = [...groups.entries()].map(([category, rows]) => {
          const prices = rows.map((row) => row.price_minor).filter((price): price is number => price !== null);
          return {
            category,
            count: rows.length,
            in_stock_count: rows.reduce((sum, row) => sum + (row.in_stock ?? 0), 0),
            price_min: prices.length ? Math.min(...prices) : null,
            price_max: prices.length ? Math.max(...prices) : null
          };
        });
        return aggregated.sort((a, b) => b.count - a.count);
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

describe("getCatalog", () => {
  it("aggregates populated categories and omits categories with no rows", async () => {
    const { getCatalog } = await import("../tools/get-catalog");
    const dbPath = resetDb();
    addProduct({ id: "gpu-1", price_minor: 460000, category: "gpu", in_stock: 1 });
    addProduct({ id: "gpu-2", price_minor: 999900, category: "gpu", in_stock: 1 });
    addProduct({ id: "cpu-1", price_minor: 50000, category: "cpu", in_stock: 1 });

    const result = await getCatalog({ dbPath, countryCode: "IN", currency: "INR" });

    expect(result.categories).toContainEqual({
      category: "gpu",
      count: 2,
      in_stock_count: 2,
      price_min_minor: 460000,
      price_max_minor: 999900
    });
    expect(result.categories.map((entry) => entry.category)).not.toContain("motherboard");
    expect(result.scope).toEqual({ country_code: "IN", currency: "INR" });
  });

  it("returns an empty categories array for an empty catalog", async () => {
    const { getCatalog } = await import("../tools/get-catalog");
    const dbPath = resetDb();

    const result = await getCatalog({ dbPath, countryCode: "IN", currency: "INR" });

    expect(result.categories).toEqual([]);
  });
});
