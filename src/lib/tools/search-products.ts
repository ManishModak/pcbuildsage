import { tool } from "ai";
import { z } from "zod";
import {
  getCatalogRepository,
  type CatalogRepository,
  type CatalogScope,
  toCompactSearchResult,
  toModelSearchResult,
  type CompactSearchProductsResult,
  type SearchProductsInput as RepoSearchInput
} from "@/lib/catalog";
import { formatPrice, ignoredFieldsNote, lenientToolSchema, splitUnknownFields } from "./lenient-input";

export const sortFieldSchema = z.enum(["price", "name", "retailer", "last_scraped"]);

export const searchProductsInputSchema = z.object({
  term: z
    .string()
    .optional()
    .describe("Free-text search term or model query matching product title or normalized name (e.g. '4070', 'Ryzen 7800X3D'). Matched as a substring; similarly named variants or bundled listings may also match."),
  query: z
    .string()
    .optional()
    .describe("Alias for term. Matched as a substring against product title or normalized name; similarly named variants may also match."),
  model_id: z
    .string()
    .optional()
    .describe("Unique component model ID or registry key to filter listings by (e.g. from list_models)."),
  category: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.enum(["gpu", "cpu", "motherboard", "ram", "storage", "psu", "case", "cooler"]))
    .optional()
    .describe("Component category to search, such as gpu, cpu, motherboard, ram, storage, psu, case, or cooler."),
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
  socket: z.string().optional().describe("Registry-resolved CPU, motherboard, or cooler socket filter, for example AM5 or LGA 1700."),
  ddr: z
    .string()
    .trim()
    .toUpperCase()
    .pipe(z.enum(["DDR3", "DDR4", "DDR5"]))
    .optional()
    .describe("Registry-resolved memory generation filter (case-insensitive, e.g. ddr5)."),
  subcategory: z.enum(["internal", "external", "removable", "accessory"]).optional().describe("Storage build role. Omit for builds - defaults to internal (SSD/HDD/NVMe that go inside a PC). Pass 'removable' (pen drive, memory card) or 'external' (portable drive) ONLY when the user explicitly asks for portable or USB storage."),
  form_factor: z.string().optional().describe("Registry-resolved motherboard or case form factor filter, for example ATX or Mini-ITX."),
  min_vram_gb: z.number().nonnegative().optional().describe("Minimum registry-resolved GPU VRAM in GB."),
  segment: z.enum(["gaming", "workstation", "display"]).optional().describe("Registry-resolved GPU segment filter."),
  max_tdp_w: z.number().nonnegative().optional().describe("Maximum registry-resolved CPU or GPU TDP in watts."),
  max_length_mm: z.number().nonnegative().optional().describe("Maximum registry-resolved GPU length in millimeters (valid only for 'gpu' category)."),
  min_gpu_clearance_mm: z.number().nonnegative().optional().describe("Minimum GPU clearance in millimeters (valid only for 'case' category)."),
  min_cooler_clearance_mm: z.number().nonnegative().optional().describe("Minimum CPU cooler height clearance in millimeters (valid only for 'case' category)."),
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
  modules: z
    .coerce
    .number()
    .int()
    .positive()
    .optional()
    .describe("RAM stick count filter, e.g. 2 for dual-channel kits. Resolved from registry modules or title patterns like '2x8GB'."),
  sort_by: sortFieldSchema.optional().describe("Sort field. Use price for value comparisons (asc for affordable options, desc for higher-end listings), last_scraped for freshest listings."),
  order: z.union([z.enum(["asc", "desc"]), sortFieldSchema]).optional().describe("Sort direction. 'asc' sorts ascending (e.g. lowest price first to compare affordable options), 'desc' sorts descending (highest price first). A sort field passed here (e.g. 'price') is treated as sort_by when sort_by isn't set. Price order describes price only, not performance ranking."),
  limit: z.number().int().positive().default(12).describe("Maximum result count. Defaults to 12 (showing up to 12 results—the maximum per search).")
}).strict();

export type SearchProductsInput = z.input<typeof searchProductsInputSchema>;

/** Cheapest in-stock listing for the same filters once the price bounds are dropped. */
export interface SearchNearestMatch {
  id: string;
  name: string;
  price: number;
  retailer: string;
}

/**
 * search_products output: the compact catalog result plus tool-level extras.
 * `nearest_match` / `matches_without_price_limit` appear only when a priced
 * query found nothing; `ignored_fields` only when unknown fields were dropped.
 */
export type SearchProductsToolResult = CompactSearchProductsResult & {
  nearest_match?: SearchNearestMatch;
  matches_without_price_limit?: number;
  ignored_fields?: string[];
};

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
      "Use search_products to find purchasable PC parts from the local catalog. Use it for component candidates and price comparisons; do not use it for compatibility verdicts or web research. Results are in-stock only unless you pass in_stock: false. Example: {\"category\":\"case\",\"min_gpu_clearance_mm\":320}.",
    inputSchema: lenientToolSchema(searchProductsInputSchema, "search_products"),
    toModelOutput: async ({ input, output }) => {
      const value = toModelSearchResult(output as CompactSearchProductsResult, input as { category?: string });
      const nearest = (output as SearchProductsToolResult)?.nearest_match;
      // Same 10-char ID prefix the result rows use.
      if (nearest) value.nearest_match = { ...nearest, id: nearest.id.slice(0, 10) };
      return { type: "json", value } as never;
    },
    execute: async (input) => searchProducts(input, scope, repository ?? scope.repository)
  });
}

function oneLineValidFilters(): string {
  return `Valid filters: ${validFilters.join(", ")}.`;
}

/**
 * search_products entry point for the chat tool and direct callers. Unknown
 * fields are dropped and reported (ignored_fields + a hint line) rather than
 * failing the call.
 */
export async function searchProducts(
  rawInput: SearchProductsInput,
  scope: SearchProductsScope,
  repository?: CatalogRepository
): Promise<SearchProductsToolResult> {
  const { known: input, ignored } = splitUnknownFields(rawInput, validFilters);
  const result: SearchProductsToolResult = await runSearch(input, scope, repository);
  if (ignored.length > 0) {
    const note = ignoredFieldsNote(ignored, validFilters);
    result.ignored_fields = ignored;
    result.hint = result.hint ? `${note} ${result.hint}` : note;
  }
  return result;
}

async function runSearch(
  input: SearchProductsInput,
  scope: SearchProductsScope,
  repository?: CatalogRepository
): Promise<SearchProductsToolResult> {
  // [r9] Normalize category at the tool boundary: trim and lowercase before category guards and repository search
  const category = input.category ? (input.category.trim().toLowerCase() as SearchProductsInput["category"]) : undefined;

  // Validate category-restricted filters
  if (input.min_gpu_clearance_mm !== undefined || input.min_cooler_clearance_mm !== undefined) {
    if (category !== "case") {
      const filters = [
        input.min_gpu_clearance_mm !== undefined ? "min_gpu_clearance_mm" : null,
        input.min_cooler_clearance_mm !== undefined ? "min_cooler_clearance_mm" : null
      ].filter(Boolean);
      return {
        results: [],
        error: `${filters.join(" and ")} ${filters.length > 1 ? "are" : "is"} only valid for the 'case' category. ${oneLineValidFilters()}`,
        valid_filters: validFilters
      };
    }
  }

  if (input.max_length_mm !== undefined && category !== "gpu") {
    return {
      results: [],
      error: `max_length_mm is only valid for the 'gpu' category. ${oneLineValidFilters()}`,
      valid_filters: validFilters
    };
  }

  const requestedLimit = input.limit;
  const wasOverLimit = typeof requestedLimit === "number" && requestedLimit > 12;

  // Defensively normalize limit without mutating the incoming input object.
  let normalizedLimit: number | undefined;
  if (requestedLimit !== undefined) {
    normalizedLimit = Number.isFinite(requestedLimit)
      ? Math.min(12, Math.max(1, Math.round(Number(requestedLimit))))
      : 12;
  }

  // A sort field passed as `order` (e.g. order: "price") is treated as
  // `sort_by` when `sort_by` isn't set, using the default direction.
  let sortBy = input.sort_by;
  const rawOrder = input.order;
  if (typeof rawOrder === "string" && rawOrder !== "asc" && rawOrder !== "desc") {
    const field = rawOrder.trim().toLowerCase();
    if ((sortFieldSchema.options as readonly string[]).includes(field) && sortBy === undefined) {
      sortBy = field as NonNullable<typeof sortBy>;
    }
  }
  const order = rawOrder === "asc" || rawOrder === "desc" ? rawOrder : undefined;
  if (sortBy === undefined) sortBy = "price";

  // Coerce `modules` for direct (unparsed) calls; schema-parsed calls arrive numeric.
  let modules: number | undefined;
  if (input.modules !== undefined) {
    const coerced = typeof input.modules === "string" ? Number(input.modules.trim()) : Number(input.modules);
    if (!Number.isInteger(coerced) || coerced <= 0) {
      return {
        results: [],
        error: `Invalid modules filter: expected a positive integer stick count (e.g. 2 for dual-channel kits). ${oneLineValidFilters()}`,
        valid_filters: validFilters
      };
    }
    modules = coerced;
  }

  const rawTerm = (input.term ?? input.query)?.trim();
  const normalizedInput = {
    ...input,
    ...(category !== undefined ? { category } : {}),
    ...(rawTerm ? { term: rawTerm } : {}),
    ...(normalizedLimit !== undefined ? { limit: normalizedLimit } : {}),
    sort_by: sortBy,
    order,
    modules
  };

  const repo = repository ?? scope.repository ?? getCatalogRepository();
  const rawResult = await repo.searchProducts(normalizedInput, scope);
  const compactResult: SearchProductsToolResult = toCompactSearchResult(rawResult);

  if (compactResult.results.length === 0 && !compactResult.error) {
    await addNearestMatch(compactResult, normalizedInput, scope, repo);
  }

  if (wasOverLimit) {
    const limitGuidance = "Showing up to 12 results—the maximum per search.";
    compactResult.hint = compactResult.hint
      ? `${compactResult.hint} ${limitGuidance}`
      : limitGuidance;
    compactResult.note = limitGuidance;
  }

  return compactResult;
}


/**
 * When a priced query finds nothing, re-runs it once without price bounds
 * (other filters kept, in stock only) and reports the cheapest listing and
 * how many exist, so the model can correct its bounds in one step instead
 * of guessing from the whole-category price range.
 */
async function addNearestMatch(
  result: SearchProductsToolResult,
  input: RepoSearchInput,
  scope: SearchProductsScope,
  repo: CatalogRepository
): Promise<void> {
  const { price_min: min, price_max: max } = input;
  if (min === undefined && max === undefined) return;
  if (min !== undefined && max !== undefined && min > max) return;
  if (result.category_total === 0 || result.in_stock_total === 0) return;

  // 50 is the repository cap; the count is exact unless more remain.
  const unbounded = toCompactSearchResult(
    await repo.searchProducts(
      { ...input, price_min: undefined, price_max: undefined, in_stock: true, sort_by: "price", order: "asc", limit: 50 },
      scope
    )
  );
  const cheapest = unbounded.results.find((item) => typeof item.price === "number");
  if (!cheapest || typeof cheapest.price !== "number") return;

  const count = unbounded.total_matching ?? unbounded.results.length;
  const exact = unbounded.total_matching !== undefined || !unbounded.has_more;
  const currency = unbounded.scope?.currency ?? scope.currency ?? "USD";
  const fmt = (n: number) => formatPrice(n, currency);
  const band =
    min !== undefined && max !== undefined
      ? `between ${fmt(min)} and ${fmt(max)}`
      : max !== undefined
        ? `at or under ${fmt(max)}`
        : `at or above ${fmt(min as number)}`;

  result.nearest_match = { id: cheapest.id, name: cheapest.name, price: cheapest.price, retailer: cheapest.retailer };
  result.matches_without_price_limit = count;
  // Leads the repository hint, which keeps the nearest above/below detail.
  const lead =
    `No matches ${band}. Cheapest in-stock match for these filters: ${cheapest.name} at ${fmt(cheapest.price)} from ${cheapest.retailer} ` +
    `(${exact ? "" : "at least "}${count} match${count === 1 ? "" : "es"} without the price limit).`;
  result.hint = result.hint ? `${lead} ${result.hint}` : lead;
}
