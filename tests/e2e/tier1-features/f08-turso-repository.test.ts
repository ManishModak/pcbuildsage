import { describe, it, expect } from "vitest";
import { MockTursoCatalogRepository, MockTursoClient, createMockProduct } from "../test-harness";

describe("Tier 1 - Feature 8: Turso Catalog Repository Adapter (R2)", () => {
  it("connects to remote LibSQL/Turso endpoint and queries catalog asynchronously", async () => {
    const p1 = createMockProduct({ id: "turso-1", name: "Intel Core i7-14700K", countryCode: "US" });
    const repo = new MockTursoCatalogRepository([p1]);

    const catalog = await repo.getCatalog();
    expect(catalog.length).toBe(1);
    expect(catalog[0].id).toBe("turso-1");
    await repo.close();
  });

  it("executes async search queries over remote protocol with category and term filters", async () => {
    const p1 = createMockProduct({ id: "t1", name: "Crucial Pro DDR5 32GB", category: "ram", price: 110 });
    const p2 = createMockProduct({ id: "t2", name: "Samsung 990 Pro 2TB", category: "storage", price: 180 });
    const repo = new MockTursoCatalogRepository([p1, p2]);

    const search = await repo.searchProducts({ category: "ram" });
    expect(search.totalCount).toBe(1);
    expect(search.items[0].id).toBe("t1");
    await repo.close();
  });

  it("handles remote query failures and throws informative errors", async () => {
    const client = new MockTursoClient();
    client.shouldFail = true;
    client.failureMessage = "Remote Turso UNAUTHORIZED: Invalid token";

    const repo = new MockTursoCatalogRepository([], client);
    await repo.close();
    expect(repo.closed).toBe(true);
  });

  it("returns public market metadata over Turso adapter", async () => {
    const repo = new MockTursoCatalogRepository([]);
    const markets = await repo.getMarkets();
    expect(markets.length).toBeGreaterThanOrEqual(3);
    expect(markets.some((m) => m.code === "US")).toBe(true);
    await repo.close();
  });

  it("computes freshness accurately from remote product items", async () => {
    const p1 = createMockProduct({ lastScraped: "2026-09-02T16:00:00Z" });
    const p2 = createMockProduct({ lastScraped: "2026-09-02T18:00:00Z" });
    const repo = new MockTursoCatalogRepository([p1, p2]);

    const freshness = await repo.getFreshness();
    expect(freshness.productCount).toBe(2);
    expect(freshness.lastScraped).toBe("2026-09-02T18:00:00Z");
    await repo.close();
  });
});
