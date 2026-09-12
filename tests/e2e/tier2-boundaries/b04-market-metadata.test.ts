import { describe, it, expect } from "vitest";
import { STANDARD_MARKETS } from "../test-harness";

describe("Tier 2 Boundary - Feature 4: Market Metadata Boundaries", () => {
  it("verifies uniqueness of market codes across metadata registry", () => {
    const codes = STANDARD_MARKETS.map((m) => m.code);
    const unique = new Set(codes);
    expect(unique.size).toBe(codes.length);
  });

  it("verifies all default currencies are present in supportedCurrencies list", () => {
    for (const m of STANDARD_MARKETS) {
      expect(m.supportedCurrencies).toContain(m.defaultCurrency);
    }
  });

  it("handles queries for unsupported market codes by returning undefined/empty", () => {
    const matched = STANDARD_MARKETS.find((m) => m.code === "ZZ");
    expect(matched).toBeUndefined();
  });

  it("ensures locale formatting contains no control characters or injection tokens", () => {
    for (const m of STANDARD_MARKETS) {
      expect(m.locale).toMatch(/^[a-zA-Z0-9\-_]+$/);
    }
  });

  it("payload size remains lean and bounded (< 10 KB)", () => {
    const size = Buffer.byteLength(JSON.stringify(STANDARD_MARKETS), "utf8");
    expect(size).toBeLessThan(10240);
  });
});
