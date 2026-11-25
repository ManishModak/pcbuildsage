import { tool } from "ai";
import { z } from "zod";
import {
  getCatalogRepository,
  type CatalogRepository,
  type CatalogScope,
  toCompactSearchResult,
  toModelSearchResult,
  type CompactProductItem,
  type CompactSearchProductsResult,
  type SearchProductsInput as RepoSearchInput
} from "@/lib/catalog";
import {
  coerceLenientValues,
  formatPrice,
  ignoredFieldsNote,
  leadingJsonValue,
  lenientToolSchema,
  splitUnknownFields
} from "./lenient-input";

export const sortFieldSchema = z.enum(["price", "name", "retailer", "last_scraped"]);

export const MAX_BATCH_QUERIES = 8;
const SINGLE_DEFAULT_LIMIT = 12;
const BATCH_DEFAULT_LIMIT = 6;

function buildSearchFilterShape(compact = false) {
  const d = <T extends z.ZodType>(schema: T, desc: string): T => (compact ? schema : schema.describe(desc));
  return {
    term: d(
      z.string().optional(),
      "Free-text search term or model query matching product title or normalized name (e.g. '4070', 'Ryzen 7800X3D'). Matched as a substring; similarly named variants or bundled listings may also match."
    ),
    query: d(
      z.string().optional(),
      "Alias for term. Matched as a substring against product title or normalized name; similarly named variants may also match."
    ),
    model_id: d(
      z.string().optional(),
      "Unique component model ID or registry key to filter listings by (e.g. from list_models)."
    ),
    category: d(
      z
        .string()
        .trim()
        .toLowerCase()
        .pipe(z.enum(["gpu", "cpu", "motherboard", "ram", "storage", "psu", "case", "cooler"]))
        .optional(),
      "Component category to search, such as gpu, cpu, motherboard, ram, storage, psu, case, or cooler."
    ),
    price_min: d(
      z.number().nonnegative().optional(),
      "Minimum product price in standard major units for the active currency, such as Rupees or Dollars."
    ),
    price_max: d(
      z.number().nonnegative().optional(),
      "Maximum product price in standard major units for the active currency, such as Rupees or Dollars."
    ),
    brands: d(
      z.array(z.string()).optional(),
      "Allowed component brands, matched case-insensitively against registry brand or product title."
    ),
    retailer: d(z.string().optional(), "Retailer name to match exactly or partially."),
    in_stock: d(
      z.boolean().default(true),
      "Defaults to true: only products currently marked in stock, which is what a build should be assembled from. Pass false only to inspect rows a re-scrape retired, for example when the user asks what happened to a part they were looking at."
    ),
    socket: d(
      z.string().optional(),
      "Registry-resolved CPU, motherboard, or cooler socket filter, for example AM5 or LGA 1700."
    ),
    ddr: d(
      z
        .string()
        .trim()
        .toUpperCase()
        .pipe(z.enum(["DDR3", "DDR4", "DDR5"]))
        .optional(),
      "Registry-resolved memory generation filter (case-insensitive, e.g. ddr5)."
    ),
    subcategory: d(
      z.enum(["internal", "external", "removable", "accessory"]).optional(),
      "Storage build role. Omit for builds - defaults to internal (SSD/HDD/NVMe that go inside a PC). Pass 'removable' (pen drive, memory card) or 'external' (portable drive) ONLY when the user explicitly asks for portable or USB storage."
    ),
    form_factor: d(
      z.string().optional(),
      "Registry-resolved motherboard or case form factor filter, for example ATX or Mini-ITX."
    ),
    min_vram_gb: d(z.number().nonnegative().optional(), "Minimum registry-resolved GPU VRAM in GB."),
    segment: d(z.enum(["gaming", "workstation", "display"]).optional(), "Registry-resolved GPU segment filter."),
    max_tdp_w: d(z.number().nonnegative().optional(), "Maximum registry-resolved CPU or GPU TDP in watts."),
    max_length_mm: d(
      z.number().nonnegative().optional(),
      "Maximum registry-resolved GPU length in millimeters (valid only for 'gpu' category)."
    ),
    min_gpu_clearance_mm: d(
      z.number().nonnegative().optional(),
      "Minimum GPU clearance in millimeters (valid only for 'case' category)."
    ),
    min_cooler_clearance_mm: d(
      z.number().nonnegative().optional(),
      "Minimum CPU cooler height clearance in millimeters (valid only for 'case' category)."
    ),
    min_capacity_gb: d(
      z.number().nonnegative().optional(),
      "Minimum registry-resolved storage or RAM capacity in GB (e.g. 500 for 500GB/512GB SSDs, 1000 for 1TB, 16 for 16GB RAM kits)."
    ),
    interface: d(
      z.enum(["nvme", "sata"]).optional(),
      "Storage interface filter: 'nvme' for fast M.2 NVMe SSDs, 'sata' for standard SATA SSDs/HDDs."
    ),
    min_wattage: d(
      z.number().nonnegative().optional(),
      "Minimum registry-resolved power supply wattage in watts (e.g. 550, 650, 750, 850)."
    ),
    modules: d(
      z.coerce.number().int().positive().optional(),
      "RAM stick count filter, e.g. 2 for dual-channel kits. Resolved from registry modules or title patterns like '2x8GB'."
    ),
    sort_by: d(sortFieldSchema.optional(), "Sort field. Use price for value comparisons, last_scraped for freshest listings."),
    order: d(
      z.union([z.enum(["asc", "desc"]), sortFieldSchema]).optional(),
      "Sort direction. Omit it for a price search to get results spread across the whole matching price range, cheapest to priciest: the usual choice. 'asc' shows only the cheapest matches, 'desc' only the priciest. A sort field passed here (e.g. 'price') is treated as sort_by when sort_by isn't set. Price order describes price only, not performance ranking."
    ),
    limit: compact
      ? z.number().int().positive().default(BATCH_DEFAULT_LIMIT).describe("Max results (default 6, max 12).")
      : z
          .number()
          .int()
          .positive()
          .default(SINGLE_DEFAULT_LIMIT)
          .describe("Maximum result count. Defaults to 12 (showing up to 12 results—the maximum per search).")
  };
}

const singleSearchShape = buildSearchFilterShape(false);
// Allow unknown fields inside sub-queries during schema validation so searchProducts can drop & report them per sub-query.
export const batchSubQuerySchema = z.object(buildSearchFilterShape(true)).passthrough();

export const searchProductsInputSchema = z
  .object({
    ...singleSearchShape,
    queries: z
      .array(batchSubQuerySchema)
      .optional()
      .describe(
        "Optional batch of 1-8 independent sub-queries to run in parallel (each accepts the same filter fields, default limit 6). Do not combine with top-level filters."
      )
  })
  .strict();

export type SingleSearchProductsInput = z.input<z.ZodObject<typeof singleSearchShape>>;
export type BatchSubQueryInput = z.input<typeof batchSubQuerySchema>;
export type SearchProductsInput = z.input<typeof searchProductsInputSchema>;
export type BatchSearchProductsInput = { queries: BatchSubQueryInput[] } & Record<string, unknown>;

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

export type BatchSearchEntry = SearchProductsToolResult & {
  label: string;
  category?: string;
};

export interface BatchSearchProductsToolResult {
  batch: true;
  searches: BatchSearchEntry[];
  results?: CompactProductItem[];
  scope?: {
    country_code: string;
    currency: string;
  };
  note?: string;
  hint?: string;
  ignored_fields?: string[];
  error?: string;
}

export type SearchProductsOutput = SearchProductsToolResult | BatchSearchProductsToolResult;

export type SearchProductsScope = CatalogScope & {
  repository?: CatalogRepository;
};

export const validFilters = Object.keys(singleSearchShape);
const validTopLevelKeys = Object.keys(searchProductsInputSchema.shape);
const nonDefaultFilterKeys = validFilters.filter((key) => key !== "in_stock" && key !== "limit");

/** Coerce stringified `queries` arrays and sub-query scalar fields before Zod validation. */
function prepareBatchInput(raw: Record<string, unknown>): Record<string, unknown> {
  if (raw.queries === undefined) return raw;
  let queries: unknown = raw.queries;
  if (typeof queries === "string") {
    const rawStr = queries;
    try {
      queries = JSON.parse(rawStr) as unknown;
    } catch {
      queries = leadingJsonValue(rawStr) ?? rawStr;
    }
  }
  if (!Array.isArray(queries)) return { ...raw, queries };
  return {
    ...raw,
    queries: queries.map((item) =>
      item && typeof item === "object" && !Array.isArray(item)
        ? coerceLenientValues(batchSubQuerySchema, item as Record<string, unknown>)
        : item
    )
  };
}

/** Keep `additionalProperties: false` on `queries.items` in the JSON schema sent to providers. */
function setStrictBatchItemSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const props = schema.properties as Record<string, Record<string, unknown>> | undefined;
  const queriesProp = props?.queries;
  const items = queriesProp?.items as Record<string, unknown> | undefined;
  if (!items || typeof items !== "object") return schema;
  return {
    ...schema,
    properties: {
      ...props,
      queries: {
        ...queriesProp,
        items: { ...items, additionalProperties: false }
      }
    }
  };
}

/** Trim a single search result to the model-facing view with 10-char ID prefixes. */
function toModelSingleOutput(output: SearchProductsToolResult, category?: string): Record<string, unknown> {
  const value = toModelSearchResult(output as CompactSearchProductsResult, category ? { category } : undefined);
  const nearest = output.nearest_match;
  // Same 10-char ID prefix the result rows use.
  if (nearest) value.nearest_match = { ...nearest, id: nearest.id.slice(0, 10) };
  return value;
}

/** Trim a batch search result to a compact model-facing view with 10-char ID prefixes. */
export function toModelBatchSearchResult(output: BatchSearchProductsToolResult): Record<string, unknown> {
  const searches = output.searches.map((entry) => {
    const trimmed = toModelSingleOutput(entry, entry.category);
    return {
      label: entry.label,
      ...(entry.category ? { category: entry.category } : {}),
      ...trimmed
    };
  });
  const out: Record<string, unknown> = {
    batch: true,
    searches
  };
  if (output.scope) out.scope = output.scope;
  if (output.note) out.note = output.note;
  if (output.hint) out.hint = output.hint;
  if (output.ignored_fields) out.ignored_fields = output.ignored_fields;
  if (output.error) out.error = output.error;
  return out;
}

export function createSearchProductsTool(
  scope: SearchProductsScope,
  repository?: CatalogRepository
) {
  return tool({
    description:
      "Use search_products to find purchasable PC parts from the local catalog. Use it for component candidates and price comparisons; do not use it for compatibility verdicts or web research. Results are in-stock only unless you pass in_stock: false. Pass `queries: [...]` (up to 8) to search multiple categories in one call, or top-level filters for a single search. Example: {\"category\":\"case\",\"min_gpu_clearance_mm\":320}.",
    inputSchema: lenientToolSchema(searchProductsInputSchema, "search_products", undefined, prepareBatchInput, setStrictBatchItemSchema),
    toModelOutput: async ({ input, output }) => {
      if (output && typeof output === "object" && (output as { batch?: unknown }).batch === true && Array.isArray((output as { searches?: unknown }).searches)) {
        return { type: "json", value: toModelBatchSearchResult(output as BatchSearchProductsToolResult) } as never;
      }
      return { type: "json", value: toModelSingleOutput(output as SearchProductsToolResult, (input as { category?: string } | undefined)?.category) } as never;
    },
    execute: async (input) => searchProducts(input, scope, repository ?? scope.repository)
  });
}

function oneLineValidFilters(): string {
  return `Valid filters: ${validFilters.join(", ")}.`;
}

/** Human-readable label for one sub-query in a batch search result. */
function batchEntryLabel(input: BatchSubQueryInput, index: number): string {
  const category = typeof input.category === "string" ? input.category.trim().toLowerCase() : "";
  const term = (input.term ?? input.query)?.trim() ?? "";
  const modelId = typeof input.model_id === "string" ? input.model_id.trim() : "";
  if (category && term) return `${category}: ${term}`;
  if (category) return category;
  if (term) return term;
  if (modelId) return modelId;
  return `search_${index + 1}`;
}

/**
 * search_products entry point for the chat tool and direct callers. Unknown
 * fields are dropped and reported (ignored_fields + a hint line) rather than
 * failing the call.
 */
export async function searchProducts(
  rawInput: SearchProductsInput & { queries?: never },
  scope: SearchProductsScope,
  repository?: CatalogRepository
): Promise<SearchProductsToolResult>;
export async function searchProducts(
  rawInput: BatchSearchProductsInput,
  scope: SearchProductsScope,
  repository?: CatalogRepository
): Promise<BatchSearchProductsToolResult>;
export async function searchProducts(
  rawInput: SearchProductsInput,
  scope: SearchProductsScope,
  repository?: CatalogRepository
): Promise<SearchProductsToolResult>;
export async function searchProducts(
  rawInput: SearchProductsInput,
  scope: SearchProductsScope,
  repository?: CatalogRepository
): Promise<SearchProductsOutput> {
  const { known: input, ignored } = splitUnknownFields(rawInput, validTopLevelKeys);
  if (input.queries !== undefined) {
    const result = await runBatchSearch(input, scope, repository);
    if (ignored.length > 0) {
      const note = ignoredFieldsNote(ignored, validFilters);
      result.ignored_fields = ignored;
      result.hint = result.hint ? `${note} ${result.hint}` : note;
    }
    return result;
  }

  const result: SearchProductsToolResult = await runSearch(input, scope, repository);
  if (ignored.length > 0) {
    const note = ignoredFieldsNote(ignored, validFilters);
    result.ignored_fields = ignored;
    result.hint = result.hint ? `${note} ${result.hint}` : note;
  }
  return result;
}

async function runBatchSearch(
  input: SearchProductsInput,
  scope: SearchProductsScope,
  repository?: CatalogRepository
): Promise<BatchSearchProductsToolResult> {
  const rawRecord = input as Record<string, unknown>;
  const mixed = nonDefaultFilterKeys.filter((key) => rawRecord[key] !== undefined);
  if (rawRecord.in_stock === false) mixed.push("in_stock");
  if (mixed.length > 0) {
    return {
      batch: true,
      searches: [],
      results: [],
      error: `Cannot combine 'queries' with top-level filter field(s): ${mixed.join(", ")}. Put each search's filters inside its object in 'queries'.`
    };
  }

  if (!Array.isArray(input.queries) || input.queries.length === 0) {
    return {
      batch: true,
      searches: [],
      results: [],
      error: `queries must contain 1 to ${MAX_BATCH_QUERIES} sub-queries.`
    };
  }

  const wasOverBatchLimit = input.queries.length > MAX_BATCH_QUERIES;
  const capped = input.queries.slice(0, MAX_BATCH_QUERIES);

  const searches = await Promise.all(
    capped.map(async (rawSub, index): Promise<BatchSearchEntry> => {
      if (!rawSub || typeof rawSub !== "object" || Array.isArray(rawSub)) {
        return {
          label: `search_${index + 1}`,
          results: [],
          error: `Sub-query at index ${index} must be an object. ${oneLineValidFilters()}`,
          valid_filters: validFilters
        };
      }
      const { known: sub, ignored: subIgnored } = splitUnknownFields(rawSub, validFilters);
      const subResult = await runSearch(sub, scope, repository, BATCH_DEFAULT_LIMIT);
      if (subIgnored.length > 0) {
        const note = ignoredFieldsNote(subIgnored, validFilters);
        subResult.ignored_fields = subIgnored;
        subResult.hint = subResult.hint ? `${note} ${subResult.hint}` : note;
      }
      const category = typeof sub.category === "string" ? sub.category.trim().toLowerCase() : undefined;
      return {
        label: batchEntryLabel(sub, index),
        ...(category ? { category } : {}),
        ...subResult
      };
    })
  );

  const out: BatchSearchProductsToolResult = {
    batch: true,
    searches,
    scope: { country_code: scope.countryCode, currency: scope.currency }
  };

  if (wasOverBatchLimit) {
    const batchGuidance = `Ran the first ${MAX_BATCH_QUERIES} sub-queries—the maximum per batch.`;
    out.note = batchGuidance;
    out.hint = batchGuidance;
  }

  return out;
}

async function runSearch(
  input: SingleSearchProductsInput,
  scope: SearchProductsScope,
  repository?: CatalogRepository,
  defaultLimit?: number
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

  const requestedLimit = input.limit ?? defaultLimit;
  const wasOverLimit = typeof requestedLimit === "number" && requestedLimit > 12;

  // Defensively normalize limit without mutating the incoming input object.
  let normalizedLimit: number | undefined;
  if (requestedLimit !== undefined) {
    normalizedLimit = Number.isFinite(requestedLimit)
      ? Math.min(12, Math.max(1, Math.round(Number(requestedLimit))))
      : 12;
  }

  // A sort field passed as `order` (e.g. order: "price") is treated as
  // `sort_by` when `sort_by` isn't set, with no direction.
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
  // A price search with no direction shows a spread across the matching price
  // range: small models pick from the top rows, so cheapest-first gave junk
  // parts and priciest-first gave flagships (Ornith r37 aaa: a ₹48,599 GPU for
  // an ₹80,000 build, from the 12 priciest of 110 under a ₹50,000 cap).
  const normalizedInput = {
    ...input,
    ...(category !== undefined ? { category } : {}),
    ...(rawTerm ? { term: rawTerm } : {}),
    ...(normalizedLimit !== undefined ? { limit: normalizedLimit } : {}),
    sort_by: sortBy,
    order,
    modules,
    ...(order === undefined && sortBy === "price" ? { price_spread: true } : {})
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
      { ...input, price_min: undefined, price_max: undefined, in_stock: true, sort_by: "price", order: "asc", price_spread: false, limit: 50 },
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
