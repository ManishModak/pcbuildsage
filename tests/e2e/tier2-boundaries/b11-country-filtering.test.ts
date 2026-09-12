import { describe, it, expect } from "vitest";
import { MemorySqliteRepository, createTestSqliteDb, createMockProduct } from "../test-harness";

describe("Tier 2 Boundary - Feature 11: Country Filtering Boundaries", () => {
  it("handles non-standard country code casing (e.g. 'uS', 'Uk', 'iN')", async () => {
    const pUS = createMockProduct({ countryCode: "US" });
    const { dbPath, cleanup } = createTestSqliteDb({ products: [pUS] });
    const repo = new MemorySqliteRepository(dbPath);

    const res = await repo.getCatalog("uS");
    expect(res.length).toBe(1);

    await repo.close();
    cleanup();
  });

  it("handles queries for non-existent 3-letter or numeric country codes", async () => {
    const pUS = createMockProduct({ countryCode: "US" });
    const { dbPath, cleanup } = createTestSqliteDb({ products: [pUS] });
    const repo = new MemorySqliteRepository(dbPath);

    const res = await repo.getCatalog("USA");
    expect(res.length).toBe(0);

    await repo.close();
    cleanup();
  });

  it("filters out multiple peripheral non-build subcategories in single query", async () => {
    const p1 = createMockProduct({ id: "1", subcategory: "desk-mat" });
    const p2 = createMockProduct({ id: "2", subcategory: "flash-drive" });
    const p3 = createMockProduct({ id: "3", subcategory: "cleaning-kit" });
    const pValid = createMockProduct({ id: "4", subcategory: "liquid-cooler" });
    const { dbPath, cleanup } = createTestSqliteDb({ products: [p1, p2, p3, pValid] });
    const repo = new MemorySqliteRepository(dbPath);

    const catalog = await repo.getCatalog();
    expect(catalog.length).toBe(1);
    expect(catalog[0].id).toBe("4");

    await repo.close();
    cleanup();
  });

  it("handles country filter when all database products belong to a different market", async () => {
    const p1 = createMockProduct({ countryCode: "DE" });
    const { dbPath, cleanup } = createTestSqliteDb({ products: [p1] });
    const repo = new MemorySqliteRepository(dbPath);

    const res = await repo.getCatalog("US");
    expect(res.length).toBe(0);

    await repo.close();
    cleanup();
  });

  it("returns full global catalog when countryCode is omitted or undefined", async () => {
    const pUS = createMockProduct({ id: "us-1", countryCode: "US" });
    const pUK = createMockProduct({ id: "uk-1", countryCode: "UK" });
    const { dbPath, cleanup } = createTestSqliteDb({ products: [pUS, pUK] });
    const repo = new MemorySqliteRepository(dbPath);

    const res = await repo.getCatalog(undefined);
    expect(res.length).toBe(2);

    await repo.close();
    cleanup();
  });
});
