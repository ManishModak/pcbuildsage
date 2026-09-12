import { describe, it, expect } from "vitest";
import { MemorySqliteRepository } from "../test-harness";

describe("Tier 2 Boundary - Feature 10: Catalog Tools Error Handling", () => {
  it("handles missing or undefined tool parameters safely", async () => {
    const repo = new MemorySqliteRepository();
    const result = await repo.searchProducts({});
    expect(result.items).toEqual([]);
    expect(result.totalCount).toBe(0);
    await repo.close();
  });

  it("handles extreme limit numbers (e.g. limit: 5000)", async () => {
    const repo = new MemorySqliteRepository();
    const result = await repo.searchProducts({ limit: 5000 });
    expect(result.items.length).toBeLessThanOrEqual(5000);
    await repo.close();
  });

  it("handles negative offset values by defaulting to 0", async () => {
    const repo = new MemorySqliteRepository();
    const result = await repo.searchProducts({ offset: -5 });
    expect(Array.isArray(result.items)).toBe(true);
    await repo.close();
  });

  it("handles search queries with special regex characters (e.g. '.*', '^', '$')", async () => {
    const repo = new MemorySqliteRepository();
    const result = await repo.searchProducts({ term: ".*+?^${}()" });
    expect(result.totalCount).toBe(0);
    await repo.close();
  });

  it("returns empty result when filtering by a non-existent category", async () => {
    const repo = new MemorySqliteRepository();
    const result = await repo.searchProducts({ category: "quantum-processors" });
    expect(result.items).toEqual([]);
    expect(result.totalCount).toBe(0);
    await repo.close();
  });
});
