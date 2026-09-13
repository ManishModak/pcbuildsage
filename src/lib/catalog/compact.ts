import { parseRamSpecs } from "../spec-parsers";
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
  sql_candidates?: number;
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
  /** @deprecated Standardized on `hint`. Retained for backward compatibility. */
  note?: string;
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
  const record = item as Record<string, unknown>;
  const isInStock = record.in_stock === 1 || Boolean(record.in_stock || record.inStock);

  const storedSpecs = (record.specs ?? null) as Record<string, unknown> | null;
  const ramSpecs = record.category === "ram" ? parseRamSpecs(String(record.name ?? "")) : undefined;
  const specs = ramSpecs?.modules
    ? { ...storedSpecs, modules: ramSpecs.modules, capacity_gb: ramSpecs.capacity_gb }
    : storedSpecs;

  return {
    id: String(record.id ?? ""),
    name: String(record.name ?? ""),
    category: String(record.category ?? ""),
    subcategory: typeof record.subcategory === "string" ? record.subcategory : null,
    price: typeof record.price === "number" ? record.price : null,
    currency: String(record.currency ?? "INR"),
    country_code: String(record.country_code ?? record.countryCode ?? "IN"),
    retailer: String(record.retailer ?? ""),
    url: String(record.url ?? record.destinationUrl ?? ""),
    in_stock: isInStock,
    registry_key: typeof record.registry_key === "string" ? record.registry_key : null,
    specs: toCompactFunctionalSpecs(specs)
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
  const record = raw as Record<string, unknown>;
  const rawList = Array.isArray(record.results)
    ? record.results
    : Array.isArray(record.items)
      ? record.items
      : [];

  const results = rawList.map((item) => toCompactProductItem(item as SearchProductItem));

  const totalMatching = typeof record.total_matching === "number"
    ? record.total_matching
    : typeof record.totalCount === "number"
      ? record.totalCount
      : undefined;

  const compact: CompactSearchProductsResult = {
    results,
    total_matching: totalMatching,
    totalCount: totalMatching,
    returned: results.length,
    has_more: Boolean(record.has_more ?? (totalMatching !== undefined && totalMatching > results.length))
  };

  if (typeof record.sql_candidates === "number") {
    compact.sql_candidates = record.sql_candidates;
  }

  if (record.scope && typeof record.scope === "object") {
    compact.scope = record.scope as { country_code: string; currency: string };
  }
  if (typeof record.category_total === "number") compact.category_total = record.category_total;
  if (typeof record.in_stock_total === "number") compact.in_stock_total = record.in_stock_total;
  if (record.batch_price_range) compact.batch_price_range = record.batch_price_range as { min: number | null; max: number | null };
  if (record.category_price_range) compact.category_price_range = record.category_price_range as { min: number | null; max: number | null };
  if (record.nearest_above) compact.nearest_above = record.nearest_above as NearestMatch;
  if (record.nearest_below) compact.nearest_below = record.nearest_below as NearestMatch;
  if (typeof record.hint === "string") compact.hint = record.hint;
  if (typeof record.error === "string") compact.error = record.error;
  if (typeof record.note === "string") compact.note = record.note;
  if (Array.isArray(record.valid_filters)) compact.valid_filters = record.valid_filters;

  return compact;
}
