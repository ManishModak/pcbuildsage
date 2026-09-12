import { describe, it, expect } from "vitest";
import { validateCatalogSnapshot, createTestSqliteDb, createMockProduct } from "../test-harness";

describe("Tier 1 - Feature 13: Drop Threshold & Anomaly Guard (R3 / Gate 2)", () => {
  it("passes validation when product count is close to baseline (e.g. 5% drop)", async () => {
    const prods = Array.from({ length: 95 }, (_, i) => createMockProduct({ id: `p-${i}` }));
    const { dbPath, cleanup } = createTestSqliteDb({ products: prods });

    const result = await validateCatalogSnapshot(dbPath, 100);
    expect(result.valid).toBe(true);
    expect(result.metrics.totalProducts).toBe(95);

    cleanup();
  });

  it("fails validation when catalog contains 0 products (zero-product failure)", async () => {
    const { dbPath, cleanup } = createTestSqliteDb({ products: [] });

    const result = await validateCatalogSnapshot(dbPath, 100);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Gate 2") && e.includes("0 products"))).toBe(true);

    cleanup();
  });

  it("fails validation when product count drops by more than max threshold (>50%)", async () => {
    const prods = Array.from({ length: 40 }, (_, i) => createMockProduct({ id: `p-${i}` }));
    const { dbPath, cleanup } = createTestSqliteDb({ products: prods });

    const result = await validateCatalogSnapshot(dbPath, 100, { maxDropPercent: 50 });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Gate 2") && e.includes("dropped by 60.0%"))).toBe(true);

    cleanup();
  });

  it("passes validation when catalog count increases (positive growth)", async () => {
    const prods = Array.from({ length: 120 }, (_, i) => createMockProduct({ id: `p-${i}` }));
    const { dbPath, cleanup } = createTestSqliteDb({ products: prods });

    const result = await validateCatalogSnapshot(dbPath, 100);
    expect(result.valid).toBe(true);
    expect(result.metrics.totalProducts).toBe(120);

    cleanup();
  });

  it("reports totalProducts metric accurately in validation result", async () => {
    const prods = Array.from({ length: 77 }, (_, i) => createMockProduct({ id: `p-${i}` }));
    const { dbPath, cleanup } = createTestSqliteDb({ products: prods });

    const result = await validateCatalogSnapshot(dbPath, 80);
    expect(result.metrics.totalProducts).toBe(77);

    cleanup();
  });
});
