import { describe, it, expect } from "vitest";
import { MockTursoCatalogRepository, MockTursoClient, createMockProduct } from "../test-harness";

describe("Tier 2 Boundary - Feature 8: Turso Remote Repository Boundaries", () => {
  it("handles remote service 503 / network downtime gracefully", async () => {
    const client = new MockTursoClient();
    client.shouldFail = true;
    client.failureMessage = "503 Service Unavailable: Turso cluster maintenance";

    const repo = new MockTursoCatalogRepository([], client);
    await expect(repo.client.execute("SELECT 1")).rejects.toThrow("503");
  });

  it("handles repository operations after close() by throwing error", async () => {
    const repo = new MockTursoCatalogRepository([]);
    await repo.close();

    await expect(repo.getCatalog()).rejects.toThrow("closed");
    await expect(repo.searchProducts({})).rejects.toThrow("closed");
    await expect(repo.getFreshness()).rejects.toThrow("closed");
    await expect(repo.getMarkets()).rejects.toThrow("closed");
  });

  it("handles empty remote catalog returning 0 items without error", async () => {
    const repo = new MockTursoCatalogRepository([]);
    const catalog = await repo.getCatalog();
    expect(catalog).toEqual([]);

    const freshness = await repo.getFreshness();
    expect(freshness.productCount).toBe(0);
    expect(freshness.lastScraped).toBeNull();
    await repo.close();
  });

  it("handles search queries with multiple matching and non-matching filters", async () => {
    const p1 = createMockProduct({ name: "CPU Intel", price: 200, category: "cpu" });
    const repo = new MockTursoCatalogRepository([p1]);

    const res = await repo.searchProducts({ term: "CPU", category: "gpu" });
    expect(res.totalCount).toBe(0);
    await repo.close();
  });

  it("handles remote batch query transaction rollbacks", async () => {
    const client = new MockTursoClient();
    client.shouldFail = true;

    await expect(client.batch(["INSERT INTO products (id) VALUES ('1')"])).rejects.toThrow();
    expect(client.transactions.some((t) => t.status === "rolled-back")).toBe(true);
  });
});
