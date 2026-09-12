import { describe, it, expect } from "vitest";
import { validateCatalogSnapshot, createTestSqliteDb, createMockProduct } from "../test-harness";

describe("Tier 1 - Feature 16: Stale Stock Sweep Ratio Gate (R3 / Gate 5)", () => {
  it("passes Gate 5 when out-of-stock ratio is within safe threshold (e.g. 10%)", async () => {
    const prods = [
      ...Array.from({ length: 90 }, (_, i) => createMockProduct({ id: `in-${i}`, inStock: true })),
      ...Array.from({ length: 10 }, (_, i) => createMockProduct({ id: `out-${i}`, inStock: false }))
    ];
    const { dbPath, cleanup } = createTestSqliteDb({ products: prods });

    const result = await validateCatalogSnapshot(dbPath, 100);
    expect(result.valid).toBe(true);
    expect(result.metrics.sweepRatio).toBeCloseTo(0.1, 2);

    cleanup();
  });

  it("fails Gate 5 when swept out-of-stock ratio exceeds maximum threshold (e.g. 80%)", async () => {
    const prods = [
      ...Array.from({ length: 20 }, (_, i) => createMockProduct({ id: `in-${i}`, inStock: true })),
      ...Array.from({ length: 80 }, (_, i) => createMockProduct({ id: `out-${i}`, inStock: false }))
    ];
    const { dbPath, cleanup } = createTestSqliteDb({ products: prods });

    const result = await validateCatalogSnapshot(dbPath, 100, { maxSweepRatio: 0.75 });
    expect(result.valid).toBe(false);
    expect(result.metrics.sweepRatio).toBeCloseTo(0.8, 2);
    expect(result.errors.some((e) => e.includes("Gate 5") && e.includes("sweep ratio"))).toBe(true);

    cleanup();
  });

  it("calculates exact sweep ratio metric across candidate records", async () => {
    const prods = [
      createMockProduct({ id: "p1", inStock: true }),
      createMockProduct({ id: "p2", inStock: false }),
      createMockProduct({ id: "p3", inStock: false }),
      createMockProduct({ id: "p4", inStock: true })
    ];
    const { dbPath, cleanup } = createTestSqliteDb({ products: prods });

    const result = await validateCatalogSnapshot(dbPath);
    expect(result.metrics.sweepRatio).toBe(0.5);

    cleanup();
  });

  it("passes Gate 5 when 100% of products are in stock (0% out-of-stock)", async () => {
    const prods = Array.from({ length: 50 }, (_, i) => createMockProduct({ id: `in-${i}`, inStock: true }));
    const { dbPath, cleanup } = createTestSqliteDb({ products: prods });

    const result = await validateCatalogSnapshot(dbPath, 50);
    expect(result.valid).toBe(true);
    expect(result.metrics.sweepRatio).toBe(0);

    cleanup();
  });

  it("preserves candidate snapshot without modification during sweep check", async () => {
    const prods = [createMockProduct({ id: "p1", inStock: true })];
    const { dbPath, cleanup, db } = createTestSqliteDb({ products: prods });

    await validateCatalogSnapshot(dbPath);

    const count = (db.prepare("SELECT COUNT(*) as count FROM products").get() as { count: number }).count;
    expect(count).toBe(1);

    cleanup();
  });
});
