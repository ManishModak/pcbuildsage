import { describe, expect, it, vi } from "vitest";
import type { Product } from "@/types";
import Database from "better-sqlite3";
import { initializeSchema } from "../db";

const state = vi.hoisted(() => ({
  memoryDb: null as InstanceType<typeof Database> | null
}));

vi.mock("../db", async (importOriginal) => {
  const original = await importOriginal<typeof import("../db")>();
  return {
    ...original,
    getDb: () => state.memoryDb
  };
});

function resetDb() {
  if (state.memoryDb) {
    state.memoryDb.close();
  }
  state.memoryDb = new Database(":memory:");
  initializeSchema(state.memoryDb);
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

describe("getCatalog", () => {
  it("aggregates populated categories and includes all known categories", async () => {
    const { getCatalog } = await import("../tools/get-catalog");
    const dbPath = resetDb();
    addProduct({ id: "gpu-1", price: 4600, category: "gpu", in_stock: 1 });
    addProduct({ id: "gpu-2", price: 9999, category: "gpu", in_stock: 1 });
    addProduct({ id: "cpu-1", price: 500, category: "cpu", in_stock: 1 });

    const result = await getCatalog({ dbPath, countryCode: "IN", currency: "INR" });

    // Should find the gpu entry
    const gpu = result.categories.find(c => c.category === "gpu");
    expect(gpu).toEqual({
      category: "gpu",
      count: 2,
      in_stock_count: 2,
      price_min: 4600,
      price_max: 9999
    });

    // Should find the motherboard entry with 0 count
    const motherboard = result.categories.find(c => c.category === "motherboard");
    expect(motherboard).toEqual({
      category: "motherboard",
      count: 0,
      in_stock_count: 0,
      price_min: null,
      price_max: null,
      note: "No products in the catalog for this category. Do not recommend or invent specific products for it."
    });

    expect(result.categories.length).toEqual(8);
    expect(result.scope).toEqual({ country_code: "IN", currency: "INR" });
  });

  it("returns all categories with 0 count for an empty catalog", async () => {
    const { getCatalog } = await import("../tools/get-catalog");
    const dbPath = resetDb();

    const result = await getCatalog({ dbPath, countryCode: "IN", currency: "INR" });

    expect(result.categories.length).toEqual(8);
    result.categories.forEach((cat) => {
      expect(cat.count).toEqual(0);
      expect(cat.price_min).toBeNull();
      expect(cat.price_max).toBeNull();
      expect(cat.note).toBe("No products in the catalog for this category. Do not recommend or invent specific products for it.");
    });
  });
});
