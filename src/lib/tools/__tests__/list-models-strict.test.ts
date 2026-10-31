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

  it("direct listModels drops unknown filters and reports them in one line", async () => {
    const out = await listModels(
      { bogus_filter: 1 } as never,
      { countryCode: "US", currency: "USD" },
      {
        listModels: async () => ({
          models: [],
          total_matching_models: 0,
          returned_models: 0,
          truncated: false,
          scope: { country_code: "US", currency: "USD" }
        })
      } as never
    );
    expect(out.error).toBeUndefined();
    expect(out.ignored_fields).toEqual(["bogus_filter"]);
    expect(out.hint).toContain("Ignored unknown field(s): bogus_filter");
    expect(out.hint).toContain("Valid filters:");
    expect(out.hint).not.toContain("\n");
    expect(validListModelsFilters).toContain("category");
  });
});
