import { afterEach, describe, expect, it } from "vitest";
import { GET as getStatus } from "../route";
import type { StatusResponse } from "@/types/client";

describe("GET /api/status", () => {
  const originalEnv = process.env.PCBUILDSAGE_DEPLOYMENT_MODE;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.PCBUILDSAGE_DEPLOYMENT_MODE = originalEnv;
    } else {
      delete process.env.PCBUILDSAGE_DEPLOYMENT_MODE;
    }
  });

  it("returns full diagnostics including dbPath and python in local mode", async () => {
    delete process.env.PCBUILDSAGE_DEPLOYMENT_MODE;
    const response = await getStatus();
    expect(response.status).toBe(200);
    const body = (await response.json()) as StatusResponse;
    expect(body.mode).toBe("local");
    expect(body.database).toBeDefined();
    expect(body.database.path).toBeDefined();
    expect(body.python).toBeDefined();
  });

  it("returns sanitized diagnostics omitting dbPath and python in hosted-demo mode", async () => {
    process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "hosted-demo";
    const response = await getStatus();
    expect(response.status).toBe(200);
    const body = (await response.json()) as StatusResponse;
    expect(body.mode).toBe("hosted-demo");
    expect(body.database).toBeDefined();
    expect(body.database.path).toBeUndefined();
    expect(body.python).toBeUndefined();
    expect(body.database.exists).toBeDefined();
    expect(Array.isArray(body.database.rowCounts)).toBe(true);
  });

  it("retrieves catalog freshness and rowCounts from CatalogRepository in hosted-demo mode", async () => {
    const { setCatalogRepository, resetCatalogRepositoryRegistry } = await import("@/lib/catalog");
    process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "hosted-demo";

    const mockRepo = {
      getCatalog: async () => ({ categories: [], scope: { country_code: "US", currency: "USD" } }),
      searchProducts: async () => ({ results: [], items: [], totalCount: 0 }),
      getCategoryBaseline: async () => ({ total: 0, in_stock_total: 0, min_price: null, max_price: null }),
      getFreshness: async () => ({
        lastScraped: "2026-09-02T18:30:00Z",
        productCount: 120,
        rowCounts: [
          { countryCode: "US", count: 80, lastScraped: "2026-09-02T18:30:00Z" },
          { countryCode: "IN", count: 40, lastScraped: "2026-09-02T16:00:00Z" }
        ]
      })
    };

    try {
      setCatalogRepository(mockRepo);
      const response = await getStatus();
      expect(response.status).toBe(200);
      const body = (await response.json()) as StatusResponse;
      expect(body.mode).toBe("hosted-demo");
      expect(body.catalogFreshness).toBe("2026-09-02T18:30:00Z");
      expect(body.productCount).toBe(120);
      expect(body.database.exists).toBe(true);
      expect(body.database.path).toBeUndefined();
      expect(body.database.lastScraped).toBe("2026-09-02T18:30:00Z");
      expect(body.database.rowCounts).toEqual([
        { countryCode: "US", count: 80, lastScraped: "2026-09-02T18:30:00Z" },
        { countryCode: "IN", count: 40, lastScraped: "2026-09-02T16:00:00Z" }
      ]);
    } finally {
      resetCatalogRepositoryRegistry();
    }
  });
});

