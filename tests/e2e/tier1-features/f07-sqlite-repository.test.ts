import { describe, it, expect } from "vitest";
import { MemorySqliteRepository, createMockProduct, createTestSqliteDb } from "../test-harness";

describe("Tier 1 - Feature 7: SQLite Catalog Repository Adapter (R2)", () => {
  it("reads products from local SQLite database file using schema v5", async () => {
    const p1 = createMockProduct({ id: "cpu-1", name: "AMD Ryzen 5 7600X", category: "cpu", price: 229 });
    const { dbPath, cleanup } = createTestSqliteDb({ products: [p1] });

    const repo = new MemorySqliteRepository(dbPath);
    const catalog = await repo.getCatalog();
    expect(catalog.length).toBe(1);
    expect(catalog[0].id).toBe("cpu-1");
    expect(catalog[0].name).toBe("AMD Ryzen 5 7600X");
    expect(catalog[0].price).toBe(229);

    await repo.close();
    cleanup();
  });

  it("performs case-insensitive search queries across product names and normalized names", async () => {
    const p1 = createMockProduct({ id: "gpu-1", name: "NVIDIA GeForce RTX 4070 SUPER", normalizedName: "rtx 4070 super" });
    const p2 = createMockProduct({ id: "gpu-2", name: "AMD Radeon RX 7800 XT", normalizedName: "rx 7800 xt" });
    const { dbPath, cleanup } = createTestSqliteDb({ products: [p1, p2] });

    const repo = new MemorySqliteRepository(dbPath);
    const res = await repo.searchProducts({ term: "geforce" });
    expect(res.totalCount).toBe(1);
    expect(res.items[0].id).toBe("gpu-1");

    const resNorm = await repo.searchProducts({ term: "4070 super" });
    expect(resNorm.totalCount).toBe(1);
    expect(resNorm.items[0].id).toBe("gpu-1");

    await repo.close();
    cleanup();
  });

  it("filters search results by category and price range accurately", async () => {
    const p1 = createMockProduct({ id: "p1", category: "ram", price: 80 });
    const p2 = createMockProduct({ id: "p2", category: "ram", price: 150 });
    const p3 = createMockProduct({ id: "p3", category: "gpu", price: 500 });
    const { dbPath, cleanup } = createTestSqliteDb({ products: [p1, p2, p3] });

    const repo = new MemorySqliteRepository(dbPath);
    const ramRes = await repo.searchProducts({ category: "ram", minPrice: 50, maxPrice: 100 });
    expect(ramRes.totalCount).toBe(1);
    expect(ramRes.items[0].id).toBe("p1");

    await repo.close();
    cleanup();
  });

  it("reports freshness timestamp and count accurately from sqlite", async () => {
    const p1 = createMockProduct({ lastScraped: "2026-09-02T14:00:00Z" });
    const { dbPath, cleanup } = createTestSqliteDb({ products: [p1] });

    const repo = new MemorySqliteRepository(dbPath);
    const freshness = await repo.getFreshness();
    expect(freshness.productCount).toBe(1);
    expect(freshness.lastScraped).toBe("2026-09-02T14:00:00Z");

    await repo.close();
    cleanup();
  });

  it("operates safely and does not mutate source products table on queries", async () => {
    const p1 = createMockProduct({ id: "orig-1", name: "Original Product" });
    const { dbPath, cleanup } = createTestSqliteDb({ products: [p1] });

    const repo = new MemorySqliteRepository(dbPath);
    await repo.getCatalog();
    await repo.searchProducts({ term: "Original" });

    const catalog = await repo.getCatalog();
    expect(catalog.length).toBe(1);
    expect(catalog[0].name).toBe("Original Product");

    await repo.close();
    cleanup();
  });
});
