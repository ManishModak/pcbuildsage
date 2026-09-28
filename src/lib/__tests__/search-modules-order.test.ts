import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initializeSchema } from "@/lib/db";
import type { Product } from "@/types/db";
import { SqliteCatalogRepository } from "@/lib/catalog/sqlite-repository";
import type { CatalogScope } from "@/lib/catalog/repository";
import { matchesModules, resolveRamModules } from "@/lib/catalog/spec-filters";
import { searchProducts, searchProductsInputSchema } from "@/lib/tools/search-products";
import { listModels, listModelsInputSchema } from "@/lib/tools/list-models";

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
    category: product.category ?? "ram",
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

describe("search filters: modules and order-as-sort-field", () => {
  let db: Database.Database;
  let repo: SqliteCatalogRepository;
  const scope: CatalogScope = { countryCode: "US", currency: "USD" };

  beforeEach(() => {
    db = createInMemoryDb();
    repo = new SqliteCatalogRepository(db);
    insertProduct(db, {
      id: "ram-1x16",
      name: "Corsair Vengeance LPX 16GB (1x16GB) DDR4 3200MHz",
      price: 55,
      category: "ram"
    });
    insertProduct(db, {
      id: "ram-2x8",
      name: "Corsair Vengeance LPX 16GB (2x8GB) DDR4 3200MHz",
      price: 58,
      category: "ram"
    });
    insertProduct(db, {
      id: "ram-kit2",
      name: "G.Skill Ripjaws V 32GB kit of 2 DDR4 3600MHz",
      price: 95,
      category: "ram"
    });
    insertProduct(db, {
      id: "ram-json",
      name: "Generic Memory Stick",
      price: 40,
      category: "ram",
      specs: { modules: 2, capacity_gb: 16 }
    });
  });

  afterEach(async () => {
    await repo.close();
    db.close();
  });

  describe("resolveRamModules / matchesModules", () => {
    it("prefers the registry modules number", () => {
      expect(resolveRamModules({ brand: "B", model: "M", aliases: [], modules: 4 }, "Single Stick 16GB")).toBe(4);
    });

    it("parses 2x8GB style kit notation from the title", () => {
      expect(resolveRamModules(undefined, "Corsair Vengeance 16GB (2x8GB) DDR4")).toBe(2);
      expect(resolveRamModules(undefined, "Corsair Vengeance 16GB (1x16GB) DDR4")).toBe(1);
    });

    it("parses capacity-first titles and ignores speed numbers", () => {
      expect(resolveRamModules(undefined, "Teamgroup T-Force 32GB (16GBx2) DDR5 6000MHz")).toBe(2);
      expect(resolveRamModules(undefined, "Kingston Fury Beast 16GB x 1 DDR4")).toBe(1);
      // A speed next to a capacity is not a stick count.
      expect(resolveRamModules(undefined, "Vengeance 3200 x 16GB DDR4")).toBeUndefined();
    });

    it("lets the retail title win over a registry name shared across kit variants", () => {
      expect(resolveRamModules({ brand: "C", model: "Vengeance LPX 2x8GB", aliases: [] }, "Corsair Vengeance LPX 16GB (1x16GB)")).toBe(1);
    });

    it("parses kit-of-N titles", () => {
      expect(resolveRamModules(undefined, "G.Skill Ripjaws 32GB kit of 2 DDR4")).toBe(2);
      expect(resolveRamModules(undefined, "Corsair Dominator Kit of 4 DDR5")).toBe(4);
    });

    it("returns undefined when no source states a count", () => {
      expect(resolveRamModules(undefined, "Generic Memory Stick")).toBeUndefined();
      expect(matchesModules(undefined, undefined, "Generic Memory Stick")).toBe(true);
      expect(matchesModules(undefined, 2, "Generic Memory Stick")).toBe(false);
    });
  });

  describe("schema acceptance (previously rejected model calls)", () => {
    it('accepts order:"price" as a sort field', () => {
      const result = searchProductsInputSchema.safeParse({ category: "ram", order: "price" });
      expect(result.success).toBe(true);
    });

    it('accepts modules:"2" as a coerced integer', () => {
      const parsed = searchProductsInputSchema.parse({ category: "ram", modules: "2" });
      expect(parsed.modules).toBe(2);
    });

    it("accepts modules:2 on list_models", () => {
      expect(listModelsInputSchema.safeParse({ category: "ram", modules: 2 }).success).toBe(true);
      expect(listModelsInputSchema.parse({ category: "ram", modules: "2" }).modules).toBe(2);
    });

    it("still rejects genuinely invalid order and modules values", () => {
      expect(searchProductsInputSchema.safeParse({ category: "ram", order: "sideways" }).success).toBe(false);
      expect(searchProductsInputSchema.safeParse({ category: "ram", modules: 0 }).success).toBe(false);
      expect(searchProductsInputSchema.safeParse({ category: "ram", modules: "two" }).success).toBe(false);
    });
  });

  describe("search_products behavior", () => {
    it('treats order:"price" as sort_by with the default direction', async () => {
      const parsed = searchProductsInputSchema.parse({ category: "ram", order: "price" });
      const result = await searchProducts(parsed, scope, repo);
      expect(result.error).toBeUndefined();
      // Default direction for price is descending.
      expect(result.results.map((r) => r.id)).toEqual(["ram-kit2", "ram-2x8", "ram-1x16", "ram-json"]);
    });

    it("filters dual-channel kits with modules:2", async () => {
      const result = await searchProducts({ category: "ram", modules: 2 }, scope, repo);
      expect(result.error).toBeUndefined();
      expect(result.results.map((r) => r.id).sort()).toEqual(["ram-2x8", "ram-json", "ram-kit2"]);
    });

    it("filters single-stick kits with modules:1", async () => {
      const result = await searchProducts({ category: "ram", modules: 1 }, scope, repo);
      expect(result.results.map((r) => r.id)).toEqual(["ram-1x16"]);
    });
  });

  describe("list_models behavior", () => {
    it("filters dual-channel models with modules:2", async () => {
      const result = await listModels({ category: "ram", modules: 2 }, scope, repo);
      expect(result.error).toBeUndefined();
      expect(result.total_matching_models).toBe(3);
      expect(result.models.some((m) => m.name.includes("1x16GB"))).toBe(false);
    });
  });
});
