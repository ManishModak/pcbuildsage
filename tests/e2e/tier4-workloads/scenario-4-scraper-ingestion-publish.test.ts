import { describe, it, expect } from "vitest";
import {
  validateCatalogSnapshot,
  publishCandidateToTurso,
  MockTursoClient,
  createTestSqliteDb,
  createMockProduct
} from "../test-harness";

describe("Tier 4 - Workload Scenario 4: Scraper Ingestion & Publish Pipeline (F12, F13, F14, F15, F16, F17)", () => {
  it("executes full CI snapshot validation across failure gates and verifies atomic publish", async () => {
    const mockTurso = new MockTursoClient();
    const baselineProductCount = 500;

    // Run 1: Gate 1 Failure (Incompatible schema version 4)
    const run1 = createTestSqliteDb({ schemaVersion: 4, products: [createMockProduct()] });
    const val1 = await validateCatalogSnapshot(run1.dbPath, baselineProductCount);
    expect(val1.valid).toBe(false);
    expect(val1.errors.some((e) => e.includes("Gate 1"))).toBe(true);

    const pub1 = await publishCandidateToTurso(run1.dbPath, "https://turso.io", "tok", mockTurso, { baselineCount: baselineProductCount });
    expect(pub1.success).toBe(false);
    expect(mockTurso.executedQueries.length).toBe(0);
    run1.cleanup();

    // Run 2: Gate 2 Failure (Catastrophic product count drop: 50 products vs 500 baseline -> 90% drop)
    const run2Prods = Array.from({ length: 50 }, (_, i) => createMockProduct({ id: `p-${i}` }));
    const run2 = createTestSqliteDb({ products: run2Prods });
    const val2 = await validateCatalogSnapshot(run2.dbPath, baselineProductCount);
    expect(val2.valid).toBe(false);
    expect(val2.errors.some((e) => e.includes("Gate 2"))).toBe(true);

    const pub2 = await publishCandidateToTurso(run2.dbPath, "https://turso.io", "tok", mockTurso, { baselineCount: baselineProductCount });
    expect(pub2.success).toBe(false);
    expect(mockTurso.executedQueries.length).toBe(0);
    run2.cleanup();

    // Run 3: Gate 3 Failure (Corrupt negative prices and missing URLs)
    const run3Prods = [
      createMockProduct({ id: "p1", price: -99.0 }),
      createMockProduct({ id: "p2", url: "invalid-url" })
    ];
    const run3 = createTestSqliteDb({ products: run3Prods });
    const val3 = await validateCatalogSnapshot(run3.dbPath);
    expect(val3.valid).toBe(false);
    expect(val3.errors.some((e) => e.includes("Gate 3"))).toBe(true);
    run3.cleanup();

    // Run 4: Gate 4 Failure (WAF / Cloudflare bot challenge title detected in scraped data)
    const run4Prods = [createMockProduct({ id: "waf-item", name: "Attention Required! | Cloudflare" })];
    const run4 = createTestSqliteDb({ products: run4Prods });
    const val4 = await validateCatalogSnapshot(run4.dbPath);
    expect(val4.valid).toBe(false);
    expect(val4.errors.some((e) => e.includes("Gate 4"))).toBe(true);
    run4.cleanup();

    // Run 5: Gate 5 Failure (High out-of-stock sweep ratio: 90% items marked out-of-stock)
    const run5Prods = [
      ...Array.from({ length: 10 }, (_, i) => createMockProduct({ id: `in-${i}`, inStock: true })),
      ...Array.from({ length: 90 }, (_, i) => createMockProduct({ id: `out-${i}`, inStock: false }))
    ];
    const run5 = createTestSqliteDb({ products: run5Prods });
    const val5 = await validateCatalogSnapshot(run5.dbPath, 100, { maxSweepRatio: 0.75 });
    expect(val5.valid).toBe(false);
    expect(val5.errors.some((e) => e.includes("Gate 5"))).toBe(true);
    run5.cleanup();

    // Run 6: Successful Ingestion (Pristine catalog matching all 5 gates)
    const pristineProds = Array.from({ length: 480 }, (_, i) =>
      createMockProduct({
        id: `clean-${i}`,
        name: `Hardware Component ${i}`,
        price: 100 + (i % 200),
        url: `https://retailer.example.com/item/${i}`,
        inStock: i % 10 !== 0 // 10% out of stock (safe)
      })
    );
    const run6 = createTestSqliteDb({ products: pristineProds });
    const val6 = await validateCatalogSnapshot(run6.dbPath, baselineProductCount);
    expect(val6.valid).toBe(true);
    expect(val6.errors.length).toBe(0);

    const pub6 = await publishCandidateToTurso(run6.dbPath, "https://turso.io", "tok", mockTurso, { baselineCount: baselineProductCount });
    expect(pub6.success).toBe(true);
    expect(pub6.rowsSynced).toBe(480);
    expect(mockTurso.tables.get("catalog_runs")?.length).toBe(1);

    run6.cleanup();
  });
});
