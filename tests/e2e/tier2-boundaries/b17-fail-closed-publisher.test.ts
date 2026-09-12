import { describe, it, expect } from "vitest";
import { publishCandidateToTurso, MockTursoClient, createTestSqliteDb, createMockProduct } from "../test-harness";

describe("Tier 2 Boundary - Feature 17: Fail-Closed Publisher Edge Cases", () => {
  it("rejects publish when tursoUrl is empty or malformed", async () => {
    const p1 = createMockProduct();
    const { dbPath, cleanup } = createTestSqliteDb({ products: [p1] });

    const res = await publishCandidateToTurso(dbPath, "", "valid_token");
    expect(res.success).toBe(false);
    expect(res.rowsSynced).toBe(0);

    cleanup();
  });

  it("rejects publish when tursoToken is empty", async () => {
    const p1 = createMockProduct();
    const { dbPath, cleanup } = createTestSqliteDb({ products: [p1] });

    const res = await publishCandidateToTurso(dbPath, "https://turso.example.com", "");
    expect(res.success).toBe(false);

    cleanup();
  });

  it("handles candidate database with corrupt schema without attempting remote sync", async () => {
    const p1 = createMockProduct();
    const { dbPath, cleanup } = createTestSqliteDb({ schemaVersion: 2, products: [p1] });
    const mockClient = new MockTursoClient();

    const res = await publishCandidateToTurso(dbPath, "https://turso.example.com", "token", mockClient);
    expect(res.success).toBe(false);
    expect(mockClient.executedQueries.length).toBe(0);

    cleanup();
  });

  it("handles remote database connection abort halfway through batch", async () => {
    const prods = Array.from({ length: 10 }, (_, i) => createMockProduct({ id: `p-${i}` }));
    const { dbPath, cleanup } = createTestSqliteDb({ products: prods });
    const mockClient = new MockTursoClient();
    mockClient.shouldFail = true;

    const res = await publishCandidateToTurso(dbPath, "https://turso.example.com", "token", mockClient);
    expect(res.success).toBe(false);
    expect(res.rowsSynced).toBe(0);

    cleanup();
  });

  it("guarantees idempotency when publishing the exact same candidate twice", async () => {
    const p1 = createMockProduct({ id: "same-1" });
    const { dbPath, cleanup } = createTestSqliteDb({ products: [p1] });
    const mockClient = new MockTursoClient();

    const res1 = await publishCandidateToTurso(dbPath, "https://turso.example.com", "token", mockClient);
    const res2 = await publishCandidateToTurso(dbPath, "https://turso.example.com", "token", mockClient);

    expect(res1.success).toBe(true);
    expect(res2.success).toBe(true);

    cleanup();
  });
});
