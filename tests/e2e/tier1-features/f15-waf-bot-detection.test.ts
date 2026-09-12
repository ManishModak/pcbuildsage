import { describe, it, expect } from "vitest";
import { validateCatalogSnapshot, createTestSqliteDb, createMockProduct } from "../test-harness";

describe("Tier 1 - Feature 15: WAF & Bot Challenge Detection (R3 / Gate 4)", () => {
  it("passes Gate 4 when product records contain clean legitimate hardware descriptions", async () => {
    const p1 = createMockProduct({ name: "Corsair Vengeance DDR5 32GB (2x16GB)" });
    const p2 = createMockProduct({ name: "ASUS ROG Strix B650-A Gaming WiFi" });
    const { dbPath, cleanup } = createTestSqliteDb({ products: [p1, p2] });

    const result = await validateCatalogSnapshot(dbPath);
    expect(result.valid).toBe(true);
    expect(result.metrics.wafDetections).toBe(0);

    cleanup();
  });

  it("fails Gate 4 when product name contains 'Attention Required! | Cloudflare'", async () => {
    const p1 = createMockProduct({ name: "Attention Required! | Cloudflare" });
    const { dbPath, cleanup } = createTestSqliteDb({ products: [p1] });

    const result = await validateCatalogSnapshot(dbPath);
    expect(result.valid).toBe(false);
    expect(result.metrics.wafDetections).toBe(1);
    expect(result.errors.some((e) => e.includes("Gate 4") && e.includes("WAF challenge"))).toBe(true);

    cleanup();
  });

  it("fails Gate 4 when product name contains 'Just a moment...'", async () => {
    const p1 = createMockProduct({ name: "Just a moment... Please wait while we check your browser" });
    const { dbPath, cleanup } = createTestSqliteDb({ products: [p1] });

    const result = await validateCatalogSnapshot(dbPath);
    expect(result.valid).toBe(false);
    expect(result.metrics.wafDetections).toBe(1);

    cleanup();
  });

  it("fails Gate 4 when product record contains Datadome or CAPTCHA signatures", async () => {
    const p1 = createMockProduct({ name: "Security Check - Datadome Block" });
    const { dbPath, cleanup } = createTestSqliteDb({ products: [p1] });

    const result = await validateCatalogSnapshot(dbPath);
    expect(result.valid).toBe(false);
    expect(result.metrics.wafDetections).toBe(1);

    cleanup();
  });

  it("accumulates and reports total number of detected WAF records", async () => {
    const p1 = createMockProduct({ id: "w1", name: "Cloudflare challenge page" });
    const p2 = createMockProduct({ id: "w2", name: "Verify you are human - CAPTCHA" });
    const p3 = createMockProduct({ id: "good", name: "Valid CPU" });
    const { dbPath, cleanup } = createTestSqliteDb({ products: [p1, p2, p3] });

    const result = await validateCatalogSnapshot(dbPath);
    expect(result.metrics.wafDetections).toBe(2);

    cleanup();
  });
});
