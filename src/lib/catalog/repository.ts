/**
 * src/lib/catalog/repository.ts
 *
 * Authoritative interface and contracts for asynchronous catalog access.
 * Decouples catalog querying from specific database drivers (local SQLite vs remote Turso Cloud).
 */

import type { ComponentCategory } from "@/lib/registry";
import type { Product } from "@/types/db";
import type { MarketMetadata } from "@/lib/config/deployment";
import type { ProductOffer } from "./types";

/**
 * Market and database scope for scoping catalog queries.
 * Country code and currency isolate pricing, stock, and retailer eligibility.
 */
export interface CatalogScope {
  /** Target ISO 3166-1 alpha-2 country code (e.g., "US", "IN", "UK", "CA", "DE") */
  countryCode: string;

  /** Target ISO 4217 currency code for pricing (e.g., "USD", "INR", "GBP") */
  currency: string;

  /** Optional override for local SQLite database file path */
  dbPath?: string;

  /** Optional BCP 47 locale tag */
  locale?: string;
}

/**
 * Summary statistics for a single component category in the catalog.
 */
export interface CatalogCategorySummary {
  /** Component category identifier */
  category: ComponentCategory | string;

  /** Total number of build-relevant products in this category */
  count: number;

  /** Total number of build-relevant products currently in stock */
  in_stock_count: number;

  /** Lowest price among build-relevant products (null if count is 0) */
  price_min: number | null;

  /** Highest price among build-relevant products (null if count is 0) */
  price_max: number | null;

  /** Breakdown of non-build accessory subcategories stocked under this category */
  subcategories?: Record<
    string,
    {
      count: number;
      price_min: number | null;
      price_max: number | null;
    }
  >;

  /** Guidance note for LLM agents explaining category status */
  note?: string;
}

/**
 * Result returned by `getCatalog`, detailing categories available in the target market.
 */
export interface GetCatalogResult {
  /** Category breakdowns and counts for all known component categories */
  categories: CatalogCategorySummary[];

  /** The market scope applied to this catalog query */
  scope: {
    country_code: string;
    currency: string;
  };

  /** Optional full product list when retrieved in product-level mode */
  products?: Product[];
}

/**
 * Input parameters and filter criteria for catalog product search.
 * Combines full-text query, pricing bounds, brand selection, and registry spec matching.
 */
export interface SearchProductsInput {
  /** Internal exact-offer lookup for compatibility validation; not an LLM search filter. */
  product_ids?: string[];
  /** Free-text search term or model query matching product title or normalized name */
  term?: string;
  query?: string;

  /** Component model ID or registry key to filter listings by (e.g. from list_models) */
  model_id?: string;

  /** Component category filter (e.g., "gpu", "cpu", "storage") */
  category?: string;

  /**
   * Storage build role filter. Omit for standard builds (defaults to build-relevant 'internal').
   * Only pass 'removable' or 'external' when accessories are explicitly requested.
   */
  subcategory?: "internal" | "external" | "removable" | "accessory" | string;

  /** Minimum price bound in standard major units (e.g. Rupees or Dollars) */
  price_min?: number;
  minPrice?: number;

  /** Maximum price bound in standard major units (e.g. Rupees or Dollars) */
  price_max?: number;
  maxPrice?: number;

  /** Allowed component brands (matched case-insensitively) */
  brands?: string[];

  /** Retailer name to match */
  retailer?: string;

  /** Return only products currently marked in-stock. Defaults to true */
  in_stock?: boolean;
  inStockOnly?: boolean;

  /** Registry CPU or motherboard socket filter (e.g. "AM5", "LGA 1700") */
  socket?: string;

  /** Memory generation filter */
  ddr?: "DDR3" | "DDR4" | "DDR5" | string;

  /** Motherboard or case form factor filter (e.g. "ATX", "Mini-ITX") */
  form_factor?: string;

  /** Minimum GPU VRAM in GB */
  min_vram_gb?: number;

  /** GPU segment filter */
  segment?: "gaming" | "workstation" | "display" | string;

  /** Maximum CPU or GPU TDP in watts */
  max_tdp_w?: number;

  /** Maximum GPU length in millimeters */
  max_length_mm?: number;

  /** Minimum GPU clearance in millimeters for case selection */
  min_gpu_clearance_mm?: number;

  /** Minimum CPU cooler height clearance in millimeters for case selection */
  min_cooler_clearance_mm?: number;

  /** Minimum storage or RAM capacity in GB */
  min_capacity_gb?: number;

  /** Storage interface filter */
  interface?: "nvme" | "sata" | string;

  /** Minimum power supply wattage in watts */
  min_wattage?: number;

  /** Sort column. Defaults to 'price' */
  sort_by?: "price" | "name" | "retailer" | "last_scraped" | string;

  /** Sort direction ('asc' or 'desc'). Defaults to 'desc' for price */
  order?: "asc" | "desc";

  /** Maximum result count. Defaults to 20 (capped at 50) */
  limit?: number;

  /** Pagination offset */
  offset?: number;
}

/**
 * Individual product item in search results.
 */
export interface SearchProductItem {
  id: string;
  name: string;
  category: string;
  subcategory?: string | null;
  price: number | null;
  currency: string;
  country_code: string;
  retailer: string;
  url: string;
  imageUrl?: string;
  in_stock: boolean;
  inStock?: boolean;
  registry_key?: string | null;
  specs?: Record<string, unknown> | null;
  offers?: ProductOffer[];
  first_seen?: string;
  last_scraped?: string;
}

/**
 * Nearest option outside the requested budget or filter band.
 */
export interface NearestMatch {
  name: string;
  price: number | null;
  retailer?: string;
  registry_key?: string | null;
}

/**
 * Result returned by `searchProducts`, containing matching items, facet metrics, and hints.
 */
export interface SearchProductsResult {
  /** Array of matching products returned */
  results: SearchProductItem[];

  /** Alias for results for test harness and consumer compatibility */
  items?: SearchProductItem[];

  /** Exact matching count across all pages; omitted when filtering stops before the end. */
  total_matching?: number;
  totalCount?: number;

  /** Number of items returned in this batch */
  returned?: number;

  /** Unfiltered SQL candidate count prior to post-SQL registry filtering */
  sql_candidates?: number;

  /** Whether further matches exist beyond this page */
  has_more?: boolean;

  /** Active market scope */
  scope?: {
    country_code: string;
    currency: string;
  };

  /** Total products in the target category */
  category_total?: number;

  /** Total in-stock products in the target category */
  in_stock_total?: number;

  /** Price range observed in this batch */
  batch_price_range?: { min: number | null; max: number | null };

  /** Price range across the entire category in this market */
  category_price_range?: { min: number | null; max: number | null };

  /** Closest in-stock option above requested price_max */
  nearest_above?: NearestMatch;

  /** Closest in-stock option below requested price_min */
  nearest_below?: NearestMatch;

  /** Actionable hint for the caller or LLM explaining result distribution or search limit guidance */
  hint?: string;

  /**
   * @deprecated Standardized on `hint`. Retained for backward compatibility.
   */
  note?: string;

  /** Error string if invalid filters or parameters were provided */
  error?: string;
  valid_filters?: string[];
}

/**
 * Coverage baseline statistics for a category, used to distinguish empty categories from over-tight filters.
 */
export interface CategoryBaselineResult {
  /** Total count of products in this category */
  total: number;

  /** Count of currently in-stock products in this category */
  in_stock_total: number;

  /** Lowest price among in-stock products */
  min_price: number | null;

  /** Highest price among in-stock products */
  max_price: number | null;

  /** CamelCase aliases */
  totalCount?: number;
  inStockTotal?: number;
  minPrice?: number | null;
  maxPrice?: number | null;
}

/**
 * Catalog freshness statistics and metadata.
 */
export interface CatalogFreshnessResult {
  /** ISO 8601 timestamp of most recent scrape run */
  lastScraped: string | null;

  /** Total number of products in catalog */
  productCount: number;

  /** Market country code if filtered */
  countryCode?: string;

  /** Breakdown by market country if available */
  rowCounts?: Array<{
    countryCode: string;
    count: number;
    lastScraped?: string | null;
  }>;
}

/**
 * Input parameters and filter criteria for listing unique hardware models.
 */
export interface ListModelsInput {
  /** Component category filter (e.g., "gpu", "cpu", "motherboard", "ram", "storage", "psu", "case", "cooler") */
  category?: "gpu" | "cpu" | "motherboard" | "ram" | "storage" | "psu" | "case" | "cooler" | string;

  /** Minimum price bound in standard major units */
  price_min?: number;

  /** Maximum price bound in standard major units */
  price_max?: number;

  /** Registry CPU or motherboard socket filter (e.g. "AM5", "LGA 1700") */
  socket?: string;

  /** Memory generation filter */
  ddr?: "DDR3" | "DDR4" | "DDR5" | string;

  /** Minimum GPU VRAM in GB */
  min_vram_gb?: number;

  /** Minimum storage or RAM capacity in GB */
  min_capacity_gb?: number;

  /** Motherboard or case form factor filter (e.g. "ATX", "Mini-ITX") */
  form_factor?: string;

  /** Return only models with products currently in stock. Defaults to true */
  in_stock?: boolean;

  /** Maximum model count to return. Defaults to 20 */
  limit?: number;
}

/**
 * Aggregated unique component model item with functional specifications and listing metrics.
 */
export interface ComponentModelItem {
  /** Canonical registry key or normalized model identifier */
  model_id: string;

  /** Display name of the model */
  name: string;

  /** Component category */
  category: string;

  /** Key functional hardware specifications */
  specs: Record<string, unknown>;

  /** Price range observed across available listings in this market */
  price_range: {
    min: number | null;
    max: number | null;
  };

  /** Total number of matching retailer listings for this model */
  listing_count: number;
}

/**
 * Result returned by `listModels`, containing unique models, aggregation metrics, and hints.
 */
export interface ListModelsResult {
  /** Unique component models returned */
  models: ComponentModelItem[];

  /** Total count of unique models matching the criteria before limit */
  total_matching_models: number;

  /** Number of models returned in this batch */
  returned_models: number;

  /** Whether more models match beyond the limit */
  truncated: boolean;

  /** Market scope applied */
  scope: {
    country_code: string;
    currency: string;
  };

  /** Actionable hint or explanation */
  hint?: string;

  /** Error string if invalid filters or parameters were provided */
  error?: string;
}

/**
 * Authoritative asynchronous Catalog Repository contract.
 * Supported by both SQLite (`better-sqlite3`) for local development
 * and Turso Cloud (`@libsql/client`) for the hosted demo.
 */
export interface CatalogRepository {
  /**
   * Retrieves category-level catalog summaries, counts, and price ranges
   * filtered by market scope (countryCode and currency).
   */
  getCatalog(scope: CatalogScope): Promise<GetCatalogResult>;

  /**
   * Searches products within the catalog according to filters, specifications, and scope.
   */
  searchProducts(input: SearchProductsInput, scope: CatalogScope): Promise<SearchProductsResult>;

  /**
   * Lists aggregated component models and their specs, price ranges, and listing counts.
   */
  listModels(input: ListModelsInput, scope: CatalogScope): Promise<ListModelsResult>;

  /**
   * Computes coverage baseline statistics for a category (total products, in-stock count, price range).
   */
  getCategoryBaseline(
    category: string,
    scope: CatalogScope,
    subcategory?: string
  ): Promise<CategoryBaselineResult>;

  /**
   * Returns catalog freshness metadata (last scraped timestamp, product count).
   */
  getFreshness(countryCode?: string): Promise<CatalogFreshnessResult>;

  /**
   * Optional: Returns supported markets metadata.
   */
  getMarkets?(): Promise<MarketMetadata[]>;

  /**
   * Optional: Closes underlying database or client connections upon teardown.
   */
  close?(): Promise<void>;
}
