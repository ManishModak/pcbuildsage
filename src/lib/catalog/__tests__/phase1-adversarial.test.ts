/**
 * src/lib/catalog/__tests__/phase1-adversarial.test.ts
 *
 * Rigorous adversarial and stress testing suite for Phase 1:
 * - Dynamic mode switching (local vs hosted-demo, custom registry, overrides)
 * - Source-neutral ProductOffer integrity, multi-currency precision, zero-decimal rules
 * - Remote Turso error resilience (timeouts, missing tokens, malformed endpoints, server failures)
 * - Offline / local non-regression (zero network leakage, strict multi-market isolation, SQLi immunity)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { type Client, type InStatement, type ResultSet, type Row } from "@libsql/client";
import { initializeSchema } from "@/lib/db";
import type { Product } from "@/types/db";
import {
  SqliteCatalogRepository,
  TursoCatalogRepository,
  getCatalogRepository,
  setCatalogRepository,
  registerCatalogRepository,
  resetCatalogRepositoryRegistry,
  toPriceMinor,
  fromPriceMinor,
  isOfferInStock,
  type CatalogRepository,
  type CatalogScope,
  type ProductOffer,
  type SearchProductsInput
} from "@/lib/catalog";

// Helper to create in-memory SQLite database
function createInMemoryDb(): Database.Database {
  const db = new Database(":memory:");
  initializeSchema(db);
  return db;
}

// Helper to seed a product into SQLite
function insertLocalProduct(
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

// Mock LibSQL client helper
function toMockRow(data: Record<string, unknown>): Row {
  const row = { ...data } as unknown as Row;
  Object.defineProperty(row, "length", { value: Object.keys(data).length });
  return row;
}

interface MockClientController extends Client {
  shouldFail: boolean;
  failError: Error;
  executedQueries: Array<{ sql: string; args?: unknown[] }>;
  mockRows: Array<Record<string, unknown>>;
  customExecute?: (stmt: InStatement) => Promise<ResultSet>;
}

function createControllableClient(initialRows: Array<Record<string, unknown>> = []): MockClientController {
  let isClosed = false;
  const executedQueries: Array<{ sql: string; args?: unknown[] }> = [];

  const mock: MockClientController = {
    shouldFail: false,
    failError: new Error("Simulated remote connection failure"),
    executedQueries,
    mockRows: initialRows,
    protocol: "http",
    get closed() {
      return isClosed;
    },
    async close() {
      isClosed = true;
    },
    async execute(stmt: InStatement): Promise<ResultSet> {
      if (isClosed) {
        throw new Error("Client is closed");
      }
      if (mock.shouldFail) {
        throw mock.failError;
      }
      if (mock.customExecute) {
        return mock.customExecute(stmt);
      }

      const sql = typeof stmt === "string" ? stmt : stmt.sql;
      const args = typeof stmt === "object" && "args" in stmt ? (stmt.args as unknown[]) : undefined;
      executedQueries.push({ sql, args });

      const upper = sql.trim().toUpperCase();

      // Subcategories
      if (upper.includes("GROUP BY CATEGORY, SUBCATEGORY")) {
        return {
          columns: ["category", "subcategory", "count", "price_min", "price_max"],
          columnTypes: ["TEXT", "TEXT", "INTEGER", "REAL", "REAL"],
          rows: [],
          rowsAffected: 0,
          lastInsertRowid: undefined,
          toJSON: () => []
        };
      }

      // Category breakdown
      if (upper.includes("GROUP BY CATEGORY")) {
        return {
          columns: ["category", "count", "in_stock_count", "price_min", "price_max"],
          columnTypes: ["TEXT", "INTEGER", "INTEGER", "REAL", "REAL"],
          rows: [
            toMockRow({ category: "cpu", count: mock.mockRows.length, in_stock_count: mock.mockRows.length, price_min: 100, price_max: 500 })
          ],
          rowsAffected: 0,
          lastInsertRowid: undefined,
          toJSON: () => []
        };
      }

      // Count query
      if (upper.includes("COUNT(*)")) {
        return {
          columns: ["total_matches", "total", "in_stock_total", "productCount", "count"],
          columnTypes: ["INTEGER", "INTEGER", "INTEGER", "INTEGER", "INTEGER"],
          rows: [toMockRow({ total_matches: mock.mockRows.length, total: mock.mockRows.length, in_stock_total: mock.mockRows.length, productCount: mock.mockRows.length, count: mock.mockRows.length })],
          rowsAffected: 0,
          lastInsertRowid: undefined,
          toJSON: () => []
        };
      }

      // Product query
      return {
        columns: ["id", "name", "category", "price", "currency", "country_code", "retailer", "url", "in_stock"],
        columnTypes: ["TEXT", "TEXT", "TEXT", "REAL", "TEXT", "TEXT", "TEXT", "TEXT", "INTEGER"],
        rows: mock.mockRows.map(toMockRow),
        rowsAffected: 0,
        lastInsertRowid: undefined,
        toJSON: () => []
      };
    }
  } as unknown as MockClientController;

  return mock;
}

describe("Phase 1 Adversarial & Stress Testing Suite", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.PCBUILDSAGE_DEPLOYMENT_MODE;
    delete process.env.TURSO_DATABASE_URL;
    delete process.env.TURSO_AUTH_TOKEN;
    delete process.env.TURSO_READ_TOKEN;
    resetCatalogRepositoryRegistry();
    // Register default repository factories as index.ts does
    registerCatalogRepository("local", () => new SqliteCatalogRepository());
    registerCatalogRepository("hosted-demo", () => new TursoCatalogRepository());
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetCatalogRepositoryRegistry();
    vi.restoreAllMocks();
  });

  // =========================================================================
  // 1. Dynamic Mode Switching
  // =========================================================================
  describe("1. Dynamic Mode Switching", () => {
    it("defaults to SqliteCatalogRepository when deployment mode is unset", () => {
      delete process.env.PCBUILDSAGE_DEPLOYMENT_MODE;
      const repo = getCatalogRepository();
      expect(repo).toBeInstanceOf(SqliteCatalogRepository);
    });

    it("resolves to SqliteCatalogRepository when mode is explicitly 'local'", () => {
      process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "local";
      const repo = getCatalogRepository();
      expect(repo).toBeInstanceOf(SqliteCatalogRepository);
      expect(getCatalogRepository("local")).toBeInstanceOf(SqliteCatalogRepository);
    });

    it("tolerates mixed casing and leading/trailing whitespace in mode names", () => {
      expect(getCatalogRepository("  LOCAL  ")).toBeInstanceOf(SqliteCatalogRepository);
      expect(getCatalogRepository("Local")).toBeInstanceOf(SqliteCatalogRepository);

      process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "  local  ";
      expect(getCatalogRepository()).toBeInstanceOf(SqliteCatalogRepository);
    });

    it("safely falls back to local SQLite repository for unrecognized mode strings", () => {
      // In deployment config, any string other than 'hosted-demo' defaults to 'local'
      expect(getCatalogRepository("staging")).toBeInstanceOf(SqliteCatalogRepository);
      expect(getCatalogRepository("production")).toBeInstanceOf(SqliteCatalogRepository);
      expect(getCatalogRepository("cluster-node-9")).toBeInstanceOf(SqliteCatalogRepository);
      expect(getCatalogRepository("")).toBeInstanceOf(SqliteCatalogRepository);
    });

    it("switches to TursoCatalogRepository in 'hosted-demo' mode when credentials exist", () => {
      process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "hosted-demo";
      process.env.TURSO_DATABASE_URL = "libsql://demo-db.turso.io";
      process.env.TURSO_READ_TOKEN = "demo-read-token";

      const repo = getCatalogRepository();
      expect(repo).toBeInstanceOf(TursoCatalogRepository);
    });

    it("throws a descriptive error when switching to 'hosted-demo' without TURSO_DATABASE_URL", () => {
      process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "hosted-demo";
      delete process.env.TURSO_DATABASE_URL;

      expect(() => getCatalogRepository()).toThrow(
        /Missing required Turso database URL/
      );
    });

    it("throws informative error when mode factory is unregistered and no fallback exists", () => {
      resetCatalogRepositoryRegistry(); // Clears all registered factories
      process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "hosted-demo";

      expect(() => getCatalogRepository("hosted-demo")).toThrow(
        /Turso repository adapter is not registered for mode "hosted-demo"/
      );
    });

    it("dynamically flips between local and hosted-demo when environment variable changes", () => {
      // Step 1: Start in local
      process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "local";
      const localRepo = getCatalogRepository();
      expect(localRepo).toBeInstanceOf(SqliteCatalogRepository);

      // Step 2: Switch to hosted-demo
      process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "hosted-demo";
      process.env.TURSO_DATABASE_URL = "libsql://demo-db.turso.io";
      const hostedRepo = getCatalogRepository();
      expect(hostedRepo).toBeInstanceOf(TursoCatalogRepository);

      // Step 3: Switch back to local
      process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "local";
      const switchedBack = getCatalogRepository();
      expect(switchedBack).toBeInstanceOf(SqliteCatalogRepository);
    });

    it("respects setCatalogRepository override regardless of active deployment mode", () => {
      const mockCustomRepo: CatalogRepository = {
        getCatalog: vi.fn(),
        searchProducts: vi.fn(),
        getCategoryBaseline: vi.fn(),
        getFreshness: vi.fn()
      };

      setCatalogRepository(mockCustomRepo);

      // Override must apply in both local and hosted-demo
      process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "hosted-demo";
      expect(getCatalogRepository()).toBe(mockCustomRepo);

      process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "local";
      expect(getCatalogRepository("local")).toBe(mockCustomRepo);
      expect(getCatalogRepository("hosted-demo")).toBe(mockCustomRepo);

      // Resetting active instance restores standard resolution
      setCatalogRepository(null);
      expect(getCatalogRepository("local")).toBeInstanceOf(SqliteCatalogRepository);
    });

    it("allows custom driver registration via registerCatalogRepository", () => {
      class CustomMockRepo implements CatalogRepository {
        async getCatalog() { return { categories: [], scope: { country_code: "US", currency: "USD" } }; }
        async searchProducts() { return { results: [] }; }
        async getCategoryBaseline() { return { total: 0, in_stock_total: 0, min_price: null, max_price: null }; }
        async getFreshness() { return { lastScraped: null, productCount: 0 }; }
      }

      registerCatalogRepository("custom-driver", () => new CustomMockRepo());
      registerCatalogRepository("hosted-demo", () => new CustomMockRepo());

      const customRepo = getCatalogRepository("hosted-demo");
      expect(customRepo).toBeInstanceOf(CustomMockRepo);
    });
  });

  // =========================================================================
  // 2. Source-Neutral ProductOffer Integrity & Multi-Market Currency
  // =========================================================================
  describe("2. Offer Integrity & Multi-Market Currencies", () => {
    describe("Minor Units Calculation & Precision", () => {
      it("accurately converts standard 2-decimal currencies to integer minor units", () => {
        expect(toPriceMinor(249.99, "USD")).toBe(24999);
        expect(toPriceMinor(0, "USD")).toBe(0);
        expect(toPriceMinor(0.01, "USD")).toBe(1);
        expect(toPriceMinor(199.95, "GBP")).toBe(19995);
        expect(toPriceMinor(450.00, "EUR")).toBe(45000);
        expect(toPriceMinor(35000.50, "INR")).toBe(3500050);
        expect(toPriceMinor(249999.00, "INR")).toBe(24999900);
      });

      it("mitigates IEEE-754 floating point imprecision when calculating priceMinor", () => {
        // In plain JS, 19.99 * 100 = 1998.9999999999998; toPriceMinor uses Math.round
        expect(toPriceMinor(19.99, "USD")).toBe(1999);
        expect(toPriceMinor(59.99, "USD")).toBe(5999);
        expect(toPriceMinor(114.99, "CAD")).toBe(11499);
      });

      it("correctly handles zero-decimal currencies (e.g. JPY, KRW, VND)", () => {
        expect(toPriceMinor(5000, "JPY")).toBe(5000);
        expect(toPriceMinor(150000, "KRW")).toBe(150000);
        expect(toPriceMinor(2500000, "VND")).toBe(2500000);

        expect(fromPriceMinor(5000, "JPY")).toBe(5000);
        expect(fromPriceMinor(150000, "KRW")).toBe(150000);
      });

      it("guarantees round-trip identity: fromPriceMinor(toPriceMinor(x)) === x", () => {
        const testCases = [
          { price: 19.99, currency: "USD" },
          { price: 349.50, currency: "USD" },
          { price: 35000, currency: "INR" },
          { price: 4299.99, currency: "GBP" },
          { price: 12500, currency: "JPY" }
        ];

        for (const tc of testCases) {
          const minor = toPriceMinor(tc.price, tc.currency);
          const roundTrip = fromPriceMinor(minor, tc.currency);
          expect(roundTrip).toBeCloseTo(tc.price, 2);
        }
      });
    });

    describe("Offer Availability & Stock Evaluation", () => {
      it("prioritizes explicit boolean inStock when present", () => {
        const inStockOffer: ProductOffer = {
          productId: "p1",
          countryCode: "US",
          currencyCode: "USD",
          price: 100,
          destinationUrl: "https://example.com/p1",
          sourceType: "scraped",
          inStock: true,
          availability: "out_of_stock" // inStock boolean takes precedence
        };
        expect(isOfferInStock(inStockOffer)).toBe(true);

        const outOfStockOffer: ProductOffer = {
          productId: "p2",
          countryCode: "US",
          currencyCode: "USD",
          price: 100,
          destinationUrl: "https://example.com/p2",
          sourceType: "scraped",
          inStock: false,
          availability: "in_stock"
        };
        expect(isOfferInStock(outOfStockOffer)).toBe(false);
      });

      it("evaluates availability enum correctly when inStock boolean is omitted", () => {
        const base = {
          productId: "p1",
          countryCode: "US",
          currencyCode: "USD",
          price: 100,
          destinationUrl: "https://example.com/p1",
          sourceType: "scraped" as const
        };

        expect(isOfferInStock({ ...base, availability: "in_stock" })).toBe(true);
        expect(isOfferInStock({ ...base, availability: "preorder" })).toBe(true);
        expect(isOfferInStock({ ...base, availability: "out_of_stock" })).toBe(false);
        expect(isOfferInStock({ ...base, availability: "backorder" })).toBe(false);
        expect(isOfferInStock({ ...base, availability: "discontinued" })).toBe(false);
        expect(isOfferInStock({ ...base, availability: "unknown" })).toBe(false);
        expect(isOfferInStock({ ...base })).toBe(true); // default true if unspecified
      });
    });

    describe("Repository Output Offer Structure & Source Neutrality", () => {
      it("generates complete, well-formed ProductOffer objects in SqliteCatalogRepository", async () => {
        const db = createInMemoryDb();
        const repo = new SqliteCatalogRepository(db);

        insertLocalProduct(db, {
          id: "in-cpu-7800x3d",
          name: "AMD Ryzen 7 7800X3D",
          category: "cpu",
          price: 36999,
          currency: "INR",
          country_code: "IN",
          retailer: "MDComputers Prime",
          url: "https://mdcomputers.in/amd-ryzen-7-7800x3d",
          in_stock: 1
        });

        const res = await repo.searchProducts(
          { category: "cpu" },
          { countryCode: "IN", currency: "INR" }
        );

        expect(res.results).toHaveLength(1);
        const item = res.results[0];
        expect(item.offers).toBeDefined();
        expect(item.offers).toHaveLength(1);

        const offer = item.offers![0];
        expect(offer.productId).toBe("in-cpu-7800x3d");
        expect(offer.countryCode).toBe("IN");
        expect(offer.currencyCode).toBe("INR");
        expect(offer.price).toBe(36999);
        expect(offer.priceMinor).toBe(3699900);
        expect(offer.destinationUrl).toBe("https://mdcomputers.in/amd-ryzen-7-7800x3d");
        expect(offer.retailer).toBe("MDComputers Prime");
        expect(offer.retailerId).toBe("mdcomputers-prime");
        expect(offer.sourceType).toBe("scraped");
        expect(offer.availability).toBe("in_stock");
        expect(offer.inStock).toBe(true);
        expect(offer.observedAt).toBeDefined();

        await repo.close();
      });

      it("generates identical compliant ProductOffer structure in TursoCatalogRepository", async () => {
        const mockClient = createControllableClient([
          {
            id: "us-gpu-4070",
            name: "GeForce RTX 4070",
            category: "gpu",
            price: 549.99,
            currency: "USD",
            country_code: "US",
            retailer: "Best Buy / Store",
            url: "https://bestbuy.com/rtx-4070",
            in_stock: 0,
            first_seen: "2026-08-01T00:00:00Z",
            last_scraped: "2026-09-01T12:00:00Z"
          }
        ]);

        const repo = new TursoCatalogRepository({ client: mockClient });
        const res = await repo.searchProducts(
          { category: "gpu", inStockOnly: false },
          { countryCode: "US", currency: "USD" }
        );

        expect(res.results).toHaveLength(1);
        const offer = res.results[0].offers![0];
        expect(offer.productId).toBe("us-gpu-4070");
        expect(offer.currencyCode).toBe("USD");
        expect(offer.countryCode).toBe("US");
        expect(offer.price).toBe(549.99);
        expect(offer.priceMinor).toBe(54999);
        expect(offer.retailerId).toBe("best-buy-store");
        expect(offer.inStock).toBe(false);
        expect(offer.availability).toBe("out_of_stock");
        expect(offer.sourceType).toBe("scraped");

        await repo.close();
      });
    });
  });

  // =========================================================================
  // 3. Remote Turso Error Resilience & Fault Tolerance
  // =========================================================================
  describe("3. Remote Turso Error Resilience", () => {
    it("handles missing or empty Turso URL with clean synchronous rejection", () => {
      expect(() => new TursoCatalogRepository({ url: "" })).toThrow(
        /Missing required Turso database URL/
      );
      expect(() => new TursoCatalogRepository({ url: "   " })).toThrow(
        /Missing required Turso database URL/
      );
    });

    it("wraps client initialization failures cleanly", () => {
      // Passing an invalid URL scheme to createClient
      expect(() => new TursoCatalogRepository({ url: "ftp://invalid-turso-protocol" })).toThrow(
        /Failed to initialize Turso client/
      );
    });

    it("survives remote query failures (timeouts, network drops) without unhandled rejection", async () => {
      const mockClient = createControllableClient();
      mockClient.shouldFail = true;
      mockClient.failError = new Error("Connection timed out after 5000ms");

      const repo = new TursoCatalogRepository({ client: mockClient });
      const scope: CatalogScope = { countryCode: "US", currency: "USD" };

      await expect(repo.getCatalog(scope)).rejects.toThrow(
        /\[TursoCatalogRepository\] Query execution failed: Connection timed out after 5000ms/
      );

      await expect(repo.searchProducts({}, scope)).rejects.toThrow(
        /\[TursoCatalogRepository\] Query execution failed: Connection timed out after 5000ms/
      );

      await expect(repo.getCategoryBaseline("cpu", scope)).rejects.toThrow(
        /\[TursoCatalogRepository\] Query execution failed: Connection timed out after 5000ms/
      );

      await expect(repo.getFreshness()).rejects.toThrow(
        /\[TursoCatalogRepository\] Query execution failed: Connection timed out after 5000ms/
      );

      await repo.close();
    });

    it("rejects operations cleanly when called on a closed repository", async () => {
      const mockClient = createControllableClient();
      const repo = new TursoCatalogRepository({ client: mockClient });
      const scope: CatalogScope = { countryCode: "US", currency: "USD" };

      await repo.close();

      await expect(repo.getCatalog(scope)).rejects.toThrow(/Repository is closed/);
      await expect(repo.searchProducts({}, scope)).rejects.toThrow(/Repository is closed/);
      await expect(repo.getCategoryBaseline("gpu", scope)).rejects.toThrow(/Repository is closed/);
      await expect(repo.getFreshness()).rejects.toThrow(/Repository is closed/);
      await expect(repo.getMarkets()).rejects.toThrow(/Repository is closed/);
    });

    it("provides idempotent close() implementation without throwing", async () => {
      const mockClient = createControllableClient();
      const repo = new TursoCatalogRepository({ client: mockClient });

      await repo.close();
      await expect(repo.close()).resolves.toBeUndefined();
      await expect(repo.close()).resolves.toBeUndefined();
    });

    it("resiliently recovers when secondary freshness rowCount query fails", async () => {
      const mockClient = createControllableClient();
      // Succeeds for main product count, but fails on rowCounts query
      mockClient.customExecute = async (stmt) => {
        const sql = typeof stmt === "string" ? stmt : stmt.sql;
        if (sql.includes("GROUP BY country_code")) {
          throw new Error("Temporary partition error on country counts");
        }
        return {
          columns: ["lastScraped", "productCount"],
          columnTypes: ["TEXT", "INTEGER"],
          rows: [toMockRow({ lastScraped: "2026-09-02T10:00:00Z", productCount: 42 })],
          rowsAffected: 0,
          lastInsertRowid: undefined,
          toJSON: () => []
        };
      };

      const repo = new TursoCatalogRepository({ client: mockClient });
      const freshness = await repo.getFreshness();

      // Core freshness is preserved; rowCounts falls back to empty array
      expect(freshness.productCount).toBe(42);
      expect(freshness.lastScraped).toBe("2026-09-02T10:00:00Z");
      expect(freshness.rowCounts).toEqual([]);

      await repo.close();
    });
  });

  // =========================================================================
  // 4. Offline & Local Non-Regression
  // =========================================================================
  describe("4. Offline & Local Non-Regression", () => {
    it("guarantees 100% offline execution with zero network emissions", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");

      const db = createInMemoryDb();
      insertLocalProduct(db, {
        id: "local-cpu-1",
        name: "Intel Core i5-13600K",
        category: "cpu",
        price: 299,
        country_code: "US",
        currency: "USD"
      });

      const repo = new SqliteCatalogRepository(db);
      const scope: CatalogScope = { countryCode: "US", currency: "USD" };

      await repo.getCatalog(scope);
      await repo.searchProducts({ category: "cpu" }, scope);
      await repo.getCategoryBaseline("cpu", scope);
      await repo.getFreshness();
      await repo.getMarkets();

      expect(fetchSpy).not.toHaveBeenCalled();
      await repo.close();
    });

    it("enforces strict multi-market isolation across disparate regions", async () => {
      const db = createInMemoryDb();
      const repo = new SqliteCatalogRepository(db);

      // Seed products in US, IN, and UK
      insertLocalProduct(db, {
        id: "cpu-us",
        name: "Ryzen 5 7600 (US Edition)",
        category: "cpu",
        country_code: "US",
        currency: "USD",
        price: 199
      });
      insertLocalProduct(db, {
        id: "cpu-in",
        name: "Ryzen 5 7600 (India Edition)",
        category: "cpu",
        country_code: "IN",
        currency: "INR",
        price: 18500
      });
      insertLocalProduct(db, {
        id: "cpu-uk",
        name: "Ryzen 5 7600 (UK Edition)",
        category: "UK",
        currency: "GBP",
        price: 180
      });

      // Query US
      const usResults = await repo.searchProducts(
        { category: "cpu" },
        { countryCode: "US", currency: "USD" }
      );
      expect(usResults.results).toHaveLength(1);
      expect(usResults.results[0].id).toBe("cpu-us");
      expect(usResults.results[0].currency).toBe("USD");

      // Query IN
      const inResults = await repo.searchProducts(
        { category: "cpu" },
        { countryCode: "IN", currency: "INR" }
      );
      expect(inResults.results).toHaveLength(1);
      expect(inResults.results[0].id).toBe("cpu-in");
      expect(inResults.results[0].currency).toBe("INR");

      // Baseline US vs IN
      const usBaseline = await repo.getCategoryBaseline("cpu", { countryCode: "US", currency: "USD" });
      expect(usBaseline.total).toBe(1);
      expect(usBaseline.min_price).toBe(199);

      const inBaseline = await repo.getCategoryBaseline("cpu", { countryCode: "IN", currency: "INR" });
      expect(inBaseline.total).toBe(1);
      expect(inBaseline.min_price).toBe(18500);

      await repo.close();
    });

    it("safely neutralizes SQL injection attempts in search queries and parameters", async () => {
      const db = createInMemoryDb();
      const repo = new SqliteCatalogRepository(db);

      insertLocalProduct(db, { id: "p1", name: "Safe Part", category: "gpu", price: 500 });

      const maliciousInputs: SearchProductsInput[] = [
        { term: "' OR '1'='1" },
        { term: "'; DROP TABLE products; --" },
        { term: "' UNION SELECT * FROM products --" },
        { retailer: "'; DELETE FROM products; --" },
        { category: "gpu' OR 1=1 --" }
      ];

      for (const input of maliciousInputs) {
        // Must execute cleanly without throwing SQLite exceptions or modifying schema
        const result = await repo.searchProducts(input, { countryCode: "US", currency: "USD" });
        expect(Array.isArray(result.results)).toBe(true);
      }

      // Verify database table and rows were not dropped or corrupted
      const checkBaseline = await repo.getCategoryBaseline("gpu", { countryCode: "US", currency: "USD" });
      expect(checkBaseline.total).toBe(1);

      await repo.close();
    });

    it("handles wildcard characters, special symbols, and unicode without error", async () => {
      const db = createInMemoryDb();
      const repo = new SqliteCatalogRepository(db);

      insertLocalProduct(db, {
        id: "special-1",
        name: "Special 100% Metal_Case Cooler",
        category: "cooler",
        price: 75
      });
      insertLocalProduct(db, {
        id: "unicode-1",
        name: "ASUS ゲーミング RTX 5090",
        category: "gpu",
        price: 1999
      });

      // Wildcard searches
      const resWildcard = await repo.searchProducts(
        { term: "%Metal_" },
        { countryCode: "US", currency: "USD" }
      );
      expect(resWildcard.results.length).toBeGreaterThanOrEqual(1);

      // Unicode search
      const resUnicode = await repo.searchProducts(
        { term: "ゲーミング" },
        { countryCode: "US", currency: "USD" }
      );
      expect(resUnicode.results.length).toBe(1);
      expect(resUnicode.results[0].id).toBe("unicode-1");

      await repo.close();
    });

    it("handles zero-match and edge-case limits/offsets cleanly", async () => {
      const db = createInMemoryDb();
      const repo = new SqliteCatalogRepository(db);

      insertLocalProduct(db, { id: "p1", name: "Part 1", category: "ram", price: 80 });

      // limit = 0
      const limitZero = await repo.searchProducts({ limit: 0 }, { countryCode: "US", currency: "USD" });
      expect(limitZero.results).toEqual([]);
      expect(limitZero.total_matching).toBe(1);

      // limit exceeding max (50) capped safely
      const overLimit = await repo.searchProducts({ limit: 99999 }, { countryCode: "US", currency: "USD" });
      expect(overLimit.results).toHaveLength(1);

      // offset beyond match count
      const overOffset = await repo.searchProducts({ offset: 100 }, { countryCode: "US", currency: "USD" });
      expect(overOffset.results).toEqual([]);

      await repo.close();
    });
  });
});
