import { describe, expect, it } from "vitest";
import { validateBuildInputSchema, createValidateBuildTool } from "../tools/validate-build";
import type { CatalogRepository, SearchProductsInput, SearchProductItem } from "../catalog/repository";
import type { BuildSnapshot } from "../catalog/build-snapshot";
import type { ValidationResult } from "../rules-engine";
import type { ResolvedSpec } from "../registry";

type ValidateBuildOutput = ValidationResult & { snapshot: BuildSnapshot };

describe("validate_build input schema", () => {
  it("rejects empty part objects", () => {
    expect(validateBuildInputSchema.safeParse({ parts: { cpu: {} } }).success).toBe(false);
    expect(validateBuildInputSchema.safeParse({ parts: { cpu: { key: "amd-ryzen-7-9700x" } } }).success).toBe(true);
  });
});

describe("validate_build catalog ID resolution and normalization", () => {
  const mockProducts: SearchProductItem[] = [
    {
      id: "in-cpu-5600x",
      name: "AMD Ryzen 5 5600X",
      category: "cpu",
      price: 13500,
      currency: "INR",
      retailer: "Kryptronix",
      url: "https://example.com/5600x",
      in_stock: true,
      country_code: "IN",
      registry_key: "amd-ryzen-5-5600x"
    },
    {
      id: "in-cpu-unregistered",
      name: "Acme Custom CPU 1000",
      category: "cpu",
      price: 9999,
      currency: "INR",
      retailer: "Kryptronix",
      url: "https://example.com/acme",
      in_stock: true,
      country_code: "IN",
      registry_key: null
    }
  ];

  const mockRepo = {
    getCatalog: async () => ({ categories: [], scope: { country_code: "IN", currency: "INR" } }),
    searchProducts: async (input: SearchProductsInput) => {
      const ids = input.product_ids ?? [];
      const results = mockProducts.filter((p) => ids.includes(p.id));
      return {
        results,
        total_matching: results.length
      };
    }
  } as unknown as CatalogRepository;

  const scope = { countryCode: "IN", currency: "INR" };

  it("normalizes exact catalog ID in string form identically to object form", async () => {
    const tool = createValidateBuildTool(scope, mockRepo);
    type ContextType = Parameters<NonNullable<typeof tool.execute>>[1];
    const mockContext = { toolCallId: "1", messages: [] } as unknown as ContextType;

    const stringResult = (await tool.execute!(
      { parts: { cpu: "in-cpu-5600x" } },
      mockContext
    )) as unknown as ValidateBuildOutput;

    const objectResult = (await tool.execute!(
      { parts: { cpu: { product_id: "in-cpu-5600x" } } },
      mockContext
    )) as unknown as ValidateBuildOutput;

    expect(stringResult.snapshot.components[0].product_id).toBe("in-cpu-5600x");
    expect(stringResult.snapshot.components[0].price).toBe(13500);
    expect(stringResult.snapshot.components[0].name).toBe("AMD Ryzen 5 5600X");

    expect(objectResult.snapshot.components[0].product_id).toBe("in-cpu-5600x");
    expect(objectResult.snapshot.components[0].price).toBe(13500);

    expect(stringResult.snapshot.total).toBe(objectResult.snapshot.total);
    expect(stringResult.snapshot.subtotal).toBe(objectResult.snapshot.subtotal);
  });

  it("resolves padded object product IDs identically to trimmed IDs", async () => {
    const tool = createValidateBuildTool(scope, mockRepo);
    type ContextType = Parameters<NonNullable<typeof tool.execute>>[1];
    const mockContext = { toolCallId: "2", messages: [] } as unknown as ContextType;

    const paddedResult = (await tool.execute!(
      { parts: { cpu: { product_id: "  in-cpu-5600x  " } } },
      mockContext
    )) as unknown as ValidateBuildOutput;

    expect(paddedResult.snapshot.components[0].product_id).toBe("in-cpu-5600x");
    expect(paddedResult.snapshot.components[0].price).toBe(13500);
    expect(paddedResult.snapshot.total).toBe(13500);
    const cpuSpec = paddedResult.resolved.cpu as ResolvedSpec;
    expect(cpuSpec.spec.model).toBe("AMD Ryzen 5 5600X");
  });

  it("preserves known catalog price when registry specs are missing", async () => {
    const tool = createValidateBuildTool(scope, mockRepo);
    type ContextType = Parameters<NonNullable<typeof tool.execute>>[1];
    const mockContext = { toolCallId: "3", messages: [] } as unknown as ContextType;

    const result = (await tool.execute!(
      { parts: { cpu: { product_id: "in-cpu-unregistered" } } },
      mockContext
    )) as unknown as ValidateBuildOutput;

    // Price is preserved in the component and total
    expect(result.snapshot.components[0].product_id).toBe("in-cpu-unregistered");
    expect(result.snapshot.components[0].price).toBe(9999);
    expect(result.snapshot.total).toBe(9999);

    // Compatibility check is unverified (missing specs) rather than blocking error
    const specCheck = result.checks.find((c) => c.rule === "spec_resolution");
    expect(specCheck).toBeDefined();
    expect(specCheck?.status).toBe("unverified");
    expect(specCheck?.message).toContain("No cpu specs found in registry or research cache for 'Acme Custom CPU 1000'");
  });

  it("returns actionable unresolved-ID hint for invalid product ID instead of misdiagnosing as absent specs", async () => {
    const tool = createValidateBuildTool(scope, mockRepo);
    type ContextType = Parameters<NonNullable<typeof tool.execute>>[1];
    const mockContext = { toolCallId: "4", messages: [] } as unknown as ContextType;

    const result = (await tool.execute!(
      { parts: { cpu: { product_id: "in-cpu-nonexistent-999" } } },
      mockContext
    )) as unknown as ValidateBuildOutput;

    const specCheck = result.checks.find((c) => c.rule === "spec_resolution");
    expect(specCheck).toBeDefined();
    expect(specCheck?.status).toBe("unverified");
    expect(specCheck?.message).toContain("Unresolved product ID 'in-cpu-nonexistent-999' for cpu. Verify the product ID from search_products results.");

    // Price is missing/null, complete total is null
    expect(result.snapshot.components[0].price).toBeNull();
    expect(result.snapshot.total).toBeNull();
    expect(result.snapshot.unpriced_count).toBe(1);
  });

  it("preserves legitimate legacy names without catalog match", async () => {
    const tool = createValidateBuildTool(scope, mockRepo);
    type ContextType = Parameters<NonNullable<typeof tool.execute>>[1];
    const mockContext = { toolCallId: "5", messages: [] } as unknown as ContextType;

    const result = (await tool.execute!(
      { parts: { cpu: "amd-ryzen-5-5600x" } },
      mockContext
    )) as unknown as ValidateBuildOutput;

    // Resolved via registry
    expect(result.resolved.cpu).toBeDefined();
    const cpuSpec = result.resolved.cpu as ResolvedSpec;
    expect(cpuSpec.spec.model).toBe("AMD Ryzen 5 5600X");

    // Because it's not a catalog product, price is null
    expect(result.snapshot.components[0].name).toBe("amd-ryzen-5-5600x");
    expect(result.snapshot.components[0].price).toBeNull();
    expect(result.snapshot.total).toBeNull();
  });
});


