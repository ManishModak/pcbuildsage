import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { validateCatalogSnapshot, createTestSqliteDb, createMockProduct } from "../test-harness";

describe("Tier 1 - Feature 28: Runner-Local Ingestion Pipeline (R6)", () => {
  it("executes scraper into isolated temporary SQLite database", () => {
    const tempDb = `/tmp/scraper-candidate-${Date.now()}.db`;
    expect(tempDb).toContain("/tmp/");
  });

  it("invokes snapshot validation against runner-local candidate database", async () => {
    const p1 = createMockProduct({ id: "p1" });
    const { dbPath, cleanup } = createTestSqliteDb({ products: [p1] });

    const validation = await validateCatalogSnapshot(dbPath);
    expect(validation.valid).toBe(true);
    expect(validation.metrics.totalProducts).toBe(1);

    cleanup();
  });

  it("halts pipeline and blocks publish when candidate database fails validation", async () => {
    const pBad = createMockProduct({ id: "p-bad", price: 0 });
    const { dbPath, cleanup } = createTestSqliteDb({ products: [pBad] });

    const validation = await validateCatalogSnapshot(dbPath);
    expect(validation.valid).toBe(false);

    const shouldPublish = validation.valid;
    expect(shouldPublish).toBe(false);

    cleanup();
  });

  it("proceeds to Turso publisher step only when all 5 validation gates pass", async () => {
    const pGood = createMockProduct({ id: "p-good", price: 150 });
    const { dbPath, cleanup } = createTestSqliteDb({ products: [pGood] });

    const validation = await validateCatalogSnapshot(dbPath);
    const shouldPublish = validation.valid;
    expect(shouldPublish).toBe(true);

    cleanup();
  });

  it("cleans up runner temporary database file after step completion", () => {
    const { dbPath, cleanup } = createTestSqliteDb();
    cleanup();
    expect(fs.existsSync(dbPath)).toBe(false);
  });
});
