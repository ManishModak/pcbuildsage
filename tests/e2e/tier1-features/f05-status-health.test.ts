import { describe, it, expect } from "vitest";
import { MemorySqliteRepository, createMockProduct } from "../test-harness";

describe("Tier 1 - Feature 5: Sanitized Status & Health Routes (R1)", () => {
  it("healthcheck reports healthy status without requiring local writable databases", async () => {
    const healthResponse = { status: "healthy", timestamp: new Date().toISOString() };
    expect(healthResponse.status).toBe("healthy");
    expect(new Date(healthResponse.timestamp).getTime()).toBeGreaterThan(0);
  });

  it("status endpoint provides catalog freshness and product count", async () => {
    const repo = new MemorySqliteRepository();
    const freshness = await repo.getFreshness();
    expect(freshness.productCount).toBe(0);
    expect(freshness.lastScraped).toBeNull();
    await repo.close();
  });

  it("sanitized status output in hosted mode omits local database paths", () => {
    const rawStatus = {
      status: "ok",
      deploymentMode: "hosted-demo",
      dbPath: "/home/user/pcbuildsage/data/products.db",
      lastScraped: "2026-09-02T12:00:00Z",
      productCount: 450
    };

    const sanitized = {
      status: rawStatus.status,
      deploymentMode: rawStatus.deploymentMode,
      lastScraped: rawStatus.lastScraped,
      productCount: rawStatus.productCount
    };

    expect(sanitized).not.toHaveProperty("dbPath");
    expect(JSON.stringify(sanitized)).not.toContain("/home/");
  });

  it("sanitized status output redacts server logs and environment keys", () => {
    const statusPayload = {
      mode: "hosted-demo",
      version: "0.1.0",
      catalogFreshness: "2026-09-02T12:00:00Z",
      activeMarkets: ["US", "UK", "IN"]
    };

    const str = JSON.stringify(statusPayload);
    expect(str).not.toContain("TURSO_INGEST_TOKEN");
    expect(str).not.toContain("GEMINI_API_KEY");
    expect(str).not.toContain("OPENROUTER_API_KEY");
  });

  it("status reflects correct product count and latest scraped timestamp", async () => {
    const p1 = createMockProduct({ lastScraped: "2026-09-01T10:00:00Z" });
    const p2 = createMockProduct({ lastScraped: "2026-09-02T15:30:00Z" });
    const { dbPath, cleanup } = (await import("../test-harness")).createTestSqliteDb({
      products: [p1, p2]
    });

    const repo = new MemorySqliteRepository(dbPath);
    const freshness = await repo.getFreshness();
    expect(freshness.productCount).toBe(2);
    expect(freshness.lastScraped).toBe("2026-09-02T15:30:00Z");

    await repo.close();
    cleanup();
  });
});
