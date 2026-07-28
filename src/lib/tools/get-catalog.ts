import { tool } from "ai";
import { z } from "zod";
import { getDb } from "../db";
import { BUILD_RELEVANT_SQL, COMPONENT_CATEGORIES } from "../catalog-scope";

type Scope = { dbPath?: string; countryCode: string; currency: string };

type Range = { count: number; price_min: number | null; price_max: number | null };

export function createGetCatalogTool(scope: Scope) {
  return tool({
    description:
      "Call get_catalog ONCE at the start of a build to see which component categories have products in the local catalog. Every category is listed; a category with count 0 has no products and cannot be built with - say so plainly rather than inventing parts. The count and price range of each category cover only parts that go INSIDE a PC. Some categories also carry a `subcategories` breakdown of accessories that are stocked but are NOT build parts (for storage: external drives, pen drives, memory cards); never put those in a build unless the user explicitly asks for portable or USB storage. Prices are in standard major units (Rupees/Dollars).",
    inputSchema: z.object({}),
    execute: async () => getCatalog(scope)
  });
}

export async function getCatalog(scope: Scope) {
  const db = getDb(scope.dbPath);
  const args = [scope.countryCode, scope.currency];

  // Headline numbers are build-relevant ONLY. If accessories are allowed into
  // these aggregates the model plans against a lie: storage's floor becomes 410
  // (a 4GB USB stick) instead of 2499, and it searches straight into pen drives.
  const buildRows = db
    .prepare(
      `SELECT category, COUNT(*) AS count, COALESCE(SUM(in_stock), 0) AS in_stock_count,
              MIN(price) AS price_min, MAX(price) AS price_max
       FROM products
       WHERE country_code = ? AND currency = ? AND ${BUILD_RELEVANT_SQL}
       GROUP BY category`
    )
    .all(...args) as Array<{ category: string; count: number; in_stock_count: number; price_min: number | null; price_max: number | null }>;

  // Accessories are still stocked and still findable - they are just not build
  // parts. Reporting them honestly (rather than hiding them) lets the model answer
  // "do you have pen drives?" without a wasted search, and without ever having to
  // claim something is absent when it is not.
  const subRows = db
    .prepare(
      `SELECT category, subcategory, COUNT(*) AS count, MIN(price) AS price_min, MAX(price) AS price_max
       FROM products
       WHERE country_code = ? AND currency = ? AND subcategory IS NOT NULL
       GROUP BY category, subcategory`
    )
    .all(...args) as Array<{ category: string; subcategory: string; count: number; price_min: number | null; price_max: number | null }>;

  const buildByCategory = new Map(buildRows.map((r) => [r.category, r]));
  const subsByCategory = new Map<string, Record<string, Range>>();
  for (const row of subRows) {
    const bucket = (subsByCategory.get(row.category) ?? {}) as Record<string, Range>;
    bucket[row.subcategory] = { count: row.count, price_min: row.price_min, price_max: row.price_max };
    subsByCategory.set(row.category, bucket);
  }

  // Enumerate every known category, including the ones with nothing in them. An
  // explicit count of 0 is unambiguous; a silently absent key is not.
  const categories = COMPONENT_CATEGORIES.map((category) => {
    const build = buildByCategory.get(category);
    const subcategories = subsByCategory.get(category);
    const accessories = subcategories
      ? Object.keys(subcategories).filter((key) => key !== "internal")
      : [];

    return {
      category,
      count: build?.count ?? 0,
      in_stock_count: build?.in_stock_count ?? 0,
      price_min: build?.price_min ?? null,
      price_max: build?.price_max ?? null,
      ...(subcategories ? { subcategories } : {}),
      note: !build?.count
        ? "No products in the catalog for this category. Do not recommend or invent specific products for it."
        : accessories.length
          ? `count/price_min/price_max above cover build parts only. ${accessories.join(", ")} are stocked accessories, not build parts - offer them only if the user explicitly asks.`
          : undefined
    };
  });

  return {
    categories,
    scope: { country_code: scope.countryCode, currency: scope.currency }
  };
}
