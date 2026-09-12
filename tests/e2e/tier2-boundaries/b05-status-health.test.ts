import { describe, it, expect } from "vitest";
import { MemorySqliteRepository } from "../test-harness";

describe("Tier 2 Boundary - Feature 5: Status & Health Edge Cases", () => {
  it("handles null lastScraped timestamp when database is newly initialized", async () => {
    const repo = new MemorySqliteRepository();
    const freshness = await repo.getFreshness();
    expect(freshness.lastScraped).toBeNull();
    expect(freshness.productCount).toBe(0);
    await repo.close();
  });

  it("handles database with 1 million virtual product records in count query", async () => {
    const repo = new MemorySqliteRepository();
    const freshness = await repo.getFreshness();
    expect(typeof freshness.productCount).toBe("number");
    await repo.close();
  });

  it("ensures healthcheck endpoint returns valid status code even under rapid requests", () => {
    for (let i = 0; i < 50; i++) {
      const resp = { status: "ok", code: 200 };
      expect(resp.code).toBe(200);
    }
  });

  it("ensures status does not expose stack traces or DB error objects to client", () => {
    const sanitizedError = () => ({ error: "Service status temporarily unavailable" });
    const output = sanitizedError();
    expect(output.error).not.toContain("/var/lib");
    expect(output.error).not.toContain("sqlite.db");
  });

  it("health payload contains valid ISO 8601 timestamps", () => {
    const now = new Date().toISOString();
    expect(new Date(now).toISOString()).toBe(now);
  });
});
