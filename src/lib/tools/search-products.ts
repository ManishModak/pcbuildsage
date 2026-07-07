import { tool } from "ai";
import { z } from "zod";
import type Database from "better-sqlite3";
import type { Product } from "../db-types";
import { getDb } from "../db";
import { resolveComponent, type RegistrySpec } from "../registry";

const validFilters = ["category", "price_min", "price_max", "brands", "retailer", "in_stock", "socket", "ddr", "form_factor", "min_vram_gb", "max_tdp_w", "max_length_mm", "sort_by", "order", "limit"];

export const searchProductsInputSchema = z.object({
  category: z.string().optional().describe("Component category to search, such as gpu, cpu, motherboard, ram, storage, psu, case, or cooler."),
  price_min: z.number().int().nonnegative().optional().describe("Minimum product price in integer minor units for the active currency, such as paise or cents."),
  price_max: z.number().int().nonnegative().optional().describe("Maximum product price in integer minor units for the active currency, such as paise or cents."),
  brands: z.array(z.string()).optional().describe("Allowed component brands, matched case-insensitively against registry brand or product title."),
  retailer: z.string().optional().describe("Retailer name to match exactly or partially."),
  in_stock: z.boolean().optional().describe("When true, only return products marked in stock. When false, only return out-of-stock rows."),
  socket: z.string().optional().describe("Registry-resolved CPU or motherboard socket filter, for example AM5 or LGA 1700."),
  ddr: z.enum(["DDR3", "DDR4", "DDR5"]).optional().describe("Registry-resolved memory generation filter."),
  form_factor: z.string().optional().describe("Registry-resolved motherboard or case form factor filter, for example ATX or Mini-ITX."),
  min_vram_gb: z.number().nonnegative().optional().describe("Minimum registry-resolved GPU VRAM in GB."),
  max_tdp_w: z.number().nonnegative().optional().describe("Maximum registry-resolved CPU or GPU TDP in watts."),
  max_length_mm: z.number().nonnegative().optional().describe("Maximum registry-resolved GPU length in millimeters."),
  sort_by: z.enum(["price", "name", "retailer", "last_scraped"]).default("price").describe("Sort field. Use price for value searches, last_scraped for freshest listings."),
  order: z.enum(["asc", "desc"]).default("asc").describe("Sort direction for the selected sort_by field."),
  limit: z.number().int().positive().max(50).default(20).describe("Maximum result count. Defaults to 20 and cannot exceed 50.")
});

export type SearchProductsInput = z.infer<typeof searchProductsInputSchema>;

export function createSearchProductsTool(scope: { dbPath?: string; countryCode: string; currency: string }) {
  return tool({
    description:
      "Use search_products to find purchasable PC parts from the local SQLite database. Use it for component candidates and price comparisons; do not use it for compatibility verdicts or web research. Filterable fields: category, price_min/price_max in integer minor units, brands, retailer, in_stock, socket, ddr, form_factor, min_vram_gb, max_tdp_w, max_length_mm, sort_by, order, limit. Example: {\"category\":\"gpu\",\"price_max\":6000000,\"min_vram_gb\":12,\"in_stock\":true,\"limit\":5}.",
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
  if (input.price_min !== undefined) {
    where.push("price_minor >= ?");
    params.push(input.price_min);
  }
  if (input.price_max !== undefined) {
    where.push("price_minor <= ?");
    params.push(input.price_max);
  }
  if (input.retailer) {
    where.push("retailer LIKE ?");
    params.push(`%${input.retailer}%`);
  }
  if (input.in_stock !== undefined) {
    where.push("in_stock = ?");
    params.push(input.in_stock ? 1 : 0);
  }

  const sortColumn = { price: "price_minor", name: "name", retailer: "retailer", last_scraped: "last_scraped" }[input.sort_by];
  const batchSize = 250;
  const maxScannedRows = 5000;
  const query = db.prepare(`SELECT * FROM products WHERE ${where.join(" AND ")} ORDER BY ${sortColumn} ${input.order === "desc" ? "DESC" : "ASC"} LIMIT ? OFFSET ?`);
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
      price_minor: product.price_minor,
      currency: product.currency,
      country_code: product.country_code,
      retailer: product.retailer,
      url: product.url,
      in_stock: product.in_stock === 1,
      registry_key: registry?.key ?? product.registry_key,
      specs: registry?.spec ?? null
    }));

  if (!results.length) {
    return { results: [], hint: "try widening the price range, removing the brand filter, or relaxing registry spec filters" };
  }
  return { results, scope: { country_code: scope.countryCode, currency: scope.currency } };
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
  if (input.max_tdp_w !== undefined && Number(spec?.tdp_w ?? Number.POSITIVE_INFINITY) > input.max_tdp_w) return false;
  if (input.max_length_mm !== undefined && Number(spec?.length_mm ?? Number.POSITIVE_INFINITY) > input.max_length_mm) return false;
  return true;
}
