import { describe, it, expect } from "vitest";
import { MemorySqliteRepository } from "../test-harness";

describe("Tier 2 Boundary - Feature 6: CatalogRepository Edge Cases", () => {
  it("handles SQL injection strings in search query terms safely via parameterization", async () => {
    const repo = new MemorySqliteRepository();
    const result = await repo.searchProducts({ term: "'; DROP TABLE products; --" });
    expect(result.items).toEqual([]);
    expect(result.totalCount).toBe(0);
    await repo.close();
  });

  it("handles empty and whitespace-only search query terms", async () => {
    const repo = new MemorySqliteRepository();
    const result = await repo.searchProducts({ term: "   " });
    expect(Array.isArray(result.items)).toBe(true);
    await repo.close();
  });

  it("handles negative price bounds gracefully", async () => {
    const repo = new MemorySqliteRepository();
    const result = await repo.searchProducts({ minPrice: -50, maxPrice: -10 });
    expect(result.items.length).toBe(0);
    await repo.close();
  });

  it("handles very large offset values beyond available catalog items", async () => {
    const repo = new MemorySqliteRepository();
    const result = await repo.searchProducts({ offset: 999999, limit: 10 });
    expect(result.items).toEqual([]);
    await repo.close();
  });

  it("handles multiple calls to close() idempotently", async () => {
    const repo = new MemorySqliteRepository();
    await repo.close();
    await expect(repo.close()).resolves.toBeUndefined();
  });
});
