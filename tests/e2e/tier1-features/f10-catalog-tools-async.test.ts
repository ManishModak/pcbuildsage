import { describe, it, expect } from "vitest";
import { MemorySqliteRepository, createMockProduct, createTestSqliteDb } from "../test-harness";

describe("Tier 1 - Feature 10: Catalog Tools Async Support (R2)", () => {
  it("asynchronously retrieves and formats catalog items for LLM tools", async () => {
    const p1 = createMockProduct({ id: "gpu-1", name: "RTX 4080", category: "gpu", price: 1199 });
    const { dbPath, cleanup } = createTestSqliteDb({ products: [p1] });
    const repo = new MemorySqliteRepository(dbPath);

    const catalog = await repo.getCatalog("US");
    expect(catalog.length).toBe(1);
    expect(catalog[0].name).toContain("RTX 4080");

    await repo.close();
    cleanup();
  });

  it("executes async search tool query with parameter filtering", async () => {
    const p1 = createMockProduct({ id: "cpu-1", name: "AMD Ryzen 9 7950X", category: "cpu", price: 549 });
    const p2 = createMockProduct({ id: "cpu-2", name: "AMD Ryzen 5 7600", category: "cpu", price: 199 });
    const { dbPath, cleanup } = createTestSqliteDb({ products: [p1, p2] });
    const repo = new MemorySqliteRepository(dbPath);

    const result = await repo.searchProducts({ category: "cpu", maxPrice: 300 }, "US");
    expect(result.totalCount).toBe(1);
    expect(result.items[0].id).toBe("cpu-2");

    await repo.close();
    cleanup();
  });

  it("handles pagination parameters in search queries", async () => {
    const prods = Array.from({ length: 15 }, (_, i) =>
      createMockProduct({ id: `p-${i}`, name: `Product ${i}`, category: "case" })
    );
    const { dbPath, cleanup } = createTestSqliteDb({ products: prods });
    const repo = new MemorySqliteRepository(dbPath);

    const page1 = await repo.searchProducts({ category: "case", limit: 5, offset: 0 });
    expect(page1.items.length).toBe(5);
    expect(page1.totalCount).toBe(15);

    const page2 = await repo.searchProducts({ category: "case", limit: 5, offset: 5 });
    expect(page2.items.length).toBe(5);
    expect(page2.items[0].id).not.toBe(page1.items[0].id);

    await repo.close();
    cleanup();
  });

  it("gracefully returns empty list when search returns zero matches", async () => {
    const { dbPath, cleanup } = createTestSqliteDb({ products: [] });
    const repo = new MemorySqliteRepository(dbPath);

    const result = await repo.searchProducts({ term: "NonExistentHardware" });
    expect(result.items).toEqual([]);
    expect(result.totalCount).toBe(0);

    await repo.close();
    cleanup();
  });

  it("respects market countryCode filter in tool queries", async () => {
    const pUS = createMockProduct({ id: "p-us", countryCode: "US", price: 100 });
    const pUK = createMockProduct({ id: "p-uk", countryCode: "UK", price: 80, currency: "GBP" });
    const { dbPath, cleanup } = createTestSqliteDb({ products: [pUS, pUK] });
    const repo = new MemorySqliteRepository(dbPath);

    const usResults = await repo.getCatalog("US");
    expect(usResults.length).toBe(1);
    expect(usResults[0].id).toBe("p-us");

    const ukResults = await repo.getCatalog("UK");
    expect(ukResults.length).toBe(1);
    expect(ukResults[0].id).toBe("p-uk");

    await repo.close();
    cleanup();
  });
});
