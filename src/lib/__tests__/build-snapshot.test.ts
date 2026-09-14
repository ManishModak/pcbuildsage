import { describe, expect, it } from "vitest";
import { createBuildSnapshot } from "../catalog/build-snapshot";
import { formatSnapshotForContext } from "../llm/snapshot-formatter";
import type { ValidationResult } from "../rules-engine";
import type { SearchProductItem } from "../catalog/repository";

const mockValidation: ValidationResult = {
  valid: true,
  issues: [],
  resolved: {},
  skipped_checks: [],
  checks: [],
  summary: { passed: 1, failed: 0, unverified: 0, text: "Build valid" }
};

const mockScope = {
  countryCode: "US",
  currency: "USD"
};

function createProduct(overrides: Partial<SearchProductItem> & { id: string; name: string; price: number | null }): SearchProductItem {
  return {
    category: "other",
    currency: "USD",
    country_code: "US",
    retailer: "Retailer",
    url: "https://example.com",
    in_stock: true,
    ...overrides
  };
}

describe("createBuildSnapshot", () => {
  it("computes exact totals from catalog products with minor unit precision", () => {
    const products = new Map<string, SearchProductItem>([
      [
        "gpu-1",
        createProduct({
          id: "gpu-1",
          name: "GeForce RTX 4070",
          category: "gpu",
          price: 549.99,
          currency: "USD",
          retailer: "BestBuy",
          url: "https://example.com/gpu"
        })
      ],
      [
        "cpu-1",
        createProduct({
          id: "cpu-1",
          name: "Ryzen 5 7600X",
          category: "cpu",
          price: 199.5,
          currency: "USD",
          retailer: "Amazon",
          url: "https://example.com/cpu"
        })
      ]
    ]);

    const snapshot = createBuildSnapshot({
      label: "Gaming PC",
      parts: {
        gpu: { product_id: "gpu-1" },
        cpu: { product_id: "cpu-1" }
      },
      validation: mockValidation,
      productsById: products,
      scope: mockScope
    });

    expect(snapshot.total).toBe(749.49);
    expect(snapshot.subtotal).toBe(749.49);
    expect(snapshot.is_complete).toBe(true);
    expect(snapshot.unpriced_count).toBe(0);
    expect(snapshot.components).toHaveLength(2);
    expect(snapshot.components[0].product_id).toBe("gpu-1");
    expect(snapshot.components[0].price).toBe(549.99);
  });

  it("handles included stock cooler with zero price without blocking completeness", () => {
    const products = new Map<string, SearchProductItem>([
      [
        "cpu-1",
        createProduct({
          id: "cpu-1",
          name: "Ryzen 5 5600",
          category: "cpu",
          price: 134.0,
          currency: "USD",
          retailer: "Amazon"
        })
      ]
    ]);

    const snapshot = createBuildSnapshot({
      label: "Budget Build",
      parts: {
        cpu: { product_id: "cpu-1" },
        cooler: "included"
      },
      validation: {
        ...mockValidation,
        resolved: {
          cooler: {
            category: "cooler",
            key: "stock-wraith-stealth",
            spec: { brand: "AMD", aliases: [], model: "AMD Wraith Stealth", is_stock: true },
            source: "registry",
            confidence: "high"
          }
        }
      },
      productsById: products,
      scope: mockScope
    });

    expect(snapshot.components).toHaveLength(2);
    const coolerComp = snapshot.components.find((c) => c.category === "cooler");
    expect(coolerComp).toBeDefined();
    expect(coolerComp?.price).toBe(0);
    expect(coolerComp?.included).toBe(true);
    expect(snapshot.total).toBe(134.0);
    expect(snapshot.is_complete).toBe(true);
    expect(snapshot.unpriced_count).toBe(0);
  });

  it("returns null total and explicit missing_prices when a part is unpriced or missing from catalog", () => {
    const products = new Map<string, SearchProductItem>([
      [
        "cpu-1",
        createProduct({
          id: "cpu-1",
          name: "Ryzen 7 7800X3D",
          category: "cpu",
          price: 449.0,
          currency: "USD"
        })
      ]
    ]);

    const snapshot = createBuildSnapshot({
      parts: {
        cpu: { product_id: "cpu-1" },
        gpu: { product_id: "nonexistent-gpu", name: "Custom Shipped GPU" }
      },
      validation: mockValidation,
      productsById: products,
      scope: mockScope
    });

    expect(snapshot.total).toBeNull();
    expect(snapshot.subtotal).toBe(449.0);
    expect(snapshot.is_complete).toBe(false);
    expect(snapshot.unpriced_count).toBe(1);
    expect(snapshot.missing_prices).toContain("gpu: Custom Shipped GPU");
  });

  it("returns null total if parts have mixed currencies", () => {
    const products = new Map<string, SearchProductItem>([
      [
        "cpu-1",
        createProduct({
          id: "cpu-1",
          name: "Core i5-13600K",
          category: "cpu",
          price: 270.0,
          currency: "USD"
        })
      ],
      [
        "gpu-1",
        createProduct({
          id: "gpu-1",
          name: "Radeon RX 7800 XT",
          category: "gpu",
          price: 480.0,
          currency: "EUR"
        })
      ]
    ]);

    const snapshot = createBuildSnapshot({
      parts: {
        cpu: { product_id: "cpu-1" },
        gpu: { product_id: "gpu-1" }
      },
      validation: mockValidation,
      productsById: products,
      scope: mockScope
    });

    expect(snapshot.total).toBeNull();
    expect(snapshot.subtotal).toBe(270.0); // Only sums matching primary USD
    expect(snapshot.is_complete).toBe(false);
    expect(snapshot.currencies).toEqual(expect.arrayContaining(["USD", "EUR"]));
  });

  it("supports multiple storage drives in components list", () => {
    const products = new Map<string, SearchProductItem>([
      [
        "ssd-1",
        createProduct({
          id: "ssd-1",
          name: "Samsung 990 Pro 1TB",
          category: "storage",
          price: 119.99,
          currency: "USD"
        })
      ],
      [
        "ssd-2",
        createProduct({
          id: "ssd-2",
          name: "Crucial P3 Plus 2TB",
          category: "storage",
          price: 124.99,
          currency: "USD"
        })
      ]
    ]);

    const snapshot = createBuildSnapshot({
      parts: {
        storage: [{ product_id: "ssd-1" }, { product_id: "ssd-2" }]
      },
      validation: mockValidation,
      productsById: products,
      scope: mockScope
    });

    expect(snapshot.components).toHaveLength(2);
    expect(snapshot.total).toBe(244.98);
    expect(snapshot.is_complete).toBe(true);
  });

  it("updates totals when parts are revised", () => {
    const products = new Map<string, SearchProductItem>([
      [
        "gpu-budget",
        createProduct({
          id: "gpu-budget",
          name: "Radeon RX 6600",
          category: "gpu",
          price: 199.99,
          currency: "USD"
        })
      ],
      [
        "gpu-upgrade",
        createProduct({
          id: "gpu-upgrade",
          name: "Radeon RX 7600 XT",
          category: "gpu",
          price: 319.99,
          currency: "USD"
        })
      ]
    ]);

    const snapshot1 = createBuildSnapshot({
      parts: { gpu: { product_id: "gpu-budget" } },
      validation: mockValidation,
      productsById: products,
      scope: mockScope
    });
    expect(snapshot1.total).toBe(199.99);

    const snapshot2 = createBuildSnapshot({
      parts: { gpu: { product_id: "gpu-upgrade" } },
      validation: mockValidation,
      productsById: products,
      scope: mockScope
    });
    expect(snapshot2.total).toBe(319.99);
  });

  it("rejects completeness and sets total to null if all parts are foreign currency", () => {
    const products = new Map<string, SearchProductItem>([
      [
        "gpu-1",
        createProduct({
          id: "gpu-1",
          name: "Radeon RX 7800 XT",
          category: "gpu",
          price: 480.0,
          currency: "EUR"
        })
      ]
    ]);

    const snapshot = createBuildSnapshot({
      parts: {
        gpu: { product_id: "gpu-1" }
      },
      validation: mockValidation,
      productsById: products,
      scope: mockScope // scope.currency is USD
    });

    expect(snapshot.total).toBeNull();
    expect(snapshot.subtotal).toBe(0);
    expect(snapshot.is_complete).toBe(false);
    expect(snapshot.currencies).toEqual(["EUR"]);
  });

  it("populates validation_summary with passed, unverified, failed and issues", () => {
    const products = new Map<string, SearchProductItem>([
      [
        "cpu-1",
        createProduct({
          id: "cpu-1",
          name: "Ryzen 5 7600",
          category: "cpu",
          price: 190.0,
          currency: "USD"
        })
      ]
    ]);

    const snapshot = createBuildSnapshot({
      parts: { cpu: { product_id: "cpu-1" } },
      validation: {
        valid: false,
        issues: [{ category: "cooler", message: "CPU cooler required", severity: "error" }],
        resolved: {},
        skipped_checks: [],
        checks: [],
        summary: { passed: 2, failed: 1, unverified: 1, text: "Issues found" }
      },
      productsById: products,
      scope: mockScope
    });

    expect(snapshot.validation_summary).toBeDefined();
    expect(snapshot.validation_summary?.passed).toBe(2);
    expect(snapshot.validation_summary?.failed).toBe(1);
    expect(snapshot.validation_summary?.unverified).toBe(1);
    expect(snapshot.validation_summary?.issues).toHaveLength(1);
  });

  it("formats snapshot for model context distinguishing validation statuses", () => {
    const products = new Map<string, SearchProductItem>([
      [
        "cpu-1",
        createProduct({
          id: "cpu-1",
          name: "Ryzen 5 7600",
          category: "cpu",
          price: 190.0,
          currency: "USD"
        })
      ]
    ]);

    const snapshot = createBuildSnapshot({
      label: "Budget Build",
      parts: { cpu: { product_id: "cpu-1" } },
      validation: mockValidation,
      productsById: products,
      scope: mockScope
    });

    const formatted = formatSnapshotForContext(snapshot);
    expect(formatted).toContain("Current Build Snapshot (Code-Calculated, Authoritative):");
    expect(formatted).toContain("Compatibility: PASSED (1 check(s) verified)");
    expect(formatted).toContain("Ryzen 5 7600");
  });
});
