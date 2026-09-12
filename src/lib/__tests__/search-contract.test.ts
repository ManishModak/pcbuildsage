import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { toCompactSearchResult } from "@/lib/catalog/compact";
import { searchProductsInputSchema } from "@/lib/tools/search-products";
import { getCatalogRepository } from "@/lib/catalog";
import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

describe("Priority 3: Search Contract Corrections", () => {
  const testDbDir = path.join(process.cwd(), "data", "test-search-contract");
  const testDbPath = path.join(testDbDir, "products.db");

  afterAll(() => {
    try {
      fs.rmSync(testDbDir, { recursive: true, force: true });
    } catch {}
  });

  beforeAll(() => {
    if (!fs.existsSync(testDbDir)) {
      fs.mkdirSync(testDbDir, { recursive: true });
    }
    const db = new Database(testDbPath);
    db.pragma("user_version = 5");
    db.exec(`
      CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        normalized_name TEXT NOT NULL,
        category TEXT NOT NULL,
        subcategory TEXT,
        price REAL,
        currency TEXT NOT NULL,
        country_code TEXT NOT NULL,
        retailer TEXT NOT NULL,
        url TEXT NOT NULL,
        in_stock INTEGER NOT NULL,
        specs TEXT,
        registry_key TEXT,
        first_seen TEXT,
        last_scraped TEXT
      );
      DELETE FROM products;
    `);

    // Insert test products:
    // 3 PSUs: one 550W, one 750W, one 850W
    // 3 GPUs: RTX 4070 (600), RTX 4070 Ti (800), RTX 4080 (1200)
    const insert = db.prepare(`
      INSERT INTO products (name, normalized_name, category, subcategory, price, currency, country_code, retailer, url, in_stock, specs)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insert.run("Corsair CX550", "corsair cx550", "psu", "internal", 60, "USD", "US", "Amazon", "https://example.com/cx550", 1, JSON.stringify({ wattage: 550 }));
    insert.run("Corsair RM750e", "corsair rm750e", "psu", "internal", 100, "USD", "US", "Amazon", "https://example.com/rm750e", 1, JSON.stringify({ wattage: 750 }));
    insert.run("Corsair RM850x", "corsair rm850x", "psu", "internal", 140, "USD", "US", "Amazon", "https://example.com/rm850x", 1, JSON.stringify({ wattage: 850 }));

    insert.run("Gigabyte RTX 4070 Windforce", "gigabyte rtx 4070 windforce", "gpu", "internal", 550, "USD", "US", "BestBuy", "https://example.com/4070", 1, JSON.stringify({ vram_gb: 12 }));
    insert.run("Gigabyte RTX 4070 Ti Super", "gigabyte rtx 4070 ti super", "gpu", "internal", 800, "USD", "US", "BestBuy", "https://example.com/4070ti", 1, JSON.stringify({ vram_gb: 16 }));
    insert.run("Gigabyte RTX 4080 Super", "gigabyte rtx 4080 super", "gpu", "internal", 1000, "USD", "US", "BestBuy", "https://example.com/4080", 1, JSON.stringify({ vram_gb: 16 }));

    db.close();
  });

  describe("1. Schema & Descriptions", () => {
    it("documents substring matching for term and query", () => {
      const termDesc = searchProductsInputSchema.shape.term.description;
      const queryDesc = searchProductsInputSchema.shape.query.description;
      expect(termDesc).toContain("substring");
      expect(queryDesc).toContain("substring");
    });

    it("documents price order as price only (not performance ranking)", () => {
      const orderDesc = searchProductsInputSchema.shape.order.description;
      expect(orderDesc).toContain("Price order describes price only");
      expect(orderDesc).not.toContain("best part within the budget first");
    });
  });

  describe("2. Default Limit on Direct Calls", () => {
    it("defaults to 8 results in repository when limit is omitted", async () => {
      const repo = getCatalogRepository(testDbPath);
      const res = await repo.searchProducts(
        { category: "gpu" },
        { dbPath: testDbPath, countryCode: "US", currency: "USD" }
      );
      expect(res.results.length).toBeLessThanOrEqual(8);
      expect(searchProductsInputSchema.parse({}).limit).toBe(8);
    });
  });

  describe("3. Price Sorting & Filtering", () => {
    it("sorts ascending price for lowest price first", async () => {
      const repo = getCatalogRepository(testDbPath);
      const res = await repo.searchProducts(
        { category: "gpu", sort_by: "price", order: "asc" },
        { dbPath: testDbPath, countryCode: "US", currency: "USD" }
      );
      expect(res.results.length).toBe(3);
      expect(res.results[0].price).toBe(550);
      expect(res.results[1].price).toBe(800);
      expect(res.results[2].price).toBe(1000);
    });

    it("sorts descending price for highest price first", async () => {
      const repo = getCatalogRepository(testDbPath);
      const res = await repo.searchProducts(
        { category: "gpu", sort_by: "price", order: "desc" },
        { dbPath: testDbPath, countryCode: "US", currency: "USD" }
      );
      expect(res.results.length).toBe(3);
      expect(res.results[0].price).toBe(1000);
      expect(res.results[1].price).toBe(800);
      expect(res.results[2].price).toBe(550);
    });
  });

  describe("4. Truthful Counts & has_more with Registry Filters", () => {
    it("does not overstate total_matching or has_more when registry filter restricts results", async () => {
      const repo = getCatalogRepository(testDbPath);
      // All 3 PSUs match SQL where category = 'psu', but only 1 matches min_wattage: 800
      const res = await repo.searchProducts(
        { category: "psu", min_wattage: 800, limit: 8 },
        { dbPath: testDbPath, countryCode: "US", currency: "USD" }
      );

      // Only Corsair RM850x (850W) matches
      expect(res.results.length).toBe(1);
      expect(res.results[0].name).toBe("Corsair RM850x");

      // Count must accurately reflect the 1 eligible product, NOT the 3 SQL candidates!
      expect(res.total_matching).toBe(1);
      expect(res.has_more).toBe(false);
    });

    it("omits exact totals when a filtered search stops before the final SQL batch", async () => {
      const db = new Database(testDbPath);
      const insert = db.prepare(`INSERT INTO products
        (name, normalized_name, category, subcategory, price, currency, country_code, retailer, url, in_stock, specs)
        VALUES (?, ?, 'psu', 'internal', 100, 'USD', 'US', 'BatchStore', ?, 1, ?)`);
      for (let i = 0; i < 300; i++) {
        insert.run(`Batch PSU ${i}`, `batch psu ${i}`, `https://example.com/batch/${i}`, JSON.stringify({ wattage: 750 }));
      }
      try {
        const result = await getCatalogRepository(testDbPath).searchProducts(
          { category: "psu", retailer: "BatchStore", min_wattage: 650, limit: 8 },
          { dbPath: testDbPath, countryCode: "US", currency: "USD" }
        );
        expect(result.results).toHaveLength(8);
        expect(result.has_more).toBe(true);
        expect(result.sql_candidates).toBe(300);
        expect(result.total_matching).toBeUndefined();
        expect(result.totalCount).toBeUndefined();
        expect(result.hint).not.toContain("undefined");
        const compact = toCompactSearchResult(result);
        expect(compact.total_matching).toBeUndefined();
        expect(compact.totalCount).toBeUndefined();
        expect(compact.has_more).toBe(true);
      } finally {
        db.prepare("DELETE FROM products WHERE retailer = 'BatchStore'").run();
        db.close();
      }
    });

    it("correctly flags has_more when eligible matches exceed limit", async () => {
      const repo = getCatalogRepository(testDbPath);
      // 2 PSUs match >= 700W (RM750e, RM850x). With limit = 1, exactly 1 returned and has_more = true
      const res = await repo.searchProducts(
        { category: "psu", min_wattage: 700, limit: 1 },
        { dbPath: testDbPath, countryCode: "US", currency: "USD" }
      );

      expect(res.results.length).toBe(1);
      expect(res.has_more).toBe(true);
      expect(res.total_matching).toBe(2);
    });
  });

  describe("5. Substring & Variant Matching", () => {
    it("matches product title as substring for model query", async () => {
      const repo = getCatalogRepository(testDbPath);
      const res = await repo.searchProducts(
        { term: "4070" },
        { dbPath: testDbPath, countryCode: "US", currency: "USD" }
      );
      // Matches both "Gigabyte RTX 4070 Windforce" and "Gigabyte RTX 4070 Ti Super"
      expect(res.results.length).toBe(2);
      expect(res.results.some((r) => r.name.includes("Windforce"))).toBe(true);
      expect(res.results.some((r) => r.name.includes("Ti Super"))).toBe(true);
    });
  });
});
