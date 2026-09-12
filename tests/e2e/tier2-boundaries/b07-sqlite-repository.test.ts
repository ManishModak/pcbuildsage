import { describe, it, expect } from "vitest";
import { MemorySqliteRepository, createTestSqliteDb, createMockProduct } from "../test-harness";

describe("Tier 2 Boundary - Feature 7: SQLite Catalog Repository Adapter Boundaries", () => {
  it("handles unicode and special character product searches (e.g. 'GeForce® RTX™')", async () => {
    const p1 = createMockProduct({ name: "GeForce® RTX™ 4090 Gaming OC" });
    const { dbPath, cleanup } = createTestSqliteDb({ products: [p1] });
    const repo = new MemorySqliteRepository(dbPath);

    const result = await repo.searchProducts({ term: "RTX™" });
    expect(result.totalCount).toBe(1);

    await repo.close();
    cleanup();
  });

  it("handles zero-byte / empty database file error safely", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const emptyDbPath = path.join(os.tmpdir(), `empty-${Date.now()}.db`);
    fs.writeFileSync(emptyDbPath, "");

    const repo = new MemorySqliteRepository(emptyDbPath);
    await expect(repo.getCatalog()).rejects.toThrow();

    await repo.close();
    fs.unlinkSync(emptyDbPath);
  });

  it("handles products with null normalized_name or specs column", async () => {
    const p1 = createMockProduct({ normalizedName: undefined, specs: undefined });
    const { dbPath, cleanup } = createTestSqliteDb({ products: [p1] });
    const repo = new MemorySqliteRepository(dbPath);

    const catalog = await repo.getCatalog();
    expect(catalog.length).toBe(1);
    expect(catalog[0].id).toBe(p1.id);

    await repo.close();
    cleanup();
  });

  it("handles queries with limit 0 by returning 0 items with correct totalCount", async () => {
    const p1 = createMockProduct();
    const { dbPath, cleanup } = createTestSqliteDb({ products: [p1] });
    const repo = new MemorySqliteRepository(dbPath);

    const result = await repo.searchProducts({ limit: 0 });
    expect(result.items.length).toBe(0);
    expect(result.totalCount).toBe(1);

    await repo.close();
    cleanup();
  });

  it("returns inStock=false products when inStockOnly is omitted or false", async () => {
    const pOut = createMockProduct({ inStock: false });
    const { dbPath, cleanup } = createTestSqliteDb({ products: [pOut] });
    const repo = new MemorySqliteRepository(dbPath);

    const res = await repo.searchProducts({ inStockOnly: false });
    expect(res.totalCount).toBe(1);

    const resOnlyInStock = await repo.searchProducts({ inStockOnly: true });
    expect(resOnlyInStock.totalCount).toBe(0);

    await repo.close();
    cleanup();
  });
});
