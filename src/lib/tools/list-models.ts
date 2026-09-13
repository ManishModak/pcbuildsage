import { tool } from "ai";
import { z } from "zod";
import {
  getCatalogRepository,
  type CatalogRepository,
  type CatalogScope,
  type ListModelsResult
} from "@/lib/catalog";

export const listModelsInputSchema = z.object({
  category: z
    .enum(["gpu", "cpu", "motherboard", "ram", "storage", "psu", "case", "cooler"])
    .optional()
    .describe("Component category to list models for (gpu, cpu, motherboard, ram, storage, psu, case, cooler)."),
  price_min: z
    .number()
    .nonnegative()
    .optional()
    .describe("Minimum price in standard major units for the active currency (e.g. Rupees or Dollars)."),
  price_max: z
    .number()
    .nonnegative()
    .optional()
    .describe("Maximum price in standard major units for the active currency (e.g. Rupees or Dollars)."),
  socket: z
    .string()
    .optional()
    .describe("CPU or motherboard socket filter (e.g. AM5, LGA 1700)."),
  ddr: z
    .enum(["DDR3", "DDR4", "DDR5"])
    .optional()
    .describe("Memory generation filter (DDR3, DDR4, DDR5)."),
  min_vram_gb: z
    .number()
    .nonnegative()
    .optional()
    .describe("Minimum GPU VRAM in GB."),
  min_capacity_gb: z
    .number()
    .nonnegative()
    .optional()
    .describe("Minimum storage or RAM capacity in GB."),
  form_factor: z
    .string()
    .optional()
    .describe("Motherboard or case form factor filter (e.g. ATX, Mini-ITX)."),
  in_stock: z
    .boolean()
    .default(true)
    .describe("Only include models with in-stock listings. Defaults to true."),
  limit: z
    .number()
    .int()
    .positive()
    .default(20)
    .describe("Maximum number of models to return. Defaults to 20.")
});

export type ListModelsInput = z.input<typeof listModelsInputSchema>;

export type ListModelsScope = CatalogScope & {
  repository?: CatalogRepository;
};

export const validListModelsFilters = Object.keys(listModelsInputSchema.shape);

export function createListModelsTool(
  scope: ListModelsScope,
  repository?: CatalogRepository
) {
  return tool({
    description:
      "Use list_models to discover and compare unique hardware component models, their key functional specifications, observed price ranges, and listing availability. Aggregates matching listings into unique models while distinguishing important hardware variants (such as VRAM or capacity variants). Useful for broad category exploration before drilling into specific retailer offers with search_products.",
    inputSchema: listModelsInputSchema,
    execute: async (input) => listModels(input, scope, repository ?? scope.repository)
  });
}

export async function listModels(
  input: ListModelsInput,
  scope: ListModelsScope,
  repository?: CatalogRepository
): Promise<ListModelsResult> {
  const unknown = Object.keys(input).filter((key) => !validListModelsFilters.includes(key));
  if (unknown.length) {
    const effectiveScope =
      typeof scope === "string"
        ? { countryCode: scope, currency: "USD" }
        : scope ?? { countryCode: "US", currency: "USD" };
    return {
      models: [],
      total_matching_models: 0,
      returned_models: 0,
      truncated: false,
      scope: {
        country_code: effectiveScope.countryCode ?? "US",
        currency: effectiveScope.currency ?? "USD"
      },
      error: `Unknown filter(s): ${unknown.join(", ")}`
    };
  }

  const repo = repository ?? scope.repository ?? getCatalogRepository();
  return repo.listModels(input, scope);
}
