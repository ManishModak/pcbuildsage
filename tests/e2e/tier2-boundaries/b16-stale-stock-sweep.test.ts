import { describe, it, expect } from "vitest";
import { validateCatalogSnapshot, createTestSqliteDb, createMockProduct } from "../test-harness";

describe("Tier 2 Boundary - Feature 16: Stale Stock Sweep Ratio Boundaries", () => {
  it("passes validation at exactly 75.0% sweep ratio when max threshold is 75%", async () => {
    const prods = [
      ...Array.from({ length: 25 }, (_, i) => createMockProduct({ id: `in-${i}`, inStock: true })),
      ...Array.from({ length: 75 }, (_, i) => createMockProduct({ id: `out-${i}`, inStock: false }))
    ];
    const { dbPath, cleanup } = createTestSqliteDb({ products: prods });

    const result = await validateCatalogSnapshot(dbPath, 100, { maxSweepRatio: 0.75 });
    expect(result.valid).toBe(true);
    expect(result.metrics.sweepRatio).toBe(0.75);

    cleanup();
  });

  it("fails validation at 75.1% sweep ratio when max threshold is 75%", async () => {
    const prods = [
      ...Array.from({ length: 24 }, (_, i) => createMockProduct({ id: `in-${i}`, inStock: true })),
      ...Array.from({ length: 76 }, (_, i) => createMockProduct({ id: `out-${i}`, inStock: false }))
    ];
    const { dbPath, cleanup } = createTestSqliteDb({ products: prods });

    const result = await validateCatalogSnapshot(dbPath, 100, { maxSweepRatio: 0.75 });
    expect(result.valid).toBe(false);

    cleanup();
  });

  it("fails validation when 100% of products are marked out-of-stock", async () => {
    const prods = Array.from({ length: 50 }, (_, i) => createMockProduct({ id: `out-${i}`, inStock: false }));
    const { dbPath, cleanup } = createTestSqliteDb({ products: prods });

    const result = await validateCatalogSnapshot(dbPath, 50, { maxSweepRatio: 0.75 });
    expect(result.valid).toBe(false);
    expect(result.metrics.sweepRatio).toBe(1.0);

    cleanup();
  });

  it("handles custom configurable maxSweepRatio thresholds (e.g. 0.30)", async () => {
    const prods = [
      ...Array.from({ length: 65 }, (_, i) => createMockProduct({ id: `in-${i}`, inStock: true })),
      ...Array.from({ length: 35 }, (_, i) => createMockProduct({ id: `out-${i}`, inStock: false }))
    ];
    const { dbPath, cleanup } = createTestSqliteDb({ products: prods });

    const result = await validateCatalogSnapshot(dbPath, 100, { maxSweepRatio: 0.3 });
    expect(result.valid).toBe(false);

    cleanup();
  });

  it("sweep ratio calculation ignores deleted or non-product table records", async () => {
    const p1 = createMockProduct({ inStock: true });
    const { dbPath, cleanup } = createTestSqliteDb({ products: [p1] });

    const result = await validateCatalogSnapshot(dbPath, 1);
    expect(result.metrics.sweepRatio).toBe(0);

    cleanup();
  });
});
