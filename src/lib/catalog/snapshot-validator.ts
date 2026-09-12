/**
 * src/lib/catalog/snapshot-validator.ts
 *
 * Rigorous validation for candidate SQLite catalog databases produced by the scraper
 * before they can be published to Turso.
 */

import Database from "better-sqlite3";
import fs from "node:fs";
import { DATABASE_SCHEMA_VERSION } from "@/lib/db";

export { DATABASE_SCHEMA_VERSION };

export interface SnapshotValidationOptions {
  minProducts?: number;
  minCategories?: number;
  allowEmpty?: boolean;
  maxDuplicateUrlRatio?: number;
  baselineDbPath?: string;
  maxDropRatio?: number;
  baselineProductCount?: number;
  maxSweepRatio?: number;
}

export interface SnapshotValidationStats {
  totalProducts: number;
  inStockProducts: number;
  categories: Record<string, number>;
  retailers: Record<string, number>;
  countries: Record<string, number>;
  duplicateUrls: number;
}

export interface SnapshotValidationMetrics {
  totalProducts: number;
  schemaVersion: number;
  priceErrors: number;
  corruptedUrls: number;
  wafDetections: number;
  duplicateUrls?: number;
  sweepRatio?: number;
}

export interface SnapshotValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  stats: SnapshotValidationStats;
  metrics?: SnapshotValidationMetrics;
}

export const REQUIRED_COLUMNS = [
  "id",
  "name",
  "category",
  "price",
  "currency",
  "country_code",
  "url",
  "in_stock",
  "retailer",
  "last_scraped",
  "subcategory"
] as const;

export const WAF_CHALLENGE_INDICATORS: readonly string[] = [
  "cloudflare",
  "attention required",
  "access denied",
  "verify you are human",
  "just a moment",
  "403 forbidden",
  "datadome",
  "ddos-guard",
  "captcha",
  "security check",
  "bot detection",
  "challenge-platform"
];

interface RawProductRow {
  id: unknown;
  name: unknown;
  category: unknown;
  price: unknown;
  currency: unknown;
  country_code: unknown;
  url: unknown;
  in_stock: unknown;
  retailer: unknown;
  last_scraped: unknown;
  subcategory: unknown;
}

/**
 * Synchronously validates an already open candidate SQLite database connection.
 */
export function validateCandidateSnapshotSync(
  db: Database.Database,
  options?: SnapshotValidationOptions
): SnapshotValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const stats: SnapshotValidationStats = {
    totalProducts: 0,
    inStockProducts: 0,
    categories: {},
    retailers: {},
    countries: {},
    duplicateUrls: 0
  };

  if (!db || !db.open) {
    return {
      valid: false,
      errors: ["Database connection is closed or uninitialized."],
      warnings,
      stats
    };
  }

  try {
    // 1. Schema version verification
    let userVersion = 0;
    try {
      userVersion = Number(db.pragma("user_version", { simple: true }));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Failed to read user_version: ${msg}`);
    }

    if (userVersion !== DATABASE_SCHEMA_VERSION) {
      errors.push(
        `Invalid schema version ${userVersion}. Expected version ${DATABASE_SCHEMA_VERSION}.`
      );
    }

    // 2. Table structure & required columns verification
    const tableRows = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    const tables = new Set(tableRows.map((t) => t.name));

    if (!tables.has("products")) {
      errors.push("Required table 'products' is missing.");
      return {
        valid: false,
        errors,
        warnings,
        stats,
        metrics: {
          totalProducts: 0,
          schemaVersion: userVersion,
          priceErrors: 0,
          corruptedUrls: 0,
          wafDetections: 0,
          duplicateUrls: 0,
          sweepRatio: 0
        }
      };
    }

    if (!tables.has("audit_cache")) {
      warnings.push("Optional table 'audit_cache' is missing.");
    }
    if (!tables.has("registry_research")) {
      warnings.push("Optional table 'registry_research' is missing.");
    }

    const columnRows = db.pragma("table_info(products)") as Array<{ name: string }>;
    const columns = new Set(columnRows.map((c) => c.name));

    const missingColumns = REQUIRED_COLUMNS.filter((col) => !columns.has(col));
    if (missingColumns.length > 0) {
      errors.push(
        `Table 'products' is missing required column(s): ${missingColumns.join(", ")}.`
      );
      return {
        valid: false,
        errors,
        warnings,
        stats,
        metrics: {
          totalProducts: 0,
          schemaVersion: userVersion,
          priceErrors: 0,
          corruptedUrls: 0,
          wafDetections: 0,
          duplicateUrls: 0,
          sweepRatio: 0
        }
      };
    }

    // 3. Product count & threshold validation
    const countRow = db
      .prepare("SELECT COUNT(*) as count FROM products")
      .get() as { count: number } | undefined;
    const totalProducts = countRow?.count ?? 0;
    stats.totalProducts = totalProducts;

    const minProducts = options?.minProducts ?? 50;
    const allowEmpty = options?.allowEmpty ?? false;

    if (totalProducts === 0) {
      if (!allowEmpty) {
        errors.push("Candidate catalog contains 0 products (zero-product anomaly).");
      }
    } else if (totalProducts < minProducts && !allowEmpty) {
      errors.push(
        `Candidate catalog contains ${totalProducts} products, below minimum threshold of ${minProducts}.`
      );
    }

    // 4. Catastrophic product count drop check (baseline comparison)
    let baselineCount = options?.baselineProductCount;
    if (baselineCount === undefined && options?.baselineDbPath) {
      if (fs.existsSync(options.baselineDbPath)) {
        let baselineDb: Database.Database | null = null;
        try {
          baselineDb = new Database(options.baselineDbPath, {
            readonly: true,
            fileMustExist: true
          });
          const baselineTables = (
            baselineDb
              .prepare("SELECT name FROM sqlite_master WHERE type='table'")
              .all() as Array<{ name: string }>
          ).map((t) => t.name);

          if (baselineTables.includes("products")) {
            const row = baselineDb
              .prepare("SELECT COUNT(*) as count FROM products")
              .get() as { count: number } | undefined;
            baselineCount = row?.count ?? 0;
          } else {
            warnings.push(
              `Baseline database at ${options.baselineDbPath} does not have a 'products' table.`
            );
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          warnings.push(
            `Could not read baseline database at ${options.baselineDbPath}: ${msg}`
          );
        } finally {
          if (baselineDb && baselineDb.open) {
            baselineDb.close();
          }
        }
      } else {
        warnings.push(
          `Baseline database file does not exist: ${options.baselineDbPath}`
        );
      }
    }

    if (baselineCount !== undefined && baselineCount > 0) {
      const maxDropRatio = options?.maxDropRatio ?? 0.3;
      if (totalProducts < baselineCount) {
        const dropRatio = (baselineCount - totalProducts) / baselineCount;
        if (dropRatio > maxDropRatio) {
          errors.push(
            `Product count dropped by ${(dropRatio * 100).toFixed(1)}% (${totalProducts} vs baseline ${baselineCount}), exceeding max allowed drop of ${(maxDropRatio * 100).toFixed(1)}%.`
          );
        }
      }
    }

    // 5. Product rows inspection
    let priceErrors = 0;
    let corruptedUrls = 0;
    let wafDetections = 0;
    let missingRequiredFields = 0;
    let invalidCurrencyCount = 0;
    let outOfStockCount = 0;

    const seenUrls = new Set<string>();
    let duplicateUrls = 0;

    if (totalProducts > 0) {
      const rows = db
        .prepare(
          `SELECT id, name, category, price, currency, country_code, url, in_stock, retailer, last_scraped, subcategory FROM products`
        )
        .all() as RawProductRow[];

      for (const row of rows) {
        const nameStr = typeof row.name === "string" ? row.name.trim() : "";
        const categoryStr = typeof row.category === "string" ? row.category.trim() : "";
        const countryCodeStr =
          typeof row.country_code === "string" ? row.country_code.trim() : "";
        const currencyStr =
          typeof row.currency === "string" ? row.currency.trim() : "";
        const urlStr = typeof row.url === "string" ? row.url.trim() : "";
        const retailerStr =
          typeof row.retailer === "string" ? row.retailer.trim() : "";

        // Required fields: name, category, country_code, currency, url
        if (!nameStr || !categoryStr || !countryCodeStr || !currencyStr || !urlStr) {
          missingRequiredFields++;
        }

        // Stats aggregations
        if (categoryStr) {
          stats.categories[categoryStr] = (stats.categories[categoryStr] ?? 0) + 1;
        }
        if (retailerStr) {
          stats.retailers[retailerStr] = (stats.retailers[retailerStr] ?? 0) + 1;
        }
        if (countryCodeStr) {
          stats.countries[countryCodeStr] =
            (stats.countries[countryCodeStr] ?? 0) + 1;
        }

        const isInStock =
          row.in_stock === 1 || row.in_stock === true || row.in_stock === "1";
        if (isInStock) {
          stats.inStockProducts++;
        } else {
          outOfStockCount++;
        }

        // Duplicate URL check
        if (urlStr) {
          if (seenUrls.has(urlStr)) {
            duplicateUrls++;
          } else {
            seenUrls.add(urlStr);
          }
        }

        // Price sanity: must be positive finite number (> 0)
        const priceVal =
          typeof row.price === "number"
            ? row.price
            : row.price !== null && row.price !== undefined && row.price !== ""
              ? Number(row.price)
              : NaN;
        if (
          row.price === null ||
          row.price === undefined ||
          !Number.isFinite(priceVal) ||
          priceVal <= 0
        ) {
          priceErrors++;
        }

        // Currency sanity: must be a valid 3-letter ISO code
        if (!currencyStr || !/^[A-Z]{3}$/.test(currencyStr)) {
          invalidCurrencyCount++;
        }

        // URL integrity: must start with http:// or https:// and contain no whitespace
        const isUrlFormatValid =
          (urlStr.startsWith("http://") || urlStr.startsWith("https://")) &&
          !/\s/.test(urlStr);
        if (!urlStr || !isUrlFormatValid) {
          corruptedUrls++;
        }

        // WAF / Bot-challenge / Captcha detection
        const lowerName = nameStr.toLowerCase();
        const lowerUrl = urlStr.toLowerCase();
        const hasWafIndicator = WAF_CHALLENGE_INDICATORS.some(
          (indicator) =>
            lowerName.includes(indicator) || lowerUrl.includes(indicator)
        );
        if (hasWafIndicator) {
          wafDetections++;
        }
      }
    }

    stats.duplicateUrls = duplicateUrls;

    // Field integrity errors
    if (missingRequiredFields > 0) {
      errors.push(
        `Found ${missingRequiredFields} product(s) with missing or empty required fields (name, category, country_code, currency, url).`
      );
    }

    if (priceErrors > 0) {
      errors.push(
        `Found ${priceErrors} product(s) with invalid or non-positive price.`
      );
    }

    if (invalidCurrencyCount > 0) {
      errors.push(
        `Found ${invalidCurrencyCount} product(s) with invalid currency code (must be a valid 3-letter uppercase ISO code).`
      );
    }

    if (corruptedUrls > 0) {
      errors.push(
        `Found ${corruptedUrls} product(s) with malformed URL (must start with http:// or https:// and contain no whitespace).`
      );
    }

    // Duplicate URL threshold
    const maxDuplicateUrlRatio = options?.maxDuplicateUrlRatio ?? 0.05;
    if (totalProducts > 0) {
      const dupRatio = duplicateUrls / totalProducts;
      if (dupRatio > maxDuplicateUrlRatio) {
        errors.push(
          `Duplicate URL ratio ${(dupRatio * 100).toFixed(1)}% (${duplicateUrls}/${totalProducts}) exceeds maximum allowed threshold of ${(maxDuplicateUrlRatio * 100).toFixed(1)}%.`
        );
      }
    }

    // WAF detection error
    if (wafDetections > 0) {
      errors.push(
        `Detected ${wafDetections} product(s) containing WAF challenge signatures or CAPTCHA text.`
      );
    }

    // Categories threshold
    if (options?.minCategories !== undefined) {
      const categoryCount = Object.keys(stats.categories).length;
      if (categoryCount < options.minCategories) {
        errors.push(
          `Candidate catalog contains ${categoryCount} categories, below minimum threshold of ${options.minCategories}.`
        );
      }
    }

    // Sweep ratio check (if maxSweepRatio configured)
    const sweepRatio = totalProducts > 0 ? outOfStockCount / totalProducts : 0;
    if (options?.maxSweepRatio !== undefined && totalProducts > 0) {
      if (sweepRatio > options.maxSweepRatio) {
        errors.push(
          `Stale sweep ratio ${(sweepRatio * 100).toFixed(1)}% exceeds maximum allowed threshold of ${(options.maxSweepRatio * 100).toFixed(1)}%.`
        );
      }
    }

    const valid = errors.length === 0;
    return {
      valid,
      errors,
      warnings,
      stats,
      metrics: {
        totalProducts,
        schemaVersion: userVersion,
        priceErrors,
        corruptedUrls,
        wafDetections,
        duplicateUrls,
        sweepRatio
      }
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`Validation execution error: ${msg}`);
    return {
      valid: false,
      errors,
      warnings,
      stats,
      metrics: {
        totalProducts: stats.totalProducts,
        schemaVersion: 0,
        priceErrors: 0,
        corruptedUrls: 0,
        wafDetections: 0,
        duplicateUrls: 0,
        sweepRatio: 0
      }
    };
  }
}

/**
 * Asynchronously validates a candidate SQLite database file on disk.
 * Safely manages database connection lifecycle with read-only pragmas.
 */
export async function validateCandidateSnapshot(
  dbPath: string,
  options?: SnapshotValidationOptions
): Promise<SnapshotValidationResult> {
  const stats: SnapshotValidationStats = {
    totalProducts: 0,
    inStockProducts: 0,
    categories: {},
    retailers: {},
    countries: {},
    duplicateUrls: 0
  };

  if (!fs.existsSync(dbPath)) {
    return {
      valid: false,
      errors: [`Database file does not exist: ${dbPath}`],
      warnings: [],
      stats,
      metrics: {
        totalProducts: 0,
        schemaVersion: 0,
        priceErrors: 0,
        corruptedUrls: 0,
        wafDetections: 0,
        duplicateUrls: 0,
        sweepRatio: 0
      }
    };
  }

  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    return validateCandidateSnapshotSync(db, options);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      valid: false,
      errors: [`Failed to open candidate database: ${msg}`],
      warnings: [],
      stats,
      metrics: {
        totalProducts: 0,
        schemaVersion: 0,
        priceErrors: 0,
        corruptedUrls: 0,
        wafDetections: 0,
        duplicateUrls: 0,
        sweepRatio: 0
      }
    };
  } finally {
    if (db && db.open) {
      db.close();
    }
  }
}
