import { tool } from "ai";
import { z } from "zod";
import {
  getCatalogRepository,
  type CatalogRepository,
  type CatalogScope,
  toCompactSearchResult,
  type CompactSearchProductsResult
} from "@/lib/catalog";

export const searchProductsInputSchema = z.object({
  term: z
    .string()
    .optional()
    .describe("Free-text search term or model query matching product title or normalized name (e.g. '4070', 'Ryzen 7800X3D')."),
  query: z
    .string()
    .optional()
    .describe("Alias for term."),
  category: z.string().optional().describe("Component category to search, such as gpu, cpu, motherboard, ram, storage, psu, case, or cooler."),
  price_min: z.number().nonnegative().optional().describe("Minimum product price in standard major units for the active currency, such as Rupees or Dollars."),
  price_max: z.number().nonnegative().optional().describe("Maximum product price in standard major units for the active currency, such as Rupees or Dollars."),
  brands: z.array(z.string()).optional().describe("Allowed component brands, matched case-insensitively against registry brand or product title."),
  retailer: z.string().optional().describe("Retailer name to match exactly or partially."),
  in_stock: z
    .boolean()
    .default(true)
    .describe(
      "Defaults to true: only products currently marked in stock, which is what a build should be assembled from. Pass false only to inspect rows a re-scrape retired, for example when the user asks what happened to a part they were looking at."
    ),
  socket: z.string().optional().describe("Registry-resolved CPU or motherboard socket filter, for example AM5 or LGA 1700."),
  ddr: z.enum(["DDR3", "DDR4", "DDR5"]).optional().describe("Registry-resolved memory generation filter."),
  subcategory: z.enum(["internal", "external", "removable", "accessory"]).optional().describe("Storage build role. Omit for builds - defaults to internal (SSD/HDD/NVMe that go inside a PC). Pass 'removable' (pen drive, memory card) or 'external' (portable drive) ONLY when the user explicitly asks for portable or USB storage."),
  form_factor: z.string().optional().describe("Registry-resolved motherboard or case form factor filter, for example ATX or Mini-ITX."),
  min_vram_gb: z.number().nonnegative().optional().describe("Minimum registry-resolved GPU VRAM in GB."),
  segment: z.enum(["gaming", "workstation", "display"]).optional().describe("Registry-resolved GPU segment filter."),
  max_tdp_w: z.number().nonnegative().optional().describe("Maximum registry-resolved CPU or GPU TDP in watts."),
  max_length_mm: z.number().nonnegative().optional().describe("Maximum registry-resolved GPU length in millimeters."),
  min_capacity_gb: z
    .number()
    .nonnegative()
    .optional()
    .describe(
      "Minimum registry-resolved storage or RAM capacity in GB (e.g. 500 for 500GB/512GB SSDs, 1000 for 1TB, 16 for 16GB RAM kits)."
    ),
  interface: z
    .enum(["nvme", "sata"])
    .optional()
    .describe("Storage interface filter: 'nvme' for fast M.2 NVMe SSDs, 'sata' for standard SATA SSDs/HDDs."),
  min_wattage: z
    .number()
    .nonnegative()
    .optional()
    .describe("Minimum registry-resolved power supply wattage in watts (e.g. 550, 650, 750, 850)."),
  sort_by: z.enum(["price", "name", "retailer", "last_scraped"]).default("price").describe("Sort field. Use price for value searches, last_scraped for freshest listings."),
  order: z.enum(["asc", "desc"]).optional().describe("Sort direction. Defaults to desc for price (best part within the budget first, which is what a build needs) and asc otherwise. Pass asc on price only when the user explicitly wants the cheapest option."),
  limit: z.number().int().positive().max(12).default(8).describe("Maximum result count. Defaults to 8 and cannot exceed 12.")
});

export type SearchProductsInput = z.input<typeof searchProductsInputSchema>;

export type SearchProductsScope = CatalogScope & {
  repository?: CatalogRepository;
};

export const validFilters = Object.keys(searchProductsInputSchema.shape);

export function createSearchProductsTool(
  scope: SearchProductsScope,
  repository?: CatalogRepository
) {
  return tool({
    description:
      "Use search_products to find purchasable PC parts from the local SQLite database. Use it for component candidates and price comparisons; do not use it for compatibility verdicts or web research. Results are in-stock only unless you pass in_stock: false. Filterable fields: term/query, category, subcategory, price_min/price_max in standard major units (e.g. Rupees/Dollars), brands, retailer, in_stock, socket, ddr, form_factor, min_vram_gb, segment, max_tdp_w, max_length_mm, min_capacity_gb, interface, min_wattage, sort_by, order, limit. Example: {\"term\":\"4070\",\"category\":\"gpu\",\"price_max\":60000}.",
    inputSchema: searchProductsInputSchema,
    execute: async (input) => searchProducts(input, scope, repository ?? scope.repository)
  });
}

export async function searchProducts(
  input: SearchProductsInput,
  scope: SearchProductsScope,
  repository?: CatalogRepository
): Promise<CompactSearchProductsResult> {
  const unknown = Object.keys(input).filter((key) => !validFilters.includes(key));
  if (unknown.length) {
    return {
      results: [],
      error: `Unknown filter(s): ${unknown.join(", ")}`,
      valid_filters: validFilters
    };
  }

  // Defensively normalize limit without mutating the incoming input object.
  let normalizedLimit: number | undefined;
  if (input.limit !== undefined) {
    normalizedLimit = Number.isFinite(input.limit)
      ? Math.min(12, Math.max(1, Math.round(Number(input.limit))))
      : 8;
  }

  const rawTerm = (input.term ?? input.query)?.trim();
  const normalizedInput: SearchProductsInput = {
    ...input,
    ...(rawTerm ? { term: rawTerm } : {}),
    ...(normalizedLimit !== undefined ? { limit: normalizedLimit } : {})
  };

  const repo = repository ?? scope.repository ?? getCatalogRepository();
  const rawResult = await repo.searchProducts(normalizedInput, scope);
  return toCompactSearchResult(rawResult);
}

