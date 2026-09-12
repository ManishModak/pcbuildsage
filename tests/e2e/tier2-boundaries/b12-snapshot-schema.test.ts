import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateCatalogSnapshot, createTestSqliteDb, createMockProduct } from "../test-harness";

describe("Tier 2 Boundary - Feature 12: Snapshot Schema Validation Boundaries", () => {
  it("rejects database file that does not exist at specified path", async () => {
    const result = await validateCatalogSnapshot("/non/existent/path/db.sqlite");
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("does not exist"))).toBe(true);
  });

  it("handles schema version 0 (uninitialized database)", async () => {
    const { dbPath, cleanup } = createTestSqliteDb({ schemaVersion: 0, products: [] });

    const result = await validateCatalogSnapshot(dbPath);
    expect(result.valid).toBe(false);
    expect(result.metrics.schemaVersion).toBe(0);

    cleanup();
  });

  it("handles negative schema version numbers", async () => {
    const { dbPath, cleanup } = createTestSqliteDb({ schemaVersion: -1, products: [] });

    const result = await validateCatalogSnapshot(dbPath);
    expect(result.valid).toBe(false);

    cleanup();
  });

  it("handles candidate database with missing indices safely", async () => {
    const p1 = createMockProduct();
    const { dbPath, cleanup } = createTestSqliteDb({ schemaVersion: 5, products: [p1] });

    const result = await validateCatalogSnapshot(dbPath);
    expect(result.valid).toBe(true);

    cleanup();
  });

  it("handles database corrupted header bytes safely without crashing", async () => {
    const corruptPath = path.join(os.tmpdir(), `corrupt-${Date.now()}.db`);
    fs.writeFileSync(corruptPath, "NOT A SQLITE FILE HEADER 1234567890");

    const result = await validateCatalogSnapshot(corruptPath);
    expect(result.valid).toBe(false);
    fs.unlinkSync(corruptPath);
  });
});
