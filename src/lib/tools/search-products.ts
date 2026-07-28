import { tool } from "ai";
import { z } from "zod";
import type Database from "better-sqlite3";
import type { Product } from "../db-types";
import { getDb } from "../db";
import { resolveComponent, type RegistrySpec } from "../registry";
import { BUILD_RELEVANT_SQL } from "../catalog-scope";

const validFilters = ["category", "subcategory", "price_min", "price_max", "brands", "retailer", "in_stock", "socket", "ddr", "form_factor", "min_vram_gb", "segment", "max_tdp_w", "max_length_mm", "sort_by", "order", "limit"];

export const searchProductsInputSchema = z.object({
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
  sort_by: z.enum(["price", "name", "retailer", "last_scraped"]).default("price").describe("Sort field. Use price for value searches, last_scraped for freshest listings."),
  order: z.enum(["asc", "desc"]).optional().describe("Sort direction. Defaults to desc for price (best part within the budget first, which is what a build needs) and asc otherwise. Pass asc on price only when the user explicitly wants the cheapest option."),
  limit: z.number().int().positive().max(50).default(20).describe("Maximum result count. Defaults to 20 and cannot exceed 50.")
});

export type SearchProductsInput = z.infer<typeof searchProductsInputSchema>;

export function createSearchProductsTool(scope: { dbPath?: string; countryCode: string; currency: string }) {
  return tool({
    description:
      "Use search_products to find purchasable PC parts from the local SQLite database. Use it for component candidates and price comparisons; do not use it for compatibility verdicts or web research. Results are in-stock only unless you pass in_stock: false. Filterable fields: category, subcategory, price_min/price_max in standard major units (e.g. Rupees/Dollars), brands, retailer, in_stock, socket, ddr, form_factor, min_vram_gb, segment, max_tdp_w, max_length_mm, sort_by, order, limit. Example: {\"category\":\"gpu\",\"price_max\":60000,\"min_vram_gb\":12,\"limit\":5}.",
    inputSchema: searchProductsInputSchema,
    execute: async (input) => searchProducts(input, scope)
  });
}

export async function searchProducts(input: SearchProductsInput, scope: { dbPath?: string; countryCode: string; currency: string }) {
  const unknown = Object.keys(input).filter((key) => !validFilters.includes(key));
  if (unknown.length) return { error: `Unknown filter(s): ${unknown.join(", ")}`, valid_filters: validFilters };

  const db = getDb(scope.dbPath);
  const where = ["country_code = ?", "currency = ?"];
  const params: unknown[] = [scope.countryCode, scope.currency];
  if (input.category) {
    where.push("category = ?");
    params.push(input.category);
  }
  if (input.subcategory) {
    where.push("subcategory = ?");
    params.push(input.subcategory);
  } else {
    where.push(BUILD_RELEVANT_SQL);
  }
  if (input.price_min !== undefined) {
    where.push("price >= ?");
    params.push(input.price_min);
  }
  if (input.price_max !== undefined) {
    where.push("price <= ?");
    params.push(input.price_max);
  }
  if (input.retailer) {
    where.push("retailer LIKE ?");
    params.push(`%${input.retailer}%`);
  }
  where.push("in_stock = ?");
  params.push(input.in_stock ? 1 : 0);

  const sortColumn = { price: "price", name: "name", retailer: "retailer", last_scraped: "last_scraped" }[input.sort_by];
  // Cheapest-first is a junk-surfacing strategy: within any price band the cheapest
  // row is the worst thing in it, which is how a 4GB pen drive and a workstation
  // Quadro ended up at the top of gaming builds. For price, "best I can afford"
  // is what a build consultant means, so default to descending within the band.
  const order = input.order ?? (input.sort_by === "price" ? "desc" : "asc");
  const batchSize = 250;
  const maxScannedRows = 5000;
  const query = db.prepare(`SELECT * FROM products WHERE ${where.join(" AND ")} ORDER BY ${sortColumn} ${order === "desc" ? "DESC" : "ASC"} LIMIT ? OFFSET ?`);
  const matches: Array<{ product: Product; registry: ReturnType<typeof resolveProductSpec> }> = [];

  for (let offset = 0; offset < maxScannedRows && matches.length < input.limit; offset += batchSize) {
    const rows = query.all(...params, batchSize, offset) as Product[];
    for (const product of rows) {
      const registry = resolveProductSpec(product, db);
      if (matchesRegistryFilters(product, registry?.spec, input)) matches.push({ product, registry });
      if (matches.length >= input.limit) break;
    }
    if (rows.length < batchSize) break;
  }

  const results = matches
    .slice(0, input.limit)
    .map(({ product, registry }) => ({
      id: product.id,
      name: product.name,
      category: product.category,
      price: product.price,
      currency: product.currency,
      country_code: product.country_code,
      retailer: product.retailer,
      url: product.url,
      in_stock: product.in_stock === 1,
      registry_key: registry?.key ?? product.registry_key,
      specs: registry?.spec ?? null
    }));

  // Category coverage baseline: how many products exist in this category within
  // scope, ignoring price/brand/registry filters. This lets the model tell an
  // empty catalog category ("give up") apart from an over-tight filter ("adjust").
  const baseline = input.category ? categoryBaseline(db, scope, input.category, input.subcategory) : null;

  const sliceName = input.subcategory ? `${input.subcategory} ${input.category}` : `build-relevant ${input.category}`;

  if (!results.length) {
    if (baseline && baseline.total === 0) {
      return {
        results: [],
        category_total: 0,
        hint: `No ${sliceName} products exist in the catalog for ${scope.countryCode}/${scope.currency}. Do not retry with different prices or filters. Tell the user this component category is currently unavailable and do not invent products.`
      };
    }
    if (baseline && input.in_stock && baseline.in_stock_total === 0) {
      return {
        results: [],
        category_total: baseline.total,
        in_stock_total: 0,
        hint: `All ${baseline.total} ${sliceName} products in the catalog for ${scope.countryCode}/${scope.currency} are currently out of stock, so none can be used in a build. Do not retry with different prices or filters. Tell the user this component is unavailable at the scraped retailers and suggest re-scraping for fresher stock.`
      };
    }
    if (baseline) {
      return {
        results: [],
        category_total: baseline.total,
        in_stock_total: baseline.in_stock_total,
        category_price_range: { min: baseline.min_price, max: baseline.max_price },
        hint: `${baseline.in_stock_total} of ${baseline.total} ${sliceName} products are in stock but none match these filters. In-stock prices range ${baseline.min_price}-${baseline.max_price} in standard major units (e.g. Rupees/Dollars). Adjust price bounds into that range or relax brand/spec filters.`
      };
    }
    return { results: [], hint: "try widening the price range, removing the brand filter, or relaxing registry spec filters" };
  }
  return {
    results,
    scope: { country_code: scope.countryCode, currency: scope.currency },
    ...(baseline ? { category_total: baseline.total } : {})
  };
}

/**
 * Coverage baseline for a category, ignoring price/brand/registry filters.
 * Lets the model tell an empty catalog category ("give up") from an over-tight
 * filter ("adjust"). Counts stock separately and reports the price range over
 * in-stock rows only, since a band occupied purely by retired listings is not
 * something a build can be assembled from.
 */
function categoryBaseline(db: Database.Database, scope: { countryCode: string; currency: string }, category: string, subcategory?: string) {
  const clause = subcategory ? "subcategory = ?" : BUILD_RELEVANT_SQL;
  const params = subcategory ? [scope.countryCode, scope.currency, category, subcategory] : [scope.countryCode, scope.currency, category];
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(in_stock), 0) AS in_stock_total,
              MIN(CASE WHEN in_stock = 1 THEN price END) AS min_price,
              MAX(CASE WHEN in_stock = 1 THEN price END) AS max_price
       FROM products
       WHERE country_code = ? AND currency = ? AND category = ? AND ${clause}`
    )
    .get(...params) as { total: number; in_stock_total: number; min_price: number | null; max_price: number | null };
  return row;
}

function resolveProductSpec(product: Product, db: Database.Database) {
  return resolveComponent({ key: product.registry_key ?? undefined, name: product.normalized_name ?? product.name, category: product.category }, { db });
}

function matchesRegistryFilters(product: Product, spec: RegistrySpec | undefined, input: SearchProductsInput) {
  if (input.brands?.length) {
    const haystack = `${spec?.brand ?? ""} ${product.name}`.toLowerCase();
    if (!input.brands.some((brand) => haystack.includes(brand.toLowerCase()))) return false;
  }
  if (input.socket && spec?.socket !== input.socket) return false;
  if (input.ddr && spec?.ddr !== input.ddr) return false;
  if (input.form_factor) {
    const forms = [spec?.form_factor, ...(Array.isArray(spec?.form_factors) ? spec.form_factors : [])];
    if (!forms.includes(input.form_factor)) return false;
  }
  if (input.min_vram_gb !== undefined && Number(spec?.vram_gb ?? -1) < input.min_vram_gb) return false;
  if (input.segment && spec?.segment !== input.segment) return false;
  if (input.max_tdp_w !== undefined && Number(spec?.tdp_w ?? Number.POSITIVE_INFINITY) > input.max_tdp_w) return false;
  if (input.max_length_mm !== undefined && Number(spec?.length_mm ?? Number.POSITIVE_INFINITY) > input.max_length_mm) return false;
  return true;
}
