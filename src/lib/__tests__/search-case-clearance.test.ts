import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initializeSchema } from "@/lib/db";
import type { Product } from "@/types/db";
import { SqliteCatalogRepository } from "@/lib/catalog/sqlite-repository";
import { searchProducts, searchProductsInputSchema, createSearchProductsTool } from "@/lib/tools/search-products";
import type { CatalogScope } from "@/lib/catalog/repository";

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
    category: product.category ?? "case",
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

describe("Case Clearance Filters, Limit Clamping, and Category Restrictions", () => {
  let db: Database.Database;
  let repo: SqliteCatalogRepository;
  const scope: CatalogScope = { countryCode: "US", currency: "USD" };

  beforeEach(() => {
    db = createInMemoryDb();
    repo = new SqliteCatalogRepository(db);
  });

  afterEach(async () => {
    await repo.close();
    db.close();
  });

  describe("min_gpu_clearance_mm filter", () => {
    it("matches cases with max_gpu_length_mm >= min_gpu_clearance_mm and excludes insufficient or missing clearance", async () => {
      insertProduct(db, {
        id: "case-roomy",
        name: "Corsair 4000D Airflow",
        category: "case",
        price: 104,
        specs: { max_gpu_length_mm: 360, max_cooler_height_mm: 170 }
      });

      insertProduct(db, {
        id: "case-compact",
        name: "Compact ITX Case",
        category: "case",
        price: 89,
        specs: { max_gpu_length_mm: 300, max_cooler_height_mm: 140 }
      });

      insertProduct(db, {
        id: "case-unknown",
        name: "Generic Case Without Specs",
        category: "case",
        price: 50,
        specs: null
      });

      // Filter for 330mm clearance: roomy (360) matches; compact (300) and unknown (null) do not match
      const res = await searchProducts({ category: "case", min_gpu_clearance_mm: 330 }, scope, repo);

      expect(res.results).toHaveLength(1);
      expect(res.results[0].id).toBe("case-roomy");
    });
  });

  describe("min_cooler_clearance_mm filter", () => {
    it("matches cases with max_cooler_height_mm >= min_cooler_clearance_mm and excludes insufficient or missing clearance", async () => {
      insertProduct(db, {
        id: "case-tall",
        name: "Tall Tower Case",
        category: "case",
        price: 120,
        specs: { max_gpu_length_mm: 350, max_cooler_height_mm: 175 }
      });

      insertProduct(db, {
        id: "case-short",
        name: "Slim Case",
        category: "case",
        price: 75,
        specs: { max_gpu_length_mm: 350, max_cooler_height_mm: 150 }
      });

      insertProduct(db, {
        id: "case-missing",
        name: "Mystery Case",
        category: "case",
        price: 60,
        specs: { max_gpu_length_mm: 350 } // missing max_cooler_height_mm
      });

      // Filter for 165mm cooler clearance: tall (175) matches; short (150) and missing do not match
      const res = await searchProducts({ category: "case", min_cooler_clearance_mm: 165 }, scope, repo);

      expect(res.results).toHaveLength(1);
      expect(res.results[0].id).toBe("case-tall");
    });
  });

  describe("category restriction validations", () => {
    it("returns error explaining min_gpu_clearance_mm is only valid for 'case' category", async () => {
      const resGpu = await searchProducts({ category: "gpu", min_gpu_clearance_mm: 300 }, scope, repo);
      expect(resGpu.results).toEqual([]);
      expect(resGpu.error).toMatch(/min_gpu_clearance_mm is only valid for the 'case' category/i);

      const resNoCat = await searchProducts({ min_gpu_clearance_mm: 300 }, scope, repo);
      expect(resNoCat.results).toEqual([]);
      expect(resNoCat.error).toMatch(/min_gpu_clearance_mm is only valid for the 'case' category/i);
    });

    it("returns error explaining min_cooler_clearance_mm is only valid for 'case' category", async () => {
      const resCpu = await searchProducts({ category: "cpu", min_cooler_clearance_mm: 160 }, scope, repo);
      expect(resCpu.results).toEqual([]);
      expect(resCpu.error).toMatch(/min_cooler_clearance_mm is only valid for the 'case' category/i);
    });

    it("returns error explaining max_length_mm is only valid for 'gpu' category", async () => {
      const resCase = await searchProducts({ category: "case", max_length_mm: 300 }, scope, repo);
      expect(resCase.results).toEqual([]);
      expect(resCase.error).toMatch(/max_length_mm is only valid for the 'gpu' category/i);

      const resNoCat = await searchProducts({ max_length_mm: 300 }, scope, repo);
      expect(resNoCat.results).toEqual([]);
      expect(resNoCat.error).toMatch(/max_length_mm is only valid for the 'gpu' category/i);
    });

    it("normalizes capitalized and whitespace-padded category inputs ('Case', 'GPU') [r9]", async () => {
      insertProduct(db, {
        id: "case-upper",
        name: "NZXT H5 Flow",
        category: "case",
        price: 94,
        specs: { max_gpu_length_mm: 365, max_cooler_height_mm: 165 }
      });
      insertProduct(db, {
        id: "gpu-upper",
        name: "Custom GPU 240mm",
        category: "gpu",
        price: 599,
        specs: { length_mm: 242, vram_gb: 12 }
      });

      // Capitalized 'Case' with category-restricted clearance filter
      const resCase = await searchProducts({ category: "Case", min_gpu_clearance_mm: 300 }, scope, repo);
      expect(resCase.error).toBeUndefined();
      expect(resCase.results).toHaveLength(1);
      expect(resCase.results[0].id).toBe("case-upper");

      // Capitalized 'GPU' with whitespace and category-restricted length filter
      const resGpu = await searchProducts({ category: " GPU ", max_length_mm: 250 }, scope, repo);
      expect(resGpu.error).toBeUndefined();
      expect(resGpu.results).toHaveLength(1);
      expect(resGpu.results[0].id).toBe("gpu-upper");
    });
  });

  describe("limit clamping to 12 and guidance in hint", () => {
    it("does not reject limit > 12 with Zod schema validation error", () => {
      const parsed = searchProductsInputSchema.safeParse({ limit: 20 });
      expect(parsed.success).toBe(true);
    });

    it("clamps limit > 12 to 12 and includes guidance in hint and note [q1]", async () => {
      for (let i = 1; i <= 15; i++) {
        insertProduct(db, {
          id: `case-${i}`,
          name: `Case Variant ${i}`,
          category: "case",
          price: 50 + i,
          specs: { max_gpu_length_mm: 350 }
        });
      }

      const res = await searchProducts({ category: "case", limit: 20 }, scope, repo);

      expect(res.results).toHaveLength(12);
      expect(res.returned).toBe(12);
      expect(res.hint).toContain("Showing up to 12 results—the maximum per search.");
      expect(res.note).toBe("Showing up to 12 results—the maximum per search.");
    });

    it("preserves existing hint while appending limit guidance when limit clamped [q1]", async () => {
      for (let i = 1; i <= 20; i++) {
        insertProduct(db, {
          id: `case-bulk-${i}`,
          name: `Bulk Case ${i}`,
          category: "case",
          price: 100 + i,
          specs: { max_gpu_length_mm: 350 }
        });
      }

      const res = await searchProducts({ category: "case", limit: 30 }, scope, repo);
      expect(res.results).toHaveLength(12);
      expect(res.hint).toContain("Showing 12 of 20 matching in-stock products");
      expect(res.hint).toContain("Showing up to 12 results—the maximum per search.");
      expect(res.note).toBe("Showing up to 12 results—the maximum per search.");
    });

    it("does not include note when limit <= 12 is requested", async () => {
      insertProduct(db, {
        id: "case-single",
        name: "Single Case",
        category: "case",
        price: 80
      });

      const res = await searchProducts({ category: "case", limit: 8 }, scope, repo);
      expect(res.results).toHaveLength(1);
      expect(res.note).toBeUndefined();
    });
  });

  describe("model_id filtering in searchProducts", () => {
    it("filters products matching model_id", async () => {
      insertProduct(db, {
        id: "rtx-4070-asus",
        name: "ASUS RTX 4070",
        registry_key: "nvidia-rtx-4070",
        category: "gpu",
        price: 550
      });

      insertProduct(db, {
        id: "rtx-4080-asus",
        name: "ASUS RTX 4080",
        registry_key: "nvidia-rtx-4080",
        category: "gpu",
        price: 999
      });

      const res = await searchProducts({ model_id: "nvidia-rtx-4070" }, scope, repo);
      expect(res.results).toHaveLength(1);
      expect(res.results[0].id).toBe("rtx-4070-asus");
    });
  });

  describe("createSearchProductsTool execution", () => {
    it("executes search_products tool seamlessly with clearance parameters", async () => {
      insertProduct(db, {
        id: "case-tool",
        name: "Tool Tested Case",
        category: "case",
        price: 100,
        specs: { max_gpu_length_mm: 400, max_cooler_height_mm: 180 }
      });

      const searchTool = createSearchProductsTool(scope, repo);
      const input = { category: "case", min_gpu_clearance_mm: 350, limit: 20 };
      const parsed = searchProductsInputSchema.parse(input);

      const result = await (searchTool as unknown as { execute(inp: unknown): Promise<{ results: unknown[]; note?: string }> }).execute(parsed);
      expect(result.results).toHaveLength(1);
      expect(result.note).toBe("Showing up to 12 results—the maximum per search.");
    });
  });
});
