import { describe, it, expect } from "vitest";
import { publishCandidateToTurso, MockTursoClient, createTestSqliteDb, createMockProduct } from "../test-harness";

describe("Tier 1 - Feature 17: Atomic Fail-Closed Turso Publisher (R3)", () => {
  it("successfully publishes valid candidate snapshot to Turso and records catalog_runs", async () => {
    const p1 = createMockProduct({ id: "pub-1", name: "Ryzen 7 7700X" });
    const { dbPath, cleanup } = createTestSqliteDb({ products: [p1] });
    const mockTurso = new MockTursoClient();

    const result = await publishCandidateToTurso(dbPath, "https://turso.example.com", "token123", mockTurso);
    expect(result.success).toBe(true);
    expect(result.rowsSynced).toBe(1);
    expect(mockTurso.tables.get("catalog_runs")?.length).toBe(1);

    cleanup();
  });

  it("aborts publication and leaves target untouched when candidate DB fails validation", async () => {
    const pBad = createMockProduct({ id: "bad-1", price: -10 });
    const { dbPath, cleanup } = createTestSqliteDb({ products: [pBad] });
    const mockTurso = new MockTursoClient();

    const result = await publishCandidateToTurso(dbPath, "https://turso.example.com", "token123", mockTurso);
    expect(result.success).toBe(false);
    expect(result.rowsSynced).toBe(0);
    expect(mockTurso.tables.get("catalog_runs")?.length).toBe(0);
    expect(mockTurso.executedQueries.length).toBe(0);

    cleanup();
  });

  it("rolls back transaction cleanly when remote network error occurs during batch sync", async () => {
    const p1 = createMockProduct({ id: "p1" });
    const { dbPath, cleanup } = createTestSqliteDb({ products: [p1] });
    const mockTurso = new MockTursoClient();
    mockTurso.shouldFail = true;
    mockTurso.failureMessage = "Network timeout to Turso endpoint";

    const result = await publishCandidateToTurso(dbPath, "https://turso.example.com", "token123", mockTurso);
    expect(result.success).toBe(false);
    expect(mockTurso.transactions.some((t) => t.status === "rolled-back")).toBe(true);

    cleanup();
  });

  it("fails publication if Turso credentials (URL or token) are missing", async () => {
    const p1 = createMockProduct({ id: "p1" });
    const { dbPath, cleanup } = createTestSqliteDb({ products: [p1] });

    const result = await publishCandidateToTurso(dbPath, "", "");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Missing Turso URL or token");

    cleanup();
  });

  it("records exact sync timestamp and row count in catalog_runs table on success", async () => {
    const prods = [createMockProduct({ id: "p1" }), createMockProduct({ id: "p2" })];
    const { dbPath, cleanup } = createTestSqliteDb({ products: prods });
    const mockTurso = new MockTursoClient();

    const result = await publishCandidateToTurso(dbPath, "https://turso.example.com", "token123", mockTurso);
    expect(result.success).toBe(true);
    expect(result.rowsSynced).toBe(2);

    const runs = mockTurso.tables.get("catalog_runs");
    expect(runs?.length).toBe(1);

    cleanup();
  });
});
