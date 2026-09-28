import { describe, expect, it } from "vitest";
import { toModelProductItem, toModelSearchResult, type CompactSearchProductsResult } from "@/lib/catalog/compact";
import { createSearchProductsTool, validFilters } from "../search-products";
import { toModelValidateOutput } from "../validate-build";

const full: CompactSearchProductsResult = {
  results: [
    {
      id: "da6670a41d06377759be1c70e28f32230239c099",
      name: "Intel Core i9-14900K",
      category: "cpu",
      subcategory: null,
      price: 55000,
      currency: "INR",
      country_code: "IN",
      retailer: "R",
      url: "https://example.com/x",
      in_stock: true,
      registry_key: "intel-core-i9-14900k",
      specs: { socket: "LGA 1700" }
    }
  ],
  total_matching: 1,
  totalCount: 1,
  returned: 1,
  has_more: false,
  scope: { country_code: "IN", currency: "INR" }
};

describe("model-only trimming via toModelOutput", () => {
  it("search rows drop url/currency/country, short ID, drop category when filtered", () => {
    const model = toModelSearchResult(full, { category: "cpu" }) as unknown as {
      results: Array<Record<string, unknown>>;
    };
    const row = model.results[0];
    expect(row.id).toBe("da6670a41d");
    expect(row).not.toHaveProperty("url");
    expect(row).not.toHaveProperty("currency");
    expect(row).not.toHaveProperty("country_code");
    expect(row).not.toHaveProperty("category");
    expect(row).not.toHaveProperty("in_stock");
    expect(row).not.toHaveProperty("subcategory");
    expect(row.name).toBe("Intel Core i9-14900K");
    // Full output keeps everything for UI/MCP
    expect(full.results[0].url).toContain("https://");
    expect(full.results[0].id).toHaveLength(40);
  });

  it("search keeps category when not filtered, keeps in_stock false", () => {
    const withStock: CompactSearchProductsResult = {
      ...full,
      results: [{ ...full.results[0], in_stock: false, subcategory: "internal" }]
    };
    const model = toModelSearchResult(withStock, {}) as unknown as {
      results: Array<Record<string, unknown>>;
    };
    expect(model.results[0]).toHaveProperty("category", "cpu");
    expect(model.results[0]).toHaveProperty("in_stock", false);
    expect(model.results[0]).toHaveProperty("subcategory", "internal");
  });

  it("toModelProductItem keeps specs and registry_key", () => {
    const row = toModelProductItem(full.results[0], { dropCategory: false });
    expect(row.specs).toEqual({ socket: "LGA 1700" });
    expect(row.registry_key).toBe("intel-core-i9-14900k");
  });

  it("validate model output is only {builds}, no duplicate top-level copies", () => {
    const output = {
      builds: {
        "Within budget": { valid: true, snapshot: { components: [{ product_id: "da6670a41d06377759be1c70e28f32230239c099" }] } }
      },
      "Within budget": { valid: true }
    };
    const model = toModelValidateOutput(output) as Record<string, unknown>;
    expect(Object.keys(model)).toEqual(["builds"]);
    const builds = model.builds as Record<string, { snapshot: { components: Array<{ product_id: string }> } }>;
    expect(builds["Within budget"].snapshot.components[0].product_id).toBe("da6670a41d");
  });

  it("search tool exposes toModelOutput and keeps full execute output", async () => {
    const tool = createSearchProductsTool({ countryCode: "IN", currency: "INR" });
    expect(typeof (tool as unknown as { toModelOutput?: unknown }).toModelOutput).toBe("function");
    expect(validFilters).toContain("term");
  });
});
