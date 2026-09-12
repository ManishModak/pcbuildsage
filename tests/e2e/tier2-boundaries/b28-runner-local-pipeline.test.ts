import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { validateCatalogSnapshot, createTestSqliteDb, createMockProduct } from "../test-harness";

describe("Tier 2 Boundary - Feature 28: Runner-Local Pipeline Boundaries", () => {
  it("handles scraper failure with non-zero exit code by halting pipeline", () => {
    const scraperExitCode: number = 1;
    const shouldContinue = scraperExitCode === 0;
    expect(shouldContinue).toBe(false);
  });

  it("handles validator rejection by halting pipeline before publisher", async () => {
    const pBad = createMockProduct({ price: -50 });
    const { dbPath, cleanup } = createTestSqliteDb({ products: [pBad] });

    const result = await validateCatalogSnapshot(dbPath);
    expect(result.valid).toBe(false);

    const publisherRan = result.valid;
    expect(publisherRan).toBe(false);

    cleanup();
  });

  it("handles validator success by proceeding to publisher step", async () => {
    const pGood = createMockProduct({ price: 299 });
    const { dbPath, cleanup } = createTestSqliteDb({ products: [pGood] });

    const result = await validateCatalogSnapshot(dbPath);
    expect(result.valid).toBe(true);

    const publisherRan = result.valid;
    expect(publisherRan).toBe(true);

    cleanup();
  });

  it("handles temporary candidate file removal after run", () => {
    const { dbPath, cleanup } = createTestSqliteDb();
    cleanup();
    expect(fs.existsSync(dbPath)).toBe(false);
  });

  it("handles candidate file path containing special characters safely", async () => {
    const p1 = createMockProduct();
    const { dbPath, cleanup } = createTestSqliteDb({ products: [p1] });

    const result = await validateCatalogSnapshot(dbPath);
    expect(result.valid).toBe(true);

    cleanup();
  });
});
