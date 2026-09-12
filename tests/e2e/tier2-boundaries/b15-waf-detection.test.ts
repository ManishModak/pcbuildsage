import { describe, it, expect } from "vitest";
import { validateCatalogSnapshot, createTestSqliteDb, createMockProduct } from "../test-harness";

describe("Tier 2 Boundary - Feature 15: WAF & Bot Challenge Detection Boundaries", () => {
  it("detects mixed-case and uppercase WAF challenge strings ('CLOUDFLARE', 'Just A Moment')", async () => {
    const p1 = createMockProduct({ name: "CLOUDFLARE - Attention Required" });
    const { dbPath, cleanup } = createTestSqliteDb({ products: [p1] });

    const result = await validateCatalogSnapshot(dbPath);
    expect(result.valid).toBe(false);
    expect(result.metrics.wafDetections).toBe(1);

    cleanup();
  });

  it("detects WAF signatures in product destination URLs", async () => {
    const p1 = createMockProduct({ url: "https://retailer.com/challenge/captcha-required" });
    const { dbPath, cleanup } = createTestSqliteDb({ products: [p1] });

    const result = await validateCatalogSnapshot(dbPath);
    expect(result.valid).toBe(false);
    expect(result.metrics.wafDetections).toBe(1);

    cleanup();
  });

  it("detects DDoS-Guard and Security Check blocking signatures", async () => {
    const p1 = createMockProduct({ name: "DDoS-Guard Protection Check" });
    const { dbPath, cleanup } = createTestSqliteDb({ products: [p1] });

    const result = await validateCatalogSnapshot(dbPath);
    expect(result.valid).toBe(false);
    expect(result.metrics.wafDetections).toBe(1);

    cleanup();
  });

  it("does not false-positive on legitimate hardware mentioning 'guard' (e.g. 'Gigabyte Anti-Sag Bracket Guard')", async () => {
    const p1 = createMockProduct({ name: "Gigabyte Anti-Sag Bracket GPU Guard" });
    const { dbPath, cleanup } = createTestSqliteDb({ products: [p1] });

    const result = await validateCatalogSnapshot(dbPath);
    expect(result.valid).toBe(true);
    expect(result.metrics.wafDetections).toBe(0);

    cleanup();
  });

  it("reports multiple distinct WAF detections across multiple catalog rows", async () => {
    const prods = [
      createMockProduct({ id: "w1", name: "Attention Required! | Cloudflare" }),
      createMockProduct({ id: "w2", name: "Just a moment..." }),
      createMockProduct({ id: "w3", name: "Datadome Bot Detection" })
    ];
    const { dbPath, cleanup } = createTestSqliteDb({ products: [prods[0], prods[1], prods[2]] });

    const result = await validateCatalogSnapshot(dbPath);
    expect(result.metrics.wafDetections).toBe(3);

    cleanup();
  });
});
