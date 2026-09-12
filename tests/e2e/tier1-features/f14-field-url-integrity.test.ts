import { describe, it, expect } from "vitest";
import { validateCatalogSnapshot, createTestSqliteDb, createMockProduct } from "../test-harness";

describe("Tier 1 - Feature 14: Field & URL Integrity Validation (R3 / Gate 3)", () => {
  it("passes Gate 3 when all items have valid names, positive prices, and well-formed URLs", async () => {
    const p1 = createMockProduct({ price: 199.99, url: "https://example.com/p1" });
    const p2 = createMockProduct({ price: 49.5, url: "http://example.com/p2" });
    const { dbPath, cleanup } = createTestSqliteDb({ products: [p1, p2] });

    const result = await validateCatalogSnapshot(dbPath);
    expect(result.valid).toBe(true);
    expect(result.metrics.priceErrors).toBe(0);
    expect(result.metrics.corruptedUrls).toBe(0);

    cleanup();
  });

  it("fails Gate 3 when products have zero or negative prices", async () => {
    const p1 = createMockProduct({ id: "p-zero", price: 0.0 });
    const p2 = createMockProduct({ id: "p-neg", price: -15.0 });
    const { dbPath, cleanup } = createTestSqliteDb({ products: [p1, p2] });

    const result = await validateCatalogSnapshot(dbPath);
    expect(result.valid).toBe(false);
    expect(result.metrics.priceErrors).toBe(2);
    expect(result.errors.some((e) => e.includes("Gate 3") && e.includes("prices"))).toBe(true);

    cleanup();
  });

  it("fails Gate 3 when URLs lack http/https protocol", async () => {
    const p1 = createMockProduct({ url: "ftp://example.com/p1" });
    const p2 = createMockProduct({ url: "javascript:void(0)" });
    const { dbPath, cleanup } = createTestSqliteDb({ products: [p1, p2] });

    const result = await validateCatalogSnapshot(dbPath);
    expect(result.valid).toBe(false);
    expect(result.metrics.corruptedUrls).toBe(2);

    cleanup();
  });

  it("fails Gate 3 when URLs contain invalid whitespace characters", async () => {
    const p1 = createMockProduct({ url: "https://example.com/item with spaces" });
    const { dbPath, cleanup } = createTestSqliteDb({ products: [p1] });

    const result = await validateCatalogSnapshot(dbPath);
    expect(result.valid).toBe(false);
    expect(result.metrics.corruptedUrls).toBe(1);

    cleanup();
  });

  it("fails Gate 3 when mandatory fields (e.g. name or retailer) are empty", async () => {
    const p1 = createMockProduct({ name: "" });
    const { dbPath, cleanup } = createTestSqliteDb({ products: [p1] });

    const result = await validateCatalogSnapshot(dbPath);
    expect(result.valid).toBe(false);

    cleanup();
  });
});
