/**
 * src/lib/catalog/sql-repository.ts
 *
 * Canonical SQL Catalog Repository implementation.
 * Consolidates query building, market scoping, in-memory registry filtering,
 * nearest price match heuristics, and ProductOffer normalization over an explicit SqlDriver.
 */

import {
  resolveComponent,
  type RegistrySpec,
  type ResolvedSpec,
  type ComponentCategory
} from "@/lib/registry";
import { COMPONENT_CATEGORIES, BUILD_RELEVANT_SQL } from "@/lib/db/catalog-scope";
import type { Product } from "@/types/db";
import { toPriceMinor } from "@/types/catalog";
import { STANDARD_MARKETS, type MarketMetadata } from "@/lib/config/deployment";
import type { SqlDriver } from "./sql-driver";
import type {
  CatalogRepository,
  CatalogScope,
  GetCatalogResult,
  SearchProductsInput,
  SearchProductsResult,
  SearchProductItem,
  NearestMatch,
  CategoryBaselineResult,
  CatalogFreshnessResult,
  CatalogCategorySummary
} from "./repository";
import type { ProductOffer } from "./types";

export { BUILD_RELEVANT_SQL };

export type RegistrySpecResolver = (
  product: Product,
  scope?: CatalogScope
) => ResolvedSpec | undefined;

export function rowToProduct(row: unknown): Product {
  const r = row as Record<string, unknown>;
  return {
    id: String(r.id),
    name: String(r.name ?? ""),
    normalized_name: r.normalized_name != null ? String(r.normalized_name) : null,
    registry_key: r.registry_key != null ? String(r.registry_key) : null,
    price: r.price != null ? Number(r.price) : null,
    currency: String(r.currency ?? "USD"),
    country_code: String(r.country_code ?? "US"),
    retailer: String(r.retailer ?? ""),
    url: String(r.url ?? ""),
    image_url: r.image_url != null ? String(r.image_url) : null,
    in_stock: (Number(r.in_stock ?? 0) ? 1 : 0) as 0 | 1,
    category: String(r.category ?? ""),
    subcategory: r.subcategory != null ? String(r.subcategory) : null,
    specs:
      r.specs != null
        ? typeof r.specs === "object"
          ? JSON.stringify(r.specs)
          : String(r.specs)
        : null,
    first_seen: r.first_seen != null ? String(r.first_seen) : "",
    last_scraped: r.last_scraped != null ? String(r.last_scraped) : ""
  };
}

export class SqlCatalogRepository implements CatalogRepository {
  constructor(
    protected driver: SqlDriver,
    protected registryResolver?: RegistrySpecResolver
  ) {}

  /**
   * Resolves component specifications using the injected resolver boundary.
   */
  protected resolveProductSpec(product: Product, scope?: CatalogScope): ResolvedSpec | undefined {
    if (this.registryResolver) {
      return this.registryResolver(product, scope);
    }
    // Safe default: static registry match without local getDb() fallback
    return resolveComponent(
      {
        key: product.registry_key ?? undefined,
        name: product.normalized_name ?? product.name,
        category: product.category
      },
      { skipDbLookup: true }
    );
  }

  /**
   * Retrieves category-level catalog summaries, counts, and price ranges
   * filtered by market scope (countryCode and currency).
   */
  async getCatalog(
    scope: CatalogScope = { countryCode: "US", currency: "USD" }
  ): Promise<GetCatalogResult> {
    const effectiveScope =
      typeof scope === "string"
        ? { countryCode: scope, currency: "USD" }
        : scope ?? { countryCode: "US", currency: "USD" };

    const countryCode = effectiveScope.countryCode ?? "US";
    const currency = effectiveScope.currency ?? "USD";
    const args: unknown[] = [countryCode, currency];

    const buildSql = `
      SELECT category, COUNT(*) AS count, COALESCE(SUM(in_stock), 0) AS in_stock_count,
             MIN(price) AS price_min, MAX(price) AS price_max
      FROM products
      WHERE country_code = ? AND currency = ? AND ${BUILD_RELEVANT_SQL}
      GROUP BY category
    `.trim();

    const subSql = `
      SELECT category, subcategory, COUNT(*) AS count, MIN(price) AS price_min, MAX(price) AS price_max
      FROM products
      WHERE country_code = ? AND currency = ? AND subcategory IS NOT NULL
      GROUP BY category, subcategory
    `.trim();

    const [buildRows, subRows] = await Promise.all([
      this.driver.all<{
        category: string;
        count: number;
        in_stock_count: number;
        price_min: number | null;
        price_max: number | null;
      }>(buildSql, args, effectiveScope),
      this.driver.all<{
        category: string;
        subcategory: string;
        count: number;
        price_min: number | null;
        price_max: number | null;
      }>(subSql, args, effectiveScope)
    ]);

    type Range = { count: number; price_min: number | null; price_max: number | null };
    const buildByCategory = new Map<
      string,
      { count: number; in_stock_count: number; price_min: number | null; price_max: number | null }
    >();
    for (const r of buildRows) {
      buildByCategory.set(String(r.category), {
        count: Number(r.count ?? 0),
        in_stock_count: Number(r.in_stock_count ?? 0),
        price_min: r.price_min != null ? Number(r.price_min) : null,
        price_max: r.price_max != null ? Number(r.price_max) : null
      });
    }

    const subsByCategory = new Map<string, Record<string, Range>>();
    for (const row of subRows) {
      const cat = String(row.category);
      const subcat = String(row.subcategory);
      const bucket = subsByCategory.get(cat) ?? {};
      bucket[subcat] = {
        count: Number(row.count ?? 0),
        price_min: row.price_min != null ? Number(row.price_min) : null,
        price_max: row.price_max != null ? Number(row.price_max) : null
      };
      subsByCategory.set(cat, bucket);
    }

    const categories: CatalogCategorySummary[] = COMPONENT_CATEGORIES.map(
      (category: ComponentCategory) => {
        const build = buildByCategory.get(category);
        const subcategories = subsByCategory.get(category);
        const accessories = subcategories
          ? Object.keys(subcategories).filter((key) => key !== "internal")
          : [];

        const note = !build?.count
          ? "No products in the catalog for this category. Do not recommend or invent specific products for it."
          : accessories.length
            ? `count/price_min/price_max above cover build parts only. ${accessories.join(", ")} are stocked accessories, not build parts - offer them only if the user explicitly asks.`
            : undefined;

        const categoryObj: CatalogCategorySummary = {
          category,
          count: build?.count ?? 0,
          in_stock_count: build?.in_stock_count ?? 0,
          price_min: build?.price_min ?? null,
          price_max: build?.price_max ?? null,
          ...(subcategories ? { subcategories } : {})
        };
        if (note !== undefined) {
          categoryObj.note = note;
        }
        return categoryObj;
      }
    );

    return {
      categories,
      scope: { country_code: countryCode, currency }
    };
  }

  /**
   * Searches products within the catalog according to filters, specifications, and scope.
   */
  async searchProducts(
    input: SearchProductsInput = {},
    scope: CatalogScope = { countryCode: "US", currency: "USD" }
  ): Promise<SearchProductsResult> {
    const effectiveScope =
      typeof scope === "string"
        ? { countryCode: scope, currency: "USD" }
        : scope ?? { countryCode: "US", currency: "USD" };

    const countryCode = effectiveScope.countryCode ?? "US";
    const currency = effectiveScope.currency ?? "USD";

    const where: string[] = [];
    const params: unknown[] = [];

    if (effectiveScope.countryCode) {
      where.push("country_code = ?");
      params.push(effectiveScope.countryCode);
    }
    if (effectiveScope.currency) {
      where.push("currency = ?");
      params.push(effectiveScope.currency);
    }

    const searchTerm = (input.term ?? input.query)?.trim();
    if (searchTerm) {
      where.push("(name LIKE ? OR normalized_name LIKE ?)");
      params.push(`%${searchTerm}%`, `%${searchTerm}%`);
    }

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

    const priceMin = input.price_min ?? input.minPrice;
    if (priceMin !== undefined) {
      where.push("price >= ?");
      params.push(priceMin);
    }

    const priceMax = input.price_max ?? input.maxPrice;
    if (priceMax !== undefined) {
      where.push("price <= ?");
      params.push(priceMax);
    }

    if (input.retailer) {
      where.push("retailer LIKE ?");
      params.push(`%${input.retailer}%`);
    }

    const effectiveInStock =
      input.in_stock !== undefined ? input.in_stock : input.inStockOnly !== false;
    if (input.in_stock !== undefined) {
      where.push("in_stock = ?");
      params.push(input.in_stock ? 1 : 0);
    } else if (input.inStockOnly === false) {
      // Caller explicitly allowed out-of-stock items
    } else {
      where.push("in_stock = 1");
    }

    const sortBy = input.sort_by ?? "price";
    const sortColumn =
      { price: "price", name: "name", retailer: "retailer", last_scraped: "last_scraped" }[
        sortBy
      ] ?? "price";
    const order = input.order ?? (sortBy === "price" ? "desc" : "asc");
    const rawLimit = input.limit !== undefined ? input.limit : 20;
    const limit = Math.max(0, Math.min(rawLimit, 50));
    const requestOffset = Math.max(0, input.offset ?? 0);

    const whereClause = where.length > 0 ? where.join(" AND ") : "1=1";

    if (limit === 0) {
      const countRow = await this.driver.get<{ total_matches?: number; count?: number }>(
        `SELECT COUNT(*) AS total_matches FROM products WHERE ${whereClause}`,
        params,
        effectiveScope
      );
      const totalMatching = Number(countRow?.total_matches ?? countRow?.count ?? 0);
      return {
        results: [],
        items: [],
        total_matching: totalMatching,
        totalCount: totalMatching,
        returned: 0,
        has_more: totalMatching > 0,
        scope: { country_code: countryCode, currency }
      };
    }

    const batchSize = 250;
    let dbOffset = 0;
    let skipped = 0;
    const matches: Array<{
      product: Product;
      registry: ResolvedSpec | undefined;
      resolvedSpec: RegistrySpec | undefined;
    }> = [];

    while (matches.length < limit) {
      const batchSql = `SELECT * FROM products WHERE ${whereClause} ORDER BY ${sortColumn} ${order.toUpperCase()} LIMIT ? OFFSET ?`;

      const rawRows = await this.driver.all(
        batchSql,
        [...params, batchSize, dbOffset],
        effectiveScope
      );
      const rows = rawRows.map(rowToProduct);
      if (rows.length === 0) break;
      dbOffset += rows.length;

      for (const product of rows) {
        const registry = this.resolveProductSpec(product, effectiveScope);
        let resolvedSpec = registry?.spec;
        if (!resolvedSpec && product.specs) {
          if (typeof product.specs === "object") {
            resolvedSpec = product.specs as RegistrySpec;
          } else if (typeof product.specs === "string") {
            try {
              resolvedSpec = JSON.parse(product.specs);
            } catch {}
          }
        }

        if (this.matchesRegistryFilters(product, resolvedSpec, input)) {
          if (skipped < requestOffset) {
            skipped++;
          } else {
            matches.push({ product, registry, resolvedSpec });
            if (matches.length >= limit) break;
          }
        }
      }

      if (rows.length < batchSize) break;
    }

    const results: SearchProductItem[] = matches.slice(0, limit).map(
      ({ product, registry, resolvedSpec }) => {
        const isInStock = product.in_stock === 1 || Boolean(product.in_stock);
        const offer: ProductOffer = {
          id: product.id,
          productId: String(product.id),
          retailerId: product.retailer
            ? product.retailer
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "-")
                .replace(/^-|-$/g, "")
            : undefined,
          retailer: product.retailer,
          countryCode: product.country_code,
          currencyCode: product.currency,
          price: product.price ?? null,
          priceMinor:
            typeof product.price === "number"
              ? toPriceMinor(product.price, product.currency)
              : undefined,
          destinationUrl: product.url,
          sourceType: "scraped",
          observedAt: product.last_scraped || product.first_seen || new Date().toISOString(),
          lastUpdated: product.last_scraped || new Date().toISOString(),
          availability: isInStock ? "in_stock" : "out_of_stock",
          inStock: isInStock,
          imageUrl: product.image_url ?? null
        };

        return {
          id: String(product.id),
          name: product.name,
          category: product.category,
          subcategory: product.subcategory ?? null,
          price: product.price,
          currency: product.currency,
          country_code: product.country_code,
          retailer: product.retailer,
          url: product.url,
          imageUrl: product.image_url ?? undefined,
          in_stock: isInStock,
          inStock: isInStock,
          registry_key: registry?.key ?? product.registry_key ?? null,
          specs: (registry?.spec ?? resolvedSpec ?? null) as Record<string, unknown> | null,
          offers: [offer],
          first_seen: product.first_seen,
          last_scraped: product.last_scraped
        };
      }
    );

    const baseline = input.category
      ? await this.getCategoryBaseline(input.category, effectiveScope, input.subcategory)
      : null;
    const sliceName = input.subcategory
      ? `${input.subcategory} ${input.category}`
      : `build-relevant ${input.category}`;

    const clause = input.subcategory ? "subcategory = ?" : BUILD_RELEVANT_SQL;

    let nearestAbove: NearestMatch | undefined;
    let nearestBelow: NearestMatch | undefined;

    if (baseline && baseline.in_stock_total > 0 && input.category) {
      if (priceMax !== undefined) {
        const aboveWhere = ["category = ?", "in_stock = 1", clause, "price > ?"];
        const aboveParams: unknown[] = [input.category];
        if (effectiveScope.countryCode) {
          aboveWhere.unshift("country_code = ?");
          aboveParams.unshift(effectiveScope.countryCode);
        }
        if (effectiveScope.currency) {
          aboveWhere.splice(effectiveScope.countryCode ? 1 : 0, 0, "currency = ?");
          aboveParams.splice(effectiveScope.countryCode ? 1 : 0, 0, effectiveScope.currency);
        }
        if (input.subcategory) {
          aboveParams.push(input.subcategory);
        }
        aboveParams.push(priceMax);

        const aboveSql = `SELECT * FROM products WHERE ${aboveWhere.join(" AND ")} ORDER BY price ASC LIMIT 100`;
        const aboveRows = (await this.driver.all(aboveSql, aboveParams, effectiveScope)).map(rowToProduct);

        for (const aboveRow of aboveRows) {
          const reg = this.resolveProductSpec(aboveRow, effectiveScope);
          let resSpec = reg?.spec;
          if (!resSpec && aboveRow.specs) {
            if (typeof aboveRow.specs === "object") {
              resSpec = aboveRow.specs as RegistrySpec;
            } else if (typeof aboveRow.specs === "string") {
              try {
                resSpec = JSON.parse(aboveRow.specs);
              } catch {}
            }
          }
          if (this.matchesRegistryFilters(aboveRow, resSpec, input)) {
            nearestAbove = {
              name: aboveRow.name,
              price: aboveRow.price,
              retailer: aboveRow.retailer,
              registry_key: reg?.key ?? aboveRow.registry_key
            };
            break;
          }
        }
      }

      if (priceMin !== undefined) {
        const belowWhere = ["category = ?", "in_stock = 1", clause, "price < ?"];
        const belowParams: unknown[] = [input.category];
        if (effectiveScope.countryCode) {
          belowWhere.unshift("country_code = ?");
          belowParams.unshift(effectiveScope.countryCode);
        }
        if (effectiveScope.currency) {
          belowWhere.splice(effectiveScope.countryCode ? 1 : 0, 0, "currency = ?");
          belowParams.splice(effectiveScope.countryCode ? 1 : 0, 0, effectiveScope.currency);
        }
        if (input.subcategory) {
          belowParams.push(input.subcategory);
        }
        belowParams.push(priceMin);

        const belowSql = `SELECT * FROM products WHERE ${belowWhere.join(" AND ")} ORDER BY price DESC LIMIT 100`;
        const belowRows = (await this.driver.all(belowSql, belowParams, effectiveScope)).map(rowToProduct);

        for (const belowRow of belowRows) {
          const reg = this.resolveProductSpec(belowRow, effectiveScope);
          let resSpec = reg?.spec;
          if (!resSpec && belowRow.specs) {
            if (typeof belowRow.specs === "object") {
              resSpec = belowRow.specs as RegistrySpec;
            } else if (typeof belowRow.specs === "string") {
              try {
                resSpec = JSON.parse(belowRow.specs);
              } catch {}
            }
          }
          if (this.matchesRegistryFilters(belowRow, resSpec, input)) {
            nearestBelow = {
              name: belowRow.name,
              price: belowRow.price,
              retailer: belowRow.retailer,
              registry_key: reg?.key ?? belowRow.registry_key
            };
            break;
          }
        }
      }
    }

    if (!results.length) {
      if (baseline && baseline.total === 0) {
        return {
          results: [],
          items: [],
          total_matching: 0,
          totalCount: 0,
          category_total: 0,
          scope: { country_code: countryCode, currency },
          hint: `No ${sliceName} products exist in the catalog for ${countryCode}/${currency}. Do not retry with different prices or filters. Tell the user this component category is currently unavailable and do not invent products.`
        };
      }
      if (baseline && effectiveInStock && baseline.in_stock_total === 0) {
        return {
          results: [],
          items: [],
          total_matching: 0,
          totalCount: 0,
          category_total: baseline.total,
          in_stock_total: 0,
          scope: { country_code: countryCode, currency },
          hint: `All ${baseline.total} ${sliceName} products in the catalog for ${countryCode}/${currency} are currently out of stock. Tell the user that no in-stock options exist right now.`
        };
      }
      if (priceMin !== undefined && priceMax !== undefined && priceMin > priceMax) {
        return {
          results: [],
          items: [],
          total_matching: 0,
          totalCount: 0,
          scope: { country_code: countryCode, currency },
          hint: `price_min (${priceMin}) cannot be greater than price_max (${priceMax}).`
        };
      }

      if (baseline) {
        let hint = `${baseline.in_stock_total} of ${baseline.total} ${sliceName} products are in stock but none match these filters. In-stock prices range ${baseline.min_price}-${baseline.max_price} in standard major units (e.g. Rupees/Dollars).`;

        if (nearestBelow && nearestAbove) {
          hint += ` Nearest cheaper option is ${nearestBelow.name} at ${nearestBelow.price}; nearest higher option is ${nearestAbove.name} at ${nearestAbove.price}.`;
        } else if (nearestAbove && priceMax !== undefined) {
          hint += ` Closest in-stock option above your price_max (${priceMax}) is ${nearestAbove.name} at ${nearestAbove.price}. Increase price_max to at least ${nearestAbove.price}.`;
        } else if (nearestBelow && priceMin !== undefined) {
          hint += ` Closest in-stock option below your price_min (${priceMin}) is ${nearestBelow.name} at ${nearestBelow.price}. Lower price_min to at least ${nearestBelow.price}.`;
        } else {
          hint += " Adjust price bounds into that range or relax brand/spec filters.";
        }

        return {
          results: [],
          items: [],
          total_matching: 0,
          totalCount: 0,
          category_total: baseline.total,
          in_stock_total: baseline.in_stock_total,
          category_price_range: { min: baseline.min_price, max: baseline.max_price },
          scope: { country_code: countryCode, currency },
          ...(nearestAbove ? { nearest_above: nearestAbove } : {}),
          ...(nearestBelow ? { nearest_below: nearestBelow } : {}),
          hint
        };
      }

      return {
        results: [],
        items: [],
        total_matching: 0,
        totalCount: 0,
        ...(nearestAbove ? { nearest_above: nearestAbove } : {}),
        ...(nearestBelow ? { nearest_below: nearestBelow } : {}),
        scope: { country_code: countryCode, currency },
        hint: `No matching ${sliceName} products found with the given filters. Try relaxing brand, retailer, or specification constraints.`
      };
    }

    const prices = results.map((r) => r.price).filter((p): p is number => typeof p === "number");
    const batchPriceRange = prices.length
      ? { min: Math.min(...prices), max: Math.max(...prices) }
      : { min: null, max: null };

    // Accurate total matching count:
    // If we reached end of results within the first batch and didn't apply complex in-memory registry filters,
    // matches.length + requestOffset is accurate. Otherwise count matched rows.
    let totalMatching = results.length + requestOffset;
    const countRow = await this.driver.get<{ total_matches?: number; count?: number }>(
      `SELECT COUNT(*) AS total_matches FROM products WHERE ${whereClause}`,
      params,
      effectiveScope
    );
    totalMatching = Number(countRow?.total_matches ?? countRow?.count ?? results.length);

    const hasMore = totalMatching > requestOffset + results.length;

    let hint: string | undefined;
    if (baseline && baseline.total > results.length) {
      hint = `Showing ${results.length} of ${totalMatching} matching in-stock products (${baseline.total} total in category).`;
      if (nearestAbove) {
        hint += ` Closest in-stock option above your price_max (${priceMax}) is ${nearestAbove.name} at ${nearestAbove.price}.`;
      }
      if (nearestBelow) {
        hint += ` Closest in-stock option below your price_min (${priceMin}) is ${nearestBelow.name} at ${nearestBelow.price}.`;
      }
    }

    return {
      results,
      items: results,
      total_matching: totalMatching,
      totalCount: totalMatching,
      returned: results.length,
      has_more: hasMore,
      batch_price_range: batchPriceRange,
      category_price_range: baseline ? { min: baseline.min_price, max: baseline.max_price } : undefined,
      category_total: baseline?.total,
      in_stock_total: baseline?.in_stock_total,
      ...(nearestAbove ? { nearest_above: nearestAbove } : {}),
      ...(nearestBelow ? { nearest_below: nearestBelow } : {}),
      ...(hint ? { hint } : {}),
      scope: { country_code: countryCode, currency }
    };
  }

  /**
   * Computes coverage baseline statistics for a category (total products, in-stock count, price range).
   */
  async getCategoryBaseline(
    category: string,
    scope: CatalogScope = { countryCode: "US", currency: "USD" },
    subcategory?: string
  ): Promise<CategoryBaselineResult> {
    const effectiveScope =
      typeof scope === "string"
        ? { countryCode: scope, currency: "USD" }
        : scope ?? { countryCode: "US", currency: "USD" };

    const countryCode = effectiveScope.countryCode;
    const currency = effectiveScope.currency;
    const where = ["category = ?"];
    const params: unknown[] = [category];

    if (countryCode) {
      where.unshift("country_code = ?");
      params.unshift(countryCode);
    }
    if (currency) {
      where.splice(countryCode ? 1 : 0, 0, "currency = ?");
      params.splice(countryCode ? 1 : 0, 0, currency);
    }

    const clause = subcategory ? "subcategory = ?" : BUILD_RELEVANT_SQL;
    where.push(clause);
    if (subcategory) {
      params.push(subcategory);
    }

    const sql = `
      SELECT COUNT(*) AS total,
             COALESCE(SUM(in_stock), 0) AS in_stock_total,
             MIN(CASE WHEN in_stock = 1 THEN price END) AS min_price,
             MAX(CASE WHEN in_stock = 1 THEN price END) AS max_price
      FROM products
      WHERE ${where.join(" AND ")}
    `.trim();

    const row = await this.driver.get<{
      total?: number;
      in_stock_total?: number;
      min_price?: number | null;
      max_price?: number | null;
    }>(sql, params, effectiveScope);

    const total = Number(row?.total ?? 0);
    const in_stock_total = Number(row?.in_stock_total ?? 0);
    const min_price = row?.min_price != null ? Number(row?.min_price) : null;
    const max_price = row?.max_price != null ? Number(row?.max_price) : null;

    return {
      total,
      in_stock_total,
      min_price,
      max_price,
      totalCount: total,
      inStockTotal: in_stock_total,
      minPrice: min_price,
      maxPrice: max_price
    };
  }

  /**
   * Returns catalog freshness metadata (last scraped timestamp, product count).
   */
  async getFreshness(countryCode?: string): Promise<CatalogFreshnessResult> {
    let sql = "SELECT COUNT(*) as productCount, MAX(last_scraped) as lastScraped FROM products";
    const params: unknown[] = [];
    if (countryCode) {
      sql += " WHERE country_code = ?";
      params.push(countryCode.toUpperCase());
    }

    const row = await this.driver.get<{ productCount?: number; lastScraped?: string | null }>(
      sql,
      params
    );

    let rowCounts: Array<{ countryCode: string; count: number; lastScraped?: string | null }> | undefined = undefined;
    if (!countryCode) {
      try {
        const counts = await this.driver.all<{
          countryCode?: string;
          country_code?: string;
          count?: number;
          lastScraped?: string | null;
          last_scraped?: string | null;
        }>(`
          SELECT country_code AS countryCode, COUNT(*) AS count, MAX(last_scraped) AS lastScraped
          FROM products
          GROUP BY country_code
          ORDER BY country_code
        `);
        rowCounts = counts.map((c) => ({
          countryCode: String(c.countryCode ?? c.country_code ?? ""),
          count: Number(c.count ?? 0),
          lastScraped: c.lastScraped ?? c.last_scraped ?? null
        }));
      } catch {
        rowCounts = [];
      }
    }

    return {
      lastScraped: row?.lastScraped ?? null,
      productCount: Number(row?.productCount ?? 0),
      ...(countryCode ? { countryCode: countryCode.toUpperCase() } : {}),
      ...(rowCounts ? { rowCounts } : {})
    };
  }

  /**
   * Returns supported markets metadata.
   */
  async getMarkets(): Promise<MarketMetadata[]> {
    if (!this.driver.isOpen()) {
      throw new Error("Repository is closed");
    }
    return [...STANDARD_MARKETS];
  }

  /**
   * Closes underlying database or client connections upon teardown.
   */
  async close(): Promise<void> {
    await this.driver.close();
  }

  protected matchesRegistryFilters(
    product: Product,
    spec: RegistrySpec | undefined,
    input: SearchProductsInput
  ): boolean {
    if (input.brands?.length) {
      const haystack = `${spec?.brand ?? ""} ${product.name}`.toLowerCase();
      if (!input.brands.some((brand) => haystack.includes(brand.toLowerCase()))) return false;
    }
    if (input.socket && spec?.socket !== input.socket) return false;
    if (input.ddr && spec?.ddr !== input.ddr) return false;
    if (input.form_factor) {
      const forms = [
        spec?.form_factor,
        ...(Array.isArray(spec?.form_factors) ? spec.form_factors : [])
      ];
      if (!forms.includes(input.form_factor)) return false;
    }
    if (input.min_vram_gb !== undefined && Number(spec?.vram_gb ?? -1) < input.min_vram_gb)
      return false;
    if (input.segment && spec?.segment !== input.segment) return false;
    if (
      input.max_tdp_w !== undefined &&
      Number(spec?.tdp_w ?? Number.POSITIVE_INFINITY) > input.max_tdp_w
    )
      return false;
    if (
      input.max_length_mm !== undefined &&
      Number(spec?.length_mm ?? Number.POSITIVE_INFINITY) > input.max_length_mm
    )
      return false;
    if (
      input.min_capacity_gb !== undefined &&
      Number(spec?.capacity_gb ?? -1) < input.min_capacity_gb
    )
      return false;
    if (input.interface && spec?.interface !== input.interface) return false;
    if (input.min_wattage !== undefined && Number(spec?.wattage_w ?? -1) < input.min_wattage)
      return false;
    return true;
  }
}
