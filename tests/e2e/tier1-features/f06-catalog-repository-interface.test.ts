import { describe, it, expect } from "vitest";
import { MemorySqliteRepository } from "../test-harness";

describe("Tier 1 - Feature 6: Async CatalogRepository Interface (R2)", () => {
  it("getCatalog returns a Promise resolving to an array of Products", async () => {
    const repo = new MemorySqliteRepository();
    const resultPromise = repo.getCatalog();
    expect(resultPromise).toBeInstanceOf(Promise);
    const result = await resultPromise;
    expect(Array.isArray(result)).toBe(true);
    await repo.close();
  });

  it("searchProducts returns a Promise resolving to SearchResult structure", async () => {
    const repo = new MemorySqliteRepository();
    const searchPromise = repo.searchProducts({ term: "Ryzen" });
    expect(searchPromise).toBeInstanceOf(Promise);
    const searchResult = await searchPromise;
    expect(searchResult).toHaveProperty("items");
    expect(searchResult).toHaveProperty("totalCount");
    expect(Array.isArray(searchResult.items)).toBe(true);
    await repo.close();
  });

  it("getFreshness returns a Promise resolving to { lastScraped, productCount }", async () => {
    const repo = new MemorySqliteRepository();
    const freshnessPromise = repo.getFreshness();
    expect(freshnessPromise).toBeInstanceOf(Promise);
    const freshness = await freshnessPromise;
    expect(freshness).toHaveProperty("lastScraped");
    expect(freshness).toHaveProperty("productCount");
    expect(typeof freshness.productCount).toBe("number");
    await repo.close();
  });

  it("getMarkets returns a Promise resolving to MarketMetadata array", async () => {
    const repo = new MemorySqliteRepository();
    const marketsPromise = repo.getMarkets();
    expect(marketsPromise).toBeInstanceOf(Promise);
    const markets = await marketsPromise;
    expect(Array.isArray(markets)).toBe(true);
    expect(markets.length).toBeGreaterThan(0);
    await repo.close();
  });

  it("close returns a Promise resolving to void upon teardown", async () => {
    const repo = new MemorySqliteRepository();
    const closePromise = repo.close();
    expect(closePromise).toBeInstanceOf(Promise);
    await expect(closePromise).resolves.toBeUndefined();
  });
});
