import type { NearestMatch, SearchProductItem, SearchProductsResult } from "./repository";

/**
 * Functional hardware specification keys whitelisted from registry schemas.
 * Excludes metadata overhead like `aliases`, `sources`, `researched_at`, `$schema`.
 */
export const FUNCTIONAL_SPEC_KEYS = new Set([
  // Identification / Branding
  "brand",
  "model",
  // Processors / Sockets
  "socket",
  "sockets",
  "chipset",
  "cores",
  "threads",
  "boost_clock_ghz",
  "igpu",
  // Power / Thermals
  "tdp_w",
  "tdp_rating_w",
  "wattage",
  "wattage_w",
  "efficiency",
  "recommended_psu_w",
  // Memory / Generation
  "ddr",
  "speed",
  "speed_mhz",
  "capacity",
  "capacity_gb",
  "modules",
  "latency_cl",
  // Storage & Interconnect
  "interface",
  "m2_slots",
  "sata_ports",
  "pcie_gen",
  // Graphics
  "vram_gb",
  "segment",
  "slot_width",
  // Dimensions / Clearances / Form Factors
  "form_factor",
  "form_factors",
  "length_mm",
  "height_mm",
  "max_gpu_length_mm",
  "max_cooler_height_mm"
]);

/**
 * Lean product record for LLM context and client presentation.
 * Strips duplicate arrays (`offers`, `items`), scrape timestamps, and redundant aliases.
 */
export interface CompactProductItem {
  id: string;
  name: string;
  category: string;
  subcategory?: string | null;
  price: number | null;
  currency: string;
  country_code: string;
  retailer: string;
  url: string;
  in_stock: boolean;
  registry_key?: string | null;
  specs?: Record<string, unknown> | null;
}

/**
 * Full contract response for search_products tool output, without the duplicate items array.
 */
export interface CompactSearchProductsResult {
  results: CompactProductItem[];
  total_matching?: number;
  totalCount?: number;
  returned?: number;
  has_more?: boolean;
  scope?: {
    country_code: string;
    currency: string;
  };
  category_total?: number;
  in_stock_total?: number;
  batch_price_range?: { min: number | null; max: number | null };
  category_price_range?: { min: number | null; max: number | null };
  nearest_above?: NearestMatch;
  nearest_below?: NearestMatch;
  hint?: string;
  error?: string;
  valid_filters?: string[];
}

/**
 * Clean functional specifications dictionary.
 * Preserves hardware attributes and original confidence provenance ("high" | "medium" | "low" | "unknown"),
 * while discarding non-functional arrays (aliases, source URLs, research timestamps).
 */
export function toCompactFunctionalSpecs(
  specs: Record<string, unknown> | null | undefined
): Record<string, unknown> | null {
  if (!specs || typeof specs !== "object") return null;

  const cleaned: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(specs)) {
    if (value === undefined || value === null) continue;
    if (FUNCTIONAL_SPEC_KEYS.has(key)) {
      cleaned[key] = value;
    }
  }

  // Preserve existing confidence provenance directly without fabricating verification
  if (typeof specs.confidence === "string") {
    const conf = specs.confidence.toLowerCase();
    if (conf === "high" || conf === "medium" || conf === "low") {
      cleaned.confidence = conf;
    } else {
      cleaned.confidence = "unknown";
    }
  }

  return Object.keys(cleaned).length > 0 ? cleaned : null;
}

/**
 * Convert a product item to its compact wire representation.
 */
export function toCompactProductItem(
  item: SearchProductItem | Record<string, unknown>
): CompactProductItem {
  const isInStock = item.in_stock === 1 || Boolean(item.in_stock || item.inStock);

  return {
    id: String(item.id ?? ""),
    name: String(item.name ?? ""),
    category: String(item.category ?? ""),
    subcategory: typeof item.subcategory === "string" ? item.subcategory : null,
    price: typeof item.price === "number" ? item.price : null,
    currency: String(item.currency ?? "INR"),
    country_code: String(item.country_code ?? item.countryCode ?? "IN"),
    retailer: String(item.retailer ?? ""),
    url: String(item.url ?? item.destinationUrl ?? ""),
    in_stock: isInStock,
    registry_key: typeof item.registry_key === "string" ? item.registry_key : null,
    specs: toCompactFunctionalSpecs((item.specs ?? null) as Record<string, unknown> | null)
  };
}

/**
 * Pure compaction of a search result object (used by both live tools and conversation replay).
 * Drops duplicate `items` array and strips non-functional overhead while preserving
 * all results and complete contract metadata (scope, hints, price ranges, errors).
 */
export function toCompactSearchResult(
  raw: SearchProductsResult | Record<string, unknown>
): CompactSearchProductsResult {
  const rawList = Array.isArray(raw.results)
    ? raw.results
    : Array.isArray(raw.items)
      ? raw.items
      : [];

  const results = rawList.map((item) => toCompactProductItem(item as SearchProductItem));

  const totalMatching = typeof raw.total_matching === "number"
    ? raw.total_matching
    : typeof raw.totalCount === "number"
      ? raw.totalCount
      : results.length;

  const compact: CompactSearchProductsResult = {
    results,
    total_matching: totalMatching,
    totalCount: totalMatching,
    returned: results.length,
    has_more: Boolean(raw.has_more ?? totalMatching > results.length)
  };

  if (raw.scope && typeof raw.scope === "object") {
    compact.scope = raw.scope as { country_code: string; currency: string };
  }
  if (typeof raw.category_total === "number") compact.category_total = raw.category_total;
  if (typeof raw.in_stock_total === "number") compact.in_stock_total = raw.in_stock_total;
  if (raw.batch_price_range) compact.batch_price_range = raw.batch_price_range as { min: number | null; max: number | null };
  if (raw.category_price_range) compact.category_price_range = raw.category_price_range as { min: number | null; max: number | null };
  if (raw.nearest_above) compact.nearest_above = raw.nearest_above as NearestMatch;
  if (raw.nearest_below) compact.nearest_below = raw.nearest_below as NearestMatch;
  if (typeof raw.hint === "string") compact.hint = raw.hint;
  if (typeof raw.error === "string") compact.error = raw.error;
  if (Array.isArray(raw.valid_filters)) compact.valid_filters = raw.valid_filters;

  return compact;
}
