/**
 * src/lib/catalog/__tests__/snapshot-validator.test.ts
 *
 * Comprehensive tests for candidate snapshot validator (Phase 2).
 */

import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  validateCandidateSnapshot,
  validateCandidateSnapshotSync,
  DATABASE_SCHEMA_VERSION
} from "@/lib/catalog";

interface MockProduct {
  id?: string;
  name?: string;
  normalized_name?: string;
  registry_key?: string | null;
  price?: number | null;
  currency?: string;
  country_code?: string;
  retailer?: string;
  url?: string;
  image_url?: string | null;
  in_stock?: number | boolean;
  category?: string;
  subcategory?: string | null;
  specs?: string | null;
  first_seen?: string;
  last_scraped?: string;
}

const createdFiles: string[] = [];

function getTempDbPath(): string {
  const filePath = path.join(
    os.tmpdir(),
    `test-snapshot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`
  );
  createdFiles.push(filePath);
  return filePath;
}

afterEach(() => {
  for (const filePath of createdFiles) {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      // Also clean WAL and SHM files if present
      const wal = `${filePath}-wal`;
      const shm = `${filePath}-shm`;
      if (fs.existsSync(wal)) fs.unlinkSync(wal);
      if (fs.existsSync(shm)) fs.unlinkSync(shm);
    } catch {
      // Ignore cleanup error
    }
  }
  createdFiles.length = 0;
});

function createSampleProducts(count = 50, overrides: Partial<MockProduct> = {}): MockProduct[] {
  const now = new Date().toISOString();
  return Array.from({ length: count }, (_, i) => ({
    id: `prod-${i + 1}`,
    name: `Hardware Component ${i + 1}`,
    normalized_name: `hardware component ${i + 1}`,
    registry_key: null,
    price: 99.99 + i,
    currency: "USD",
    country_code: "US",
    retailer: i % 2 === 0 ? "RetailerA" : "RetailerB",
    url: `https://example.com/product/${i + 1}`,
    image_url: null,
    in_stock: 1,
    category: i % 2 === 0 ? "cpu" : "gpu",
    subcategory: "desktop",
    specs: null,
    first_seen: now,
    last_scraped: now,
    ...overrides
  }));
}

function initTestDb(options: {
  dbPath?: string;
  schemaVersion?: number;
  includeTables?: Array<"products" | "audit_cache" | "registry_research">;
  columns?: string[];
  products?: MockProduct[];
}): { db: Database.Database; dbPath: string } {
  const dbPath = options.dbPath ?? getTempDbPath();
  const db = new Database(dbPath);

  const schemaVersion =
    options.schemaVersion !== undefined ? options.schemaVersion : DATABASE_SCHEMA_VERSION;
  db.pragma(`user_version = ${schemaVersion}`);

  const includeTables = options.includeTables ?? [
    "products",
    "audit_cache",
    "registry_research"
  ];

  if (includeTables.includes("products")) {
    if (options.columns) {
      const colDefs = options.columns.map((col) => {
        if (col === "id") return "id TEXT PRIMARY KEY";
        if (col === "price") return "price REAL";
        if (col === "in_stock") return "in_stock INTEGER DEFAULT 1";
        return `${col} TEXT`;
      });
      db.exec(`CREATE TABLE products (${colDefs.join(", ")});`);
    } else {
      db.exec(`
        CREATE TABLE products (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          normalized_name TEXT,
          registry_key TEXT,
          price REAL,
          currency TEXT NOT NULL,
          country_code TEXT NOT NULL,
          retailer TEXT NOT NULL,
          url TEXT NOT NULL,
          image_url TEXT,
          in_stock INTEGER DEFAULT 1,
          category TEXT NOT NULL,
          subcategory TEXT,
          specs TEXT,
          first_seen TEXT NOT NULL,
          last_scraped TEXT NOT NULL
        );
      `);
    }
  }

  if (includeTables.includes("audit_cache")) {
    db.exec(`
      CREATE TABLE audit_cache (
        pair_key TEXT PRIMARY KEY,
        verdict TEXT NOT NULL,
        checked_at TEXT NOT NULL
      );
    `);
  }

  if (includeTables.includes("registry_research")) {
    db.exec(`
      CREATE TABLE registry_research (
        key TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        specs TEXT NOT NULL,
        sources TEXT,
        confidence TEXT NOT NULL,
        researched_at TEXT NOT NULL
      );
    `);
  }

  if (options.products && includeTables.includes("products")) {
    const insert = db.prepare(`
      INSERT INTO products (
        id, name, normalized_name, registry_key, price, currency,
        country_code, retailer, url, image_url, in_stock, category,
        subcategory, specs, first_seen, last_scraped
      ) VALUES (
        @id, @name, @normalized_name, @registry_key, @price, @currency,
        @country_code, @retailer, @url, @image_url, @in_stock, @category,
        @subcategory, @specs, @first_seen, @last_scraped
      )
    `);

    const now = new Date().toISOString();
    for (const p of options.products) {
      insert.run({
        id: p.id ?? `prod-${Math.random().toString(36).slice(2, 8)}`,
        name: p.name ?? "Test Product",
        normalized_name: p.normalized_name ?? "test product",
        registry_key: p.registry_key ?? null,
        price: p.price !== undefined ? p.price : 100,
        currency: p.currency ?? "USD",
        country_code: p.country_code ?? "US",
        retailer: p.retailer ?? "TestRetailer",
        url: p.url ?? `https://example.com/p/${Math.random().toString(36).slice(2, 8)}`,
        image_url: p.image_url ?? null,
        in_stock: p.in_stock !== undefined ? (p.in_stock ? 1 : 0) : 1,
        category: p.category ?? "cpu",
        subcategory: p.subcategory ?? null,
        specs: p.specs ?? null,
        first_seen: p.first_seen ?? now,
        last_scraped: p.last_scraped ?? now
      });
    }
  }

  return { db, dbPath };
}

describe("Snapshot Validator (Phase 2)", () => {
  describe("Valid sample database", () => {
    it("passes validation on a fully valid candidate database with accurate stats", async () => {
      const products = createSampleProducts(60);
      const { db, dbPath } = initTestDb({ products });
      db.close();

      const result = await validateCandidateSnapshot(dbPath);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.stats.totalProducts).toBe(60);
      expect(result.stats.inStockProducts).toBe(60);
      expect(result.stats.duplicateUrls).toBe(0);
      expect(result.stats.categories).toEqual({ cpu: 30, gpu: 30 });
      expect(result.stats.retailers).toEqual({ RetailerA: 30, RetailerB: 30 });
      expect(result.stats.countries).toEqual({ US: 60 });
    });

    it("passes validation using the synchronous helper on an open database", () => {
      const products = createSampleProducts(55);
      const { db } = initTestDb({ products });

      try {
        const result = validateCandidateSnapshotSync(db);
        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
        expect(result.stats.totalProducts).toBe(55);
        expect(result.stats.inStockProducts).toBe(55);
        expect(result.stats.duplicateUrls).toBe(0);
      } finally {
        db.close();
      }
    });

    it("records warnings when optional tables audit_cache or registry_research are missing", async () => {
      const products = createSampleProducts(50);
      const { db, dbPath } = initTestDb({
        includeTables: ["products"],
        products
      });
      db.close();

      const result = await validateCandidateSnapshot(dbPath);
      expect(result.valid).toBe(true);
      expect(result.warnings.length).toBe(2);
      expect(result.warnings.some((w) => w.includes("audit_cache"))).toBe(true);
      expect(result.warnings.some((w) => w.includes("registry_research"))).toBe(true);
    });
  });

  describe("Zero-product threshold & minProducts options", () => {
    it("fails validation when candidate catalog contains 0 products by default", async () => {
      const { db, dbPath } = initTestDb({ products: [] });
      db.close();

      const result = await validateCandidateSnapshot(dbPath);
      expect(result.valid).toBe(false);
      expect(result.stats.totalProducts).toBe(0);
      expect(result.errors.some((e) => e.includes("0 products"))).toBe(true);
    });

    it("allows 0 products when allowEmpty: true", async () => {
      const { db, dbPath } = initTestDb({ products: [] });
      db.close();

      const result = await validateCandidateSnapshot(dbPath, { allowEmpty: true });
      expect(result.valid).toBe(true);
      expect(result.stats.totalProducts).toBe(0);
      expect(result.errors).toHaveLength(0);
    });

    it("fails when product count is below default minProducts (50)", async () => {
      const products = createSampleProducts(30);
      const { db, dbPath } = initTestDb({ products });
      db.close();

      const result = await validateCandidateSnapshot(dbPath);
      expect(result.valid).toBe(false);
      expect(
        result.errors.some((e) => e.includes("30 products, below minimum threshold of 50"))
      ).toBe(true);
    });

    it("passes when product count meets custom minProducts threshold", async () => {
      const products = createSampleProducts(25);
      const { db, dbPath } = initTestDb({ products });
      db.close();

      const result = await validateCandidateSnapshot(dbPath, { minProducts: 20 });
      expect(result.valid).toBe(true);
      expect(result.stats.totalProducts).toBe(25);
    });

    it("fails when distinct category count is below minCategories", async () => {
      // Products only in "cpu" category
      const products = createSampleProducts(50, { category: "cpu" });
      const { db, dbPath } = initTestDb({ products });
      db.close();

      const result = await validateCandidateSnapshot(dbPath, { minCategories: 3 });
      expect(result.valid).toBe(false);
      expect(
        result.errors.some(
          (e) => e.includes("1 categories") && e.includes("minimum threshold of 3")
        )
      ).toBe(true);
    });
  });

  describe("Schema version & table structure validation", () => {
    it("fails when schema user_version is older (< 5)", async () => {
      const products = createSampleProducts(50);
      const { db, dbPath } = initTestDb({ schemaVersion: 4, products });
      db.close();

      const result = await validateCandidateSnapshot(dbPath);
      expect(result.valid).toBe(false);
      expect(
        result.errors.some(
          (e) => e.includes("Invalid schema version 4") && e.includes("Expected version 5")
        )
      ).toBe(true);
    });

    it("fails when schema user_version is newer (> 5)", async () => {
      const products = createSampleProducts(50);
      const { db, dbPath } = initTestDb({ schemaVersion: 6, products });
      db.close();

      const result = await validateCandidateSnapshot(dbPath);
      expect(result.valid).toBe(false);
      expect(
        result.errors.some(
          (e) => e.includes("Invalid schema version 6") && e.includes("Expected version 5")
        )
      ).toBe(true);
    });

    it("fails when schema user_version is 0 (uninitialized)", async () => {
      const products = createSampleProducts(50);
      const { db, dbPath } = initTestDb({ schemaVersion: 0, products });
      db.close();

      const result = await validateCandidateSnapshot(dbPath);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("Invalid schema version 0"))).toBe(true);
    });

    it("fails when required products table is missing", async () => {
      const { db, dbPath } = initTestDb({ includeTables: ["audit_cache"] });
      db.close();

      const result = await validateCandidateSnapshot(dbPath);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("Required table 'products' is missing"))).toBe(
        true
      );
    });

    it("fails when required columns are missing in products table", async () => {
      const { db, dbPath } = initTestDb({
        columns: ["id", "name", "price", "currency", "country_code", "url"] // missing category, in_stock, retailer, last_scraped, subcategory
      });
      db.close();

      const result = await validateCandidateSnapshot(dbPath);
      expect(result.valid).toBe(false);
      expect(
        result.errors.some(
          (e) =>
            e.includes("missing required column(s)") &&
            e.includes("category") &&
            e.includes("in_stock")
        )
      ).toBe(true);
    });
  });

  describe("Required fields validation", () => {
    it("fails when products have empty or whitespace-only name", async () => {
      const products = createSampleProducts(50);
      products[0].name = "   ";
      const { db, dbPath } = initTestDb({ products });
      db.close();

      const result = await validateCandidateSnapshot(dbPath);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("missing or empty required fields"))).toBe(true);
    });

    it("fails when products have empty category", async () => {
      const products = createSampleProducts(50);
      products[1].category = "";
      const { db, dbPath } = initTestDb({ products });
      db.close();

      const result = await validateCandidateSnapshot(dbPath);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("missing or empty required fields"))).toBe(true);
    });

    it("fails when products have empty country_code", async () => {
      const products = createSampleProducts(50);
      products[2].country_code = "";
      const { db, dbPath } = initTestDb({ products });
      db.close();

      const result = await validateCandidateSnapshot(dbPath);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("missing or empty required fields"))).toBe(true);
    });
  });

  describe("Price sanity & currency validation", () => {
    it("fails on zero price", async () => {
      const products = createSampleProducts(50);
      products[0].price = 0.0;
      const { db, dbPath } = initTestDb({ products });
      db.close();

      const result = await validateCandidateSnapshot(dbPath);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("invalid or non-positive price"))).toBe(true);
    });

    it("fails on negative price", async () => {
      const products = createSampleProducts(50);
      products[1].price = -25.5;
      const { db, dbPath } = initTestDb({ products });
      db.close();

      const result = await validateCandidateSnapshot(dbPath);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("invalid or non-positive price"))).toBe(true);
    });

    it("fails on invalid 2-letter currency", async () => {
      const products = createSampleProducts(50);
      products[0].currency = "US";
      const { db, dbPath } = initTestDb({ products });
      db.close();

      const result = await validateCandidateSnapshot(dbPath);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("invalid currency code"))).toBe(true);
    });

    it("fails on invalid 4-letter currency", async () => {
      const products = createSampleProducts(50);
      products[0].currency = "USDD";
      const { db, dbPath } = initTestDb({ products });
      db.close();

      const result = await validateCandidateSnapshot(dbPath);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("invalid currency code"))).toBe(true);
    });

    it("fails on numeric or special character currency", async () => {
      const products = createSampleProducts(50);
      products[0].currency = "12$";
      const { db, dbPath } = initTestDb({ products });
      db.close();

      const result = await validateCandidateSnapshot(dbPath);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("invalid currency code"))).toBe(true);
    });
  });

  describe("URL integrity & duplicate URL validation", () => {
    it("fails when URL does not start with http:// or https://", async () => {
      const products = createSampleProducts(50);
      products[0].url = "ftp://example.com/p1";
      products[1].url = "javascript:alert(1)";
      const { db, dbPath } = initTestDb({ products });
      db.close();

      const result = await validateCandidateSnapshot(dbPath);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("malformed URL"))).toBe(true);
    });

    it("fails when URL contains whitespace characters", async () => {
      const products = createSampleProducts(50);
      products[0].url = "https://example.com/component with spaces";
      const { db, dbPath } = initTestDb({ products });
      db.close();

      const result = await validateCandidateSnapshot(dbPath);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("malformed URL"))).toBe(true);
    });

    it("fails when duplicate URL ratio exceeds default threshold (5%)", async () => {
      const products = createSampleProducts(100);
      // Make 10 products share duplicate URLs (10% duplicate ratio)
      for (let i = 90; i < 100; i++) {
        products[i].url = "https://example.com/product/duplicate";
      }
      const { db, dbPath } = initTestDb({ products });
      db.close();

      const result = await validateCandidateSnapshot(dbPath);
      expect(result.valid).toBe(false);
      expect(result.stats.duplicateUrls).toBe(9); // 10 occurrences of same url = 9 duplicates
      expect(result.errors.some((e) => e.includes("Duplicate URL ratio"))).toBe(true);
    });

    it("passes duplicate URL check when ratio is below custom maxDuplicateUrlRatio", async () => {
      const products = createSampleProducts(100);
      for (let i = 90; i < 95; i++) {
        products[i].url = "https://example.com/product/duplicate";
      }
      const { db, dbPath } = initTestDb({ products });
      db.close();

      const result = await validateCandidateSnapshot(dbPath, { maxDuplicateUrlRatio: 0.1 });
      expect(result.valid).toBe(true);
      expect(result.stats.duplicateUrls).toBe(4);
    });
  });

  describe("WAF / Bot-challenge / Captcha detection", () => {
    it("fails when product name contains 'Attention Required! | Cloudflare'", async () => {
      const products = createSampleProducts(50);
      products[0].name = "Attention Required! | Cloudflare";
      const { db, dbPath } = initTestDb({ products });
      db.close();

      const result = await validateCandidateSnapshot(dbPath);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("WAF challenge"))).toBe(true);
    });

    it("fails when product name contains '403 Forbidden'", async () => {
      const products = createSampleProducts(50);
      products[0].name = "403 Forbidden - nginx";
      const { db, dbPath } = initTestDb({ products });
      db.close();

      const result = await validateCandidateSnapshot(dbPath);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("WAF challenge"))).toBe(true);
    });

    it("fails when product name contains 'Verify you are human'", async () => {
      const products = createSampleProducts(50);
      products[0].name = "Verify you are human to continue";
      const { db, dbPath } = initTestDb({ products });
      db.close();

      const result = await validateCandidateSnapshot(dbPath);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("WAF challenge"))).toBe(true);
    });

    it("fails when product name contains 'Access Denied'", async () => {
      const products = createSampleProducts(50);
      products[0].name = "Access Denied - Ray ID: 893c72b84920";
      const { db, dbPath } = initTestDb({ products });
      db.close();

      const result = await validateCandidateSnapshot(dbPath);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("WAF challenge"))).toBe(true);
    });

    it("fails when product name contains 'Just a moment...'", async () => {
      const products = createSampleProducts(50);
      products[0].name = "Just a moment... Please wait";
      const { db, dbPath } = initTestDb({ products });
      db.close();

      const result = await validateCandidateSnapshot(dbPath);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("WAF challenge"))).toBe(true);
    });

    it("fails when URL contains WAF challenge path", async () => {
      const products = createSampleProducts(50);
      products[0].url = "https://retailer.example.com/cdn-cgi/challenge-platform/h/b";
      const { db, dbPath } = initTestDb({ products });
      db.close();

      const result = await validateCandidateSnapshot(dbPath);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("WAF challenge"))).toBe(true);
    });

    it("does not false-positive on legitimate hardware mentioning 'guard'", async () => {
      const products = createSampleProducts(50);
      products[0].name = "Gigabyte Anti-Sag Bracket GPU Guard";
      const { db, dbPath } = initTestDb({ products });
      db.close();

      const result = await validateCandidateSnapshot(dbPath);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe("Catastrophic drop check & sweep safety", () => {
    it("fails when product count drops by > 30% compared to baseline database", async () => {
      // Baseline has 100 products
      const baselineProducts = createSampleProducts(100);
      const { db: baselineDb, dbPath: baselinePath } = initTestDb({ products: baselineProducts });
      baselineDb.close();

      // Candidate has 60 products (40% drop > 30% threshold)
      const candidateProducts = createSampleProducts(60);
      const { db: candidateDb, dbPath: candidatePath } = initTestDb({
        products: candidateProducts
      });
      candidateDb.close();

      const result = await validateCandidateSnapshot(candidatePath, {
        baselineDbPath: baselinePath
      });
      expect(result.valid).toBe(false);
      expect(
        result.errors.some(
          (e) => e.includes("Product count dropped by 40.0%") && e.includes("baseline 100")
        )
      ).toBe(true);
    });

    it("passes when drop is within the 30% limit (e.g. 20% drop)", async () => {
      const baselineProducts = createSampleProducts(100);
      const { db: baselineDb, dbPath: baselinePath } = initTestDb({ products: baselineProducts });
      baselineDb.close();

      const candidateProducts = createSampleProducts(80);
      const { db: candidateDb, dbPath: candidatePath } = initTestDb({
        products: candidateProducts
      });
      candidateDb.close();

      const result = await validateCandidateSnapshot(candidatePath, {
        baselineDbPath: baselinePath
      });
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("supports configurable maxDropRatio", async () => {
      const baselineProducts = createSampleProducts(100);
      const { db: baselineDb, dbPath: baselinePath } = initTestDb({ products: baselineProducts });
      baselineDb.close();

      // 40% drop
      const candidateProducts = createSampleProducts(60);
      const { db: candidateDb, dbPath: candidatePath } = initTestDb({
        products: candidateProducts
      });
      candidateDb.close();

      // With maxDropRatio = 0.50 (50%), 40% drop is allowed
      const result = await validateCandidateSnapshot(candidatePath, {
        baselineDbPath: baselinePath,
        maxDropRatio: 0.5
      });
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("handles baselineProductCount option directly", async () => {
      const candidateProducts = createSampleProducts(60);
      const { db: candidateDb, dbPath: candidatePath } = initTestDb({
        products: candidateProducts
      });
      candidateDb.close();

      const result = await validateCandidateSnapshot(candidatePath, {
        baselineProductCount: 100
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("Product count dropped by 40.0%"))).toBe(true);
    });
  });

  describe("File error handling & resilience", () => {
    it("returns error cleanly when database file does not exist", async () => {
      const result = await validateCandidateSnapshot("/tmp/non-existent-db-12345.sqlite");
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("does not exist"))).toBe(true);
      expect(result.stats.totalProducts).toBe(0);
    });

    it("returns error cleanly on corrupted non-SQLite file without unhandled crash", async () => {
      const corruptPath = getTempDbPath();
      fs.writeFileSync(corruptPath, "THIS IS NOT A VALID SQLITE DATABASE FILE HEADER");

      const result = await validateCandidateSnapshot(corruptPath);
      expect(result.valid).toBe(false);
      expect(
        result.errors.some(
          (e) => e.includes("Failed to open") || e.includes("file is not a database")
        )
      ).toBe(true);
    });

    it("returns error cleanly when synchronous helper receives closed connection", () => {
      const db = new Database(":memory:");
      db.close();

      const result = validateCandidateSnapshotSync(db);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("Database connection is closed"))).toBe(true);
    });
  });
});
