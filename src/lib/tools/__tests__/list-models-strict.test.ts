import { describe, expect, it } from "vitest";
import { listModels, listModelsInputSchema, validListModelsFilters } from "../list-models";

describe("list_models consistency", () => {
  it("rejects unknown filters via strict schema", () => {
    const parsed = listModelsInputSchema.safeParse({ category: "cpu", bogus: 1 });
    expect(parsed.success).toBe(false);
  });

  it("trims and lowercases category like search_products", () => {
    const parsed = listModelsInputSchema.safeParse({ category: "  GPU " });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.category).toBe("gpu");
  });

  it("direct listModels rejects unknown filters in one line with valid filters", async () => {
    const out = await listModels(
      { bogus_filter: 1 } as never,
      { countryCode: "US", currency: "USD" },
      {
        getCatalog: async () => ({ categories: [], scope: { country_code: "US", currency: "USD" } }),
        searchProducts: async () => ({ results: [], total_matching: 0 }),
        listModels: async () => {
          throw new Error("should not reach repository");
        },
        getCategoryBaseline: async () => ({ total: 0, in_stock_total: 0, min_price: null, max_price: null })
      } as never
    );
    expect(out.error).toContain("bogus_filter");
    expect(out.error).toContain("Valid filters:");
    expect(out.error).not.toContain("\n");
    expect(validListModelsFilters).toContain("category");
  });
});
