import { tool } from "ai";
import { z } from "zod";
import { getDb } from "../db";

export function createGetCatalogTool(scope: { dbPath?: string; countryCode: string; currency: string }) {
  return tool({
    description:
      "Call get_catalog ONCE at the start of a build to see which component categories actually have products in the local catalog, and each category's price range in integer minor units. Categories NOT listed have zero products - do not recommend or search for them.",
    inputSchema: z.object({}),
    execute: async () => getCatalog(scope)
  });
}

export async function getCatalog(scope: { dbPath?: string; countryCode: string; currency: string }) {
  const db = getDb(scope.dbPath);
  const sql =
    "SELECT category, COUNT(*) AS count, SUM(in_stock) AS in_stock_count, MIN(price_minor) AS price_min, MAX(price_minor) AS price_max FROM products WHERE country_code = ? AND currency = ? GROUP BY category ORDER BY count DESC";
  const rows = db.prepare(sql).all(scope.countryCode, scope.currency) as Array<{
    category: string;
    count: number;
    in_stock_count: number;
    price_min: number;
    price_max: number;
  }>;

  return {
    categories: rows.map((r) => ({
      category: r.category,
      count: r.count,
      in_stock_count: r.in_stock_count,
      price_min_minor: r.price_min,
      price_max_minor: r.price_max
    })),
    scope: { country_code: scope.countryCode, currency: scope.currency }
  };
}
