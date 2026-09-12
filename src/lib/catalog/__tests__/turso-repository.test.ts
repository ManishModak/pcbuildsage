/**
 * src/lib/catalog/__tests__/turso-repository.test.ts
 *
 * Comprehensive unit and contract tests for TursoCatalogRepository (Phase 1).
 * Tests credential validation, query execution with mock @libsql/client,
 * error handling, offer mapping, and lifecycle close().
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createClient,
  type Client,
  type InStatement,
  type ResultSet,
  type Row
} from "@libsql/client";
import {
  TursoCatalogRepository,
  getCatalogRepository,
  registerCatalogRepository,
  resetCatalogRepositoryRegistry,
  type CatalogScope,
  type SearchProductsInput
} from "@/lib/catalog";

type MockRow = Record<string, unknown>;

interface MockLibsqlClient extends Client {
  executed: Array<{ sql: string; args?: unknown[] }>;
  mockRows: MockRow[];
  shouldFail?: boolean;
  failureMessage?: string;
}

function toMockRow(data: Record<string, unknown>): Row {
  const row = { ...data } as unknown as Row;
  Object.defineProperty(row, "length", { value: Object.keys(data).length });
  return row;
}

function createMockClient(initialRows: MockRow[] = []): MockLibsqlClient {
  const executed: Array<{ sql: string; args?: unknown[] }> = [];
  let isClosed = false;

  const mock: MockLibsqlClient = {
    executed,
    mockRows: initialRows,
    shouldFail: false,
    failureMessage: "Remote LibSQL connection failed",
    get closed() {
      return isClosed;
    },
    protocol: "http",
    execute: (async (stmt: InStatement): Promise<ResultSet> => {
      if (isClosed) throw new Error("Client is closed");
      if (mock.shouldFail) throw new Error(mock.failureMessage);

      const sql = typeof stmt === "string" ? stmt : stmt.sql;
      const args = typeof stmt === "object" && "args" in stmt ? (stmt.args as unknown[]) : undefined;
      executed.push({ sql, args });

      const upper = sql.trim().toUpperCase();

      // Category summary queries for getCatalog
      if (upper.includes("GROUP BY CATEGORY, SUBCATEGORY")) {
        return {
          columns: ["category", "subcategory", "count", "price_min", "price_max"],
          columnTypes: ["TEXT", "TEXT", "INTEGER", "REAL", "REAL"],
          rows: [
            toMockRow({ category: "storage", subcategory: "removable", count: 2, price_min: 15, price_max: 40 })
          ],
          rowsAffected: 0,
          lastInsertRowid: undefined,
          toJSON: () => []
        };
      }

      if (upper.includes("GROUP BY CATEGORY")) {
        return {
          columns: ["category", "count", "in_stock_count", "price_min", "price_max"],
          columnTypes: ["TEXT", "INTEGER", "INTEGER", "REAL", "REAL"],
          rows: [
            toMockRow({ category: "cpu", count: 5, in_stock_count: 4, price_min: 199, price_max: 599 }),
            toMockRow({ category: "gpu", count: 3, in_stock_count: 3, price_min: 299, price_max: 999 })
          ],
          rowsAffected: 0,
          lastInsertRowid: undefined,
          toJSON: () => []
        };
      }

      // Count matches query
      if (upper.includes("SELECT COUNT(*) AS TOTAL_MATCHES")) {
        return {
          columns: ["total_matches"],
          columnTypes: ["INTEGER"],
          rows: [toMockRow({ total_matches: mock.mockRows.length })],
          rowsAffected: 0,
          lastInsertRowid: undefined,
          toJSON: () => []
        };
      }

      // Baseline query
      if (upper.includes("SELECT COUNT(*) AS TOTAL")) {
        const inStockCount = mock.mockRows.filter((r) => r.in_stock === 1).length;
        const prices = mock.mockRows
          .filter((r) => r.in_stock === 1 && typeof r.price === "number")
          .map((r) => Number(r.price));
        return {
          columns: ["total", "in_stock_total", "min_price", "max_price"],
          columnTypes: ["INTEGER", "INTEGER", "REAL", "REAL"],
          rows: [
            toMockRow({
              total: mock.mockRows.length,
              in_stock_total: inStockCount,
              min_price: prices.length ? Math.min(...prices) : null,
              max_price: prices.length ? Math.max(...prices) : null
            })
          ],
          rowsAffected: 0,
          lastInsertRowid: undefined,
          toJSON: () => []
        };
      }

      // Freshness query
      if (upper.includes("MAX(LAST_SCRAPED)")) {
        return {
          columns: ["productCount", "lastScraped"],
          columnTypes: ["INTEGER", "TEXT"],
          rows: [toMockRow({ productCount: 42, lastScraped: "2026-09-02T18:00:00.000Z" })],
          rowsAffected: 0,
          lastInsertRowid: undefined,
          toJSON: () => []
        };
      }

      // Default rows return (search, nearest match, etc.)
      return {
        columns: [],
        columnTypes: [],
        rows: mock.mockRows.map(toMockRow),
        rowsAffected: 0,
        lastInsertRowid: undefined,
        toJSON: () => []
      };
    }) as Client["execute"],
    async batch() {
      return [];
    },
    async migrate() {
      return [];
    },
    async transaction() {
      throw new Error("Not implemented in mock");
    },
    async executeMultiple() {
      return undefined;
    },
    async sync() {
      return undefined;
    },
    close() {
      isClosed = true;
    },
    reconnect() {
      isClosed = false;
    }
  };

  return mock;
}

describe("TursoCatalogRepository", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resetCatalogRepositoryRegistry();
    process.env = { ...originalEnv };
    delete process.env.TURSO_DATABASE_URL;
    delete process.env.TURSO_READ_TOKEN;
    delete process.env.TURSO_AUTH_TOKEN;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetCatalogRepositoryRegistry();
  });

  describe("Credential validation and constructor options", () => {
    it("throws a descriptive error when no database URL is provided and env vars are unset", () => {
      expect(() => new TursoCatalogRepository()).toThrow(
        /Missing required Turso database URL.*TURSO_DATABASE_URL/i
      );
    });

    it("throws a descriptive error when options.url is empty whitespace", () => {
      expect(() => new TursoCatalogRepository({ url: "   " })).toThrow(
        /Missing required Turso database URL/i
      );
    });

    it("initializes successfully when url and authToken are provided via constructor options", () => {
      const repo = new TursoCatalogRepository({
        url: "libsql://test-db.turso.io",
        authToken: "mock-auth-token"
      });
      expect(repo).toBeDefined();
      expect(repo.client).toBeDefined();
    });

    it("initializes successfully using TURSO_DATABASE_URL and TURSO_READ_TOKEN environment variables", () => {
      process.env.TURSO_DATABASE_URL = "libsql://env-db.turso.io";
      process.env.TURSO_READ_TOKEN = "env-read-token";

      const repo = new TursoCatalogRepository();
      expect(repo).toBeDefined();
      expect(repo.client).toBeDefined();
    });

    it("accepts an injected Client instance directly or via options", () => {
      const mockClient = createMockClient();
      const repo1 = new TursoCatalogRepository({ client: mockClient });
      expect(repo1.client).toBe(mockClient);

      const repo2 = new TursoCatalogRepository(mockClient);
      expect(repo2.client).toBe(mockClient);
    });
  });

  describe("Factory registration for hosted-demo mode", () => {
    it("is registered for 'hosted-demo' mode and instantiates TursoCatalogRepository", () => {
      process.env.TURSO_DATABASE_URL = "libsql://demo.turso.io";
      process.env.TURSO_READ_TOKEN = "demo-token";

      // Register default factory
      registerCatalogRepository("hosted-demo", () => new TursoCatalogRepository());

      const repo = getCatalogRepository("hosted-demo");
      expect(repo).toBeDefined();
      expect(repo).toBeInstanceOf(TursoCatalogRepository);
    });

    it("throws clear error when hosted-demo factory is unregistered after reset", () => {
      resetCatalogRepositoryRegistry();
      expect(() => getCatalogRepository("hosted-demo")).toThrow(
        /Turso repository adapter is not registered for mode "hosted-demo"/
      );
    });
  });

  describe("Catalog queries and aggregation (getCatalog)", () => {
    it("retrieves category summaries with build counts and subcategory breakdowns", async () => {
      const mockClient = createMockClient();
      const repo = new TursoCatalogRepository({ client: mockClient });
      const scope: CatalogScope = { countryCode: "US", currency: "USD" };

      const catalogResult = await repo.getCatalog(scope);

      expect(catalogResult.scope).toEqual({ country_code: "US", currency: "USD" });
      expect(Array.isArray(catalogResult.categories)).toBe(true);

      const cpuSummary = catalogResult.categories.find((c) => c.category === "cpu");
      expect(cpuSummary).toBeDefined();
      expect(cpuSummary?.count).toBe(5);
      expect(cpuSummary?.in_stock_count).toBe(4);
      expect(cpuSummary?.price_min).toBe(199);
      expect(cpuSummary?.price_max).toBe(599);

      const storageSummary = catalogResult.categories.find((c) => c.category === "storage");
      expect(storageSummary?.subcategories?.removable).toEqual({
        count: 2,
        price_min: 15,
        price_max: 40
      });

      // Verify queries were executed with parameterization
      expect(mockClient.executed.length).toBeGreaterThanOrEqual(2);
      expect(mockClient.executed[0].args).toEqual(["US", "USD"]);
    });
  });

  describe("Product search, query parameterization, and spec matching (searchProducts)", () => {
    const mockProductRow = {
      id: "prod-gpu-1",
      name: "ASUS Dual GeForce RTX 4070 SUPER 12GB",
      normalized_name: "asus dual geforce rtx 4070 super 12gb",
      registry_key: "nvidia-rtx-4070-super",
      price: 599.99,
      currency: "USD",
      country_code: "US",
      retailer: "BestBuy",
      url: "https://bestbuy.com/p/rtx4070s",
      image_url: "https://bestbuy.com/img/rtx4070s.jpg",
      in_stock: 1,
      category: "gpu",
      subcategory: null,
      specs: JSON.stringify({ vram_gb: 12, length_mm: 267 }),
      first_seen: "2026-09-01T10:00:00Z",
      last_scraped: "2026-09-02T12:00:00Z"
    };

    it("parameterizes scope, category, term, and price filters properly", async () => {
      const mockClient = createMockClient([mockProductRow]);
      const repo = new TursoCatalogRepository({ client: mockClient });

      const input: SearchProductsInput = {
        term: "4070",
        category: "gpu",
        price_min: 500,
        price_max: 700,
        retailer: "BestBuy",
        in_stock: true,
        limit: 10
      };
      const scope: CatalogScope = { countryCode: "US", currency: "USD" };

      const searchResult = await repo.searchProducts(input, scope);

      expect(searchResult.results.length).toBe(1);
      expect(searchResult.total_matching).toBe(1);

      // Verify the executed SQL query contained parameterized clauses
      const mainQuery = mockClient.executed.find((e) => e.sql.includes("FROM products WHERE"));
      expect(mainQuery).toBeDefined();
      expect(mainQuery?.sql).toContain("country_code = ?");
      expect(mainQuery?.sql).toContain("currency = ?");
      expect(mainQuery?.sql).toContain("name LIKE ? OR normalized_name LIKE ?");
      expect(mainQuery?.sql).toContain("category = ?");
      expect(mainQuery?.sql).toContain("price >= ?");
      expect(mainQuery?.sql).toContain("price <= ?");
      expect(mainQuery?.sql).toContain("retailer LIKE ?");
      expect(mainQuery?.sql).toContain("in_stock = ?");
      expect(mainQuery?.args).toContain("US");
      expect(mainQuery?.args).toContain("USD");
      expect(mainQuery?.args).toContain("%4070%");
      expect(mainQuery?.args).toContain(500);
      expect(mainQuery?.args).toContain(700);
      expect(mainQuery?.args).toContain("%BestBuy%");
    });

    it("applies registry specification filters (e.g. min_vram_gb)", async () => {
      const mockClient = createMockClient([mockProductRow]);
      const repo = new TursoCatalogRepository({ client: mockClient });

      // Request min 16GB VRAM; product only has 12GB
      const input: SearchProductsInput = {
        category: "gpu",
        min_vram_gb: 16
      };
      const scope: CatalogScope = { countryCode: "US", currency: "USD" };

      const searchResult = await repo.searchProducts(input, scope);
      expect(searchResult.results.length).toBe(0);
    });

    it("formats product results with attached ProductOffer objects preserving native currency and minor units", async () => {
      const inProductRow = {
        id: "prod-in-gpu",
        name: "Gigabyte GeForce RTX 4070 Super Eagle OC",
        normalized_name: "gigabyte rtx 4070 super",
        registry_key: "nvidia-rtx-4070-super",
        price: 59999,
        currency: "INR",
        country_code: "IN",
        retailer: "MDComputers",
        url: "https://mdcomputers.in/gpu-4070s",
        image_url: "https://mdcomputers.in/images/gpu.jpg",
        in_stock: 1,
        category: "gpu",
        subcategory: null,
        specs: JSON.stringify({ vram_gb: 12 }),
        first_seen: "2026-09-01T00:00:00Z",
        last_scraped: "2026-09-02T12:00:00Z"
      };

      const mockClient = createMockClient([inProductRow]);
      const repo = new TursoCatalogRepository({ client: mockClient });
      const scope: CatalogScope = { countryCode: "IN", currency: "INR" };

      const res = await repo.searchProducts({ category: "gpu" }, scope);
      expect(res.results.length).toBe(1);

      const item = res.results[0];
      expect(item.id).toBe("prod-in-gpu");
      expect(item.price).toBe(59999);
      expect(item.currency).toBe("INR");
      expect(item.country_code).toBe("IN");

      // Verify attached ProductOffer
      expect(item.offers).toBeDefined();
      expect(item.offers?.length).toBe(1);
      const offer = item.offers![0];

      expect(offer.productId).toBe("prod-in-gpu");
      expect(offer.retailer).toBe("MDComputers");
      expect(offer.retailerId).toBe("mdcomputers");
      expect(offer.countryCode).toBe("IN");
      expect(offer.currencyCode).toBe("INR");
      expect(offer.price).toBe(59999);
      // INR has 2 decimal digits -> 59999 * 100 = 5999900 minor units
      expect(offer.priceMinor).toBe(5999900);
      expect(offer.destinationUrl).toBe("https://mdcomputers.in/gpu-4070s");
      expect(offer.sourceType).toBe("scraped");
      expect(offer.availability).toBe("in_stock");
      expect(offer.inStock).toBe(true);
    });

    it("returns empty result with descriptive hints when no products match", async () => {
      const mockClient = createMockClient([]);
      const repo = new TursoCatalogRepository({ client: mockClient });
      const res = await repo.searchProducts({ category: "gpu" }, { countryCode: "US", currency: "USD" });

      expect(res.results).toEqual([]);
      expect(res.total_matching).toBe(0);
      expect(res.hint).toBeDefined();
    });
  });

  describe("Category baseline metrics (getCategoryBaseline)", () => {
    it("returns CategoryBaselineResult with numeric metrics", async () => {
      const mockClient = createMockClient([
        { id: "1", price: 200, in_stock: 1 },
        { id: "2", price: 400, in_stock: 1 }
      ]);
      const repo = new TursoCatalogRepository({ client: mockClient });

      const baseline = await repo.getCategoryBaseline("cpu", { countryCode: "US", currency: "USD" });

      expect(baseline.total).toBe(2);
      expect(baseline.in_stock_total).toBe(2);
      expect(baseline.min_price).toBe(200);
      expect(baseline.max_price).toBe(400);
      expect(baseline.totalCount).toBe(2);
      expect(baseline.inStockTotal).toBe(2);
    });
  });

  describe("Catalog freshness metrics (getFreshness)", () => {
    it("returns product count and lastScraped timestamp", async () => {
      const mockClient = createMockClient();
      const repo = new TursoCatalogRepository({ client: mockClient });

      const freshness = await repo.getFreshness("US");
      expect(freshness.productCount).toBe(42);
      expect(freshness.lastScraped).toBe("2026-09-02T18:00:00.000Z");
      expect(freshness.countryCode).toBe("US");

      const lastQuery = mockClient.executed.find((e) => e.sql.includes("MAX(last_scraped)"));
      expect(lastQuery?.args).toEqual(["US"]);
    });
  });

  describe("Market metadata (getMarkets)", () => {
    it("returns supported standard markets metadata", async () => {
      const mockClient = createMockClient();
      const repo = new TursoCatalogRepository({ client: mockClient });

      const markets = await repo.getMarkets();
      expect(Array.isArray(markets)).toBe(true);
      expect(markets.length).toBeGreaterThanOrEqual(3);
      expect(markets.some((m) => m.code === "US")).toBe(true);
      expect(markets.some((m) => m.code === "IN")).toBe(true);
    });
  });

  describe("Error handling and remote failures", () => {
    it("throws clear, diagnostic error when remote query execution fails", async () => {
      const mockClient = createMockClient();
      mockClient.shouldFail = true;
      mockClient.failureMessage = "503 Service Unavailable: Turso cluster maintenance";

      const repo = new TursoCatalogRepository({ client: mockClient });

      await expect(repo.getCatalog({ countryCode: "US", currency: "USD" })).rejects.toThrow(
        /Query execution failed.*503 Service Unavailable/
      );
      await expect(repo.searchProducts({}, { countryCode: "US", currency: "USD" })).rejects.toThrow(
        /Query execution failed.*503 Service Unavailable/
      );
      await expect(repo.getCategoryBaseline("cpu", { countryCode: "US", currency: "USD" })).rejects.toThrow(
        /Query execution failed.*503 Service Unavailable/
      );
      await expect(repo.getFreshness()).rejects.toThrow(
        /Query execution failed.*503 Service Unavailable/
      );
    });
  });

  describe("Lifecycle close()", () => {
    it("closes the underlying client and rejects further operations with 'closed' error", async () => {
      const mockClient = createMockClient();
      const repo = new TursoCatalogRepository({ client: mockClient });

      await repo.close();
      expect(mockClient.closed).toBe(true);

      await expect(repo.getCatalog()).rejects.toThrow(/closed/i);
      await expect(repo.searchProducts({})).rejects.toThrow(/closed/i);
      await expect(repo.getCategoryBaseline("cpu")).rejects.toThrow(/closed/i);
      await expect(repo.getFreshness()).rejects.toThrow(/closed/i);
      await expect(repo.getMarkets()).rejects.toThrow(/closed/i);
    });

    it("is idempotent when close() is invoked multiple times", async () => {
      const mockClient = createMockClient();
      const repo = new TursoCatalogRepository({ client: mockClient });

      await repo.close();
      await expect(repo.close()).resolves.toBeUndefined();
    });
  });

  describe("Live in-memory LibSQL integration", () => {
    it("executes real LibSQL queries against an in-memory database using createClient", async () => {
      const client = createClient({ url: ":memory:" });

      await client.execute(`
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

      await client.execute({
        sql: `INSERT INTO products (
          id, name, normalized_name, registry_key, price, currency, country_code,
          retailer, url, in_stock, category, subcategory, first_seen, last_scraped
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          "ram-ddr5-1",
          "Corsair Vengeance DDR5 32GB",
          "corsair vengeance ddr5 32gb",
          "corsair-vengeance-ddr5-32gb",
          119.99,
          "USD",
          "US",
          "Amazon",
          "https://amazon.com/dp/B001",
          1,
          "ram",
          null,
          "2026-09-01T00:00:00Z",
          "2026-09-02T10:00:00Z"
        ]
      });

      const repo = new TursoCatalogRepository({ client });

      const search = await repo.searchProducts({ category: "ram" }, { countryCode: "US", currency: "USD" });
      expect(search.results.length).toBe(1);
      expect(search.results[0].name).toContain("Corsair Vengeance");
      expect(search.results[0].offers?.[0].priceMinor).toBe(11999);

      const baseline = await repo.getCategoryBaseline("ram", { countryCode: "US", currency: "USD" });
      expect(baseline.total).toBe(1);
      expect(baseline.min_price).toBe(119.99);

      const freshness = await repo.getFreshness("US");
      expect(freshness.productCount).toBe(1);
      expect(freshness.lastScraped).toBe("2026-09-02T10:00:00Z");

      await repo.close();
    });
  });
});
