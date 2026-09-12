import { describe, it, expect } from "vitest";
import { validateCatalogSnapshot, createTestSqliteDb, createMockProduct } from "../test-harness";

describe("Tier 1 - Feature 12: Snapshot Schema Version Validation (R3 / Gate 1)", () => {
  it("passes Gate 1 when database matches target schema version 5", async () => {
    const p1 = createMockProduct();
    const { dbPath, cleanup } = createTestSqliteDb({ schemaVersion: 5, products: [p1] });

    const result = await validateCatalogSnapshot(dbPath);
    expect(result.metrics.schemaVersion).toBe(5);
    expect(result.valid).toBe(true);

    cleanup();
  });

  it("fails Gate 1 when database schema version is older (< 5)", async () => {
    const p1 = createMockProduct();
    const { dbPath, cleanup } = createTestSqliteDb({ schemaVersion: 4, products: [p1] });

    const result = await validateCatalogSnapshot(dbPath);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Gate 1") && e.includes("version 4"))).toBe(true);

    cleanup();
  });

  it("fails Gate 1 when database schema version is newer (> 5)", async () => {
    const p1 = createMockProduct();
    const { dbPath, cleanup } = createTestSqliteDb({ schemaVersion: 6, products: [p1] });

    const result = await validateCatalogSnapshot(dbPath);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Gate 1") && e.includes("version 6"))).toBe(true);

    cleanup();
  });

  it("fails Gate 1 when required products table is missing", async () => {
    const { dbPath, cleanup } = createTestSqliteDb({ includeTables: ["audit_cache"] });

    const result = await validateCatalogSnapshot(dbPath);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("products' is missing"))).toBe(true);

    cleanup();
  });

  it("records warnings when optional tables audit_cache or registry_research are missing", async () => {
    const p1 = createMockProduct();
    const { dbPath, cleanup } = createTestSqliteDb({ includeTables: ["products"], products: [p1] });

    const result = await validateCatalogSnapshot(dbPath);
    expect(result.warnings.length).toBeGreaterThan(0);

    cleanup();
  });
});
