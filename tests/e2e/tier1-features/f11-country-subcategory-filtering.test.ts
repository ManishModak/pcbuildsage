import { describe, it, expect } from "vitest";
import { MemorySqliteRepository, createMockProduct, createTestSqliteDb } from "../test-harness";

describe("Tier 1 - Feature 11: Country & Subcategory Filtering (R2)", () => {
  it("filters products strictly by countryCode (e.g. US vs UK)", async () => {
    const p1 = createMockProduct({ id: "p-us", countryCode: "US" });
    const p2 = createMockProduct({ id: "p-uk", countryCode: "UK" });
    const { dbPath, cleanup } = createTestSqliteDb({ products: [p1, p2] });
    const repo = new MemorySqliteRepository(dbPath);

    const usCatalog = await repo.getCatalog("US");
    expect(usCatalog.length).toBe(1);
    expect(usCatalog[0].id).toBe("p-us");

    await repo.close();
    cleanup();
  });

  it("includes products where subcategory is null or standard build-relevant category", async () => {
    const p1 = createMockProduct({ id: "p-core", category: "cpu", subcategory: undefined });
    const p2 = createMockProduct({ id: "p-sub", category: "cpu", subcategory: "desktop-processor" });
    const { dbPath, cleanup } = createTestSqliteDb({ products: [p1, p2] });
    const repo = new MemorySqliteRepository(dbPath);

    const catalog = await repo.getCatalog();
    expect(catalog.length).toBe(2);

    await repo.close();
    cleanup();
  });

  it("excludes non-build-relevant subcategories (e.g. flash-drive, mouse-pad) from queries", async () => {
    const pValid = createMockProduct({ id: "p-ssd", category: "storage", subcategory: "nvme-ssd" });
    const pPenDrive = createMockProduct({ id: "p-pen", category: "storage", subcategory: "flash-drive" });
    const pPad = createMockProduct({ id: "p-pad", category: "accessories", subcategory: "mouse-pad" });
    const { dbPath, cleanup } = createTestSqliteDb({ products: [pValid, pPenDrive, pPad] });
    const repo = new MemorySqliteRepository(dbPath);

    const catalog = await repo.getCatalog();
    expect(catalog.length).toBe(1);
    expect(catalog[0].id).toBe("p-ssd");

    await repo.close();
    cleanup();
  });

  it("handles countryCode case-insensitively (e.g. 'us' and 'US')", async () => {
    const p1 = createMockProduct({ id: "p-us", countryCode: "US" });
    const { dbPath, cleanup } = createTestSqliteDb({ products: [p1] });
    const repo = new MemorySqliteRepository(dbPath);

    const resLower = await repo.getCatalog("us");
    expect(resLower.length).toBe(1);

    const resUpper = await repo.getCatalog("US");
    expect(resUpper.length).toBe(1);

    await repo.close();
    cleanup();
  });

  it("returns empty list when no products match the specified countryCode", async () => {
    const p1 = createMockProduct({ id: "p-us", countryCode: "US" });
    const { dbPath, cleanup } = createTestSqliteDb({ products: [p1] });
    const repo = new MemorySqliteRepository(dbPath);

    const resIN = await repo.getCatalog("IN");
    expect(resIN.length).toBe(0);

    await repo.close();
    cleanup();
  });
});
