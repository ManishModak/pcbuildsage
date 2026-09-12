import { describe, it, expect } from "vitest";
import { validateCatalogSnapshot, createTestSqliteDb, createMockProduct } from "../test-harness";

describe("Tier 2 Boundary - Feature 13: Drop Threshold Boundary Conditions", () => {
  it("passes validation at exactly 50% drop when maxDropPercent is 50%", async () => {
    const prods = Array.from({ length: 50 }, (_, i) => createMockProduct({ id: `p-${i}` }));
    const { dbPath, cleanup } = createTestSqliteDb({ products: prods });

    const result = await validateCatalogSnapshot(dbPath, 100, { maxDropPercent: 50 });
    expect(result.valid).toBe(true);

    cleanup();
  });

  it("fails validation at 50.1% drop when maxDropPercent is 50%", async () => {
    const prods = Array.from({ length: 49 }, (_, i) => createMockProduct({ id: `p-${i}` }));
    const { dbPath, cleanup } = createTestSqliteDb({ products: prods });

    const result = await validateCatalogSnapshot(dbPath, 100, { maxDropPercent: 50 });
    expect(result.valid).toBe(false);

    cleanup();
  });

  it("passes validation when baseline is 0 (initial catalog creation)", async () => {
    const prods = [createMockProduct({ id: "first-prod" })];
    const { dbPath, cleanup } = createTestSqliteDb({ products: prods });

    const result = await validateCatalogSnapshot(dbPath, 0);
    expect(result.valid).toBe(true);

    cleanup();
  });

  it("handles massive 10x catalog growth (e.g. 100 to 1000 items)", async () => {
    const prods = Array.from({ length: 1000 }, (_, i) => createMockProduct({ id: `p-${i}` }));
    const { dbPath, cleanup } = createTestSqliteDb({ products: prods });

    const result = await validateCatalogSnapshot(dbPath, 100);
    expect(result.valid).toBe(true);
    expect(result.metrics.totalProducts).toBe(1000);

    cleanup();
  });

  it("fails validation if baseline is 10,000 and candidate has only 1 product", async () => {
    const prods = [createMockProduct({ id: "p1" })];
    const { dbPath, cleanup } = createTestSqliteDb({ products: prods });

    const result = await validateCatalogSnapshot(dbPath, 10000);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("dropped by"))).toBe(true);

    cleanup();
  });
});
