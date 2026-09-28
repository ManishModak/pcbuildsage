/**
 * src/lib/catalog/publisher.ts
 *
 * Atomic Fail-Closed Turso Catalog Publisher Engine.
 * Validates candidate SQLite catalog snapshots using acceptance gates with baseline comparison,
 * sweeps stale listings (marking in_stock = 0) only for (country, retailer, category) scopes whose
 * scrape job the scraper recorded as 'complete' in `scrape_jobs`, preserves listings for partial,
 * failed or unrecorded scopes (with warnings), and commits upserts + audit run atomically in a
 * single write transaction with rollback on failure.
 */

import { createClient, type Client, type InStatement, type Transaction } from "@libsql/client";
import Database from "better-sqlite3";
import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs";
import {
  validateCandidateSnapshot,
  type SnapshotValidationOptions,
  type SnapshotValidationResult
} from "./snapshot-validator";
import { ensureTursoSchema } from "./turso-schema";

export interface PublishOptions {
  dbPath: string;
  tursoUrl?: string;
  tursoToken?: string;
  dryRun?: boolean;
  force?: boolean;
  batchSize?: number;
  expectedRetailers?: string[];
  validatorOptions?: SnapshotValidationOptions;
  client?: Client;
  throwOnError?: boolean;
  /**
   * In-stock rows of a scope that isn't marked complete (partial, failed or
   * unrecorded) are kept, unless no scrape has seen them for this many days.
   * Without this, a category that never completes (e.g. more pages than its
   * page limit) would keep showing sold-out listings forever. Default 7.
   */
  staleAfterDays?: number;
}

export interface PublishResult {
  success: boolean;
  publishedCount: number;
  runId?: string;
  dryRun?: boolean;
  errors?: string[];
  warnings?: string[];
  staleCount?: number;
  stats?: unknown;
}

/**
 * Computes a SHA-256 hash of the SQLite database file for audit traceability.
 */
export function computeDatabaseHash(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const buffer = fs.readFileSync(filePath);
    return createHash("sha256").update(buffer).digest("hex");
  } catch {
    return null;
  }
}

/**
 * Retrieves the product count from the last successful catalog run in Turso.
 */
export async function getLastSuccessfulProductCount(client: Client): Promise<number | undefined> {
  try {
    const res = await client.execute(
      "SELECT product_count FROM catalog_runs WHERE status = 'success' ORDER BY published_at DESC LIMIT 1"
    );
    if (res.rows.length > 0 && typeof res.rows[0].product_count === "number") {
      return res.rows[0].product_count;
    }
  } catch {
    // Table may not exist yet or catalog is empty
  }
  return undefined;
}

/** A (country, retailer, category) scope the scraper crawled end to end. */
export interface SweepScope {
  countryCode: string;
  retailer: string;
  category: string;
}

/**
 * Reads the scopes whose latest scrape job is 'complete' from the candidate
 * DB's `scrape_jobs` table, plus warnings for scopes that are not. Only these
 * scopes may have unseen Turso rows marked out of stock: a partial or failed
 * job never saw the whole listing. A missing table means no scope is safe.
 */
export function readSweepScopes(db: Database.Database): { scopes: SweepScope[]; warnings: string[] } {
  const hasTable = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'scrape_jobs'")
    .get();
  if (!hasTable) {
    return {
      scopes: [],
      warnings: ["Candidate snapshot has no scrape_jobs table; no listings will be marked out of stock."]
    };
  }
  const jobs = db
    .prepare("SELECT country_code, retailer, category, status FROM scrape_jobs")
    .all() as Array<{ country_code: string; retailer: string; category: string; status: string }>;
  const scopes: SweepScope[] = [];
  const warnings: string[] = [];
  for (const job of jobs) {
    if (job.status === "complete") {
      scopes.push({ countryCode: job.country_code, retailer: job.retailer, category: job.category });
    } else {
      warnings.push(
        `Scrape job ${job.country_code}/${job.retailer}/${job.category} is ${job.status}; preserving its existing listings.`
      );
    }
  }
  return { scopes, warnings };
}

function scopeKey(countryCode: string, retailer: string, category: string): string {
  return JSON.stringify([countryCode, retailer, category]);
}

/**
 * Publishes a candidate SQLite database snapshot to Turso cloud.
 */
export async function publishCatalogSnapshot(
  options: PublishOptions
): Promise<PublishResult> {
  const startTime = Date.now();

  // a. Validate candidate SQLite snapshot against acceptance gates before touching remote client
  const validation: SnapshotValidationResult = await validateCandidateSnapshot(
    options.dbPath,
    options.validatorOptions
  );

  if (!validation.valid && !options.force) {
    return {
      success: false,
      publishedCount: 0,
      errors: validation.errors,
      warnings: validation.warnings,
      stats: validation.stats
    };
  }

  // b. Dry run mode short-circuit (before performing any remote writes or schema updates)
  if (options.dryRun) {
    return {
      success: true,
      publishedCount: 0,
      dryRun: true,
      warnings: validation.warnings,
      stats: validation.stats
    };
  }

  // c. Resolve Turso credentials
  let client = options.client;
  let shouldCloseClient = false;

  if (!client) {
    const tursoUrl = options.tursoUrl ?? process.env.TURSO_DATABASE_URL;
    const tursoToken =
      options.tursoToken ??
      process.env.TURSO_INGEST_TOKEN ??
      process.env.TURSO_AUTH_TOKEN;

    if (!tursoUrl || !tursoUrl.trim() || !tursoToken || !tursoToken.trim()) {
      const errorMsg =
        "Missing required Turso credentials: URL and auth token must be provided " +
        "via options or environment variables (TURSO_DATABASE_URL and TURSO_INGEST_TOKEN/TURSO_AUTH_TOKEN).";

      if (options.throwOnError) {
        throw new Error(errorMsg);
      }

      return {
        success: false,
        publishedCount: 0,
        errors: [errorMsg]
      };
    }

    try {
      client = createClient({
        url: tursoUrl,
        authToken: tursoToken
      });
      shouldCloseClient = true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (options.throwOnError) throw err;
      return {
        success: false,
        publishedCount: 0,
        errors: [`Failed to create Turso client: ${msg}`]
      };
    }
  }

  // d. Ensure Turso schema exists
  try {
    await ensureTursoSchema(client);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (options.throwOnError) throw err;
    return {
      success: false,
      publishedCount: 0,
      errors: [`Failed to ensure Turso schema: ${msg}`]
    };
  }

  // e. Evaluate drop-threshold gate against last successful run in catalog_runs if baseline wasn't passed explicitly
  if (options.validatorOptions?.baselineProductCount === undefined && !options.force) {
    const lastProductCount = await getLastSuccessfulProductCount(client);
    if (lastProductCount !== undefined && lastProductCount > 0) {
      const maxDropRatio = options.validatorOptions?.maxDropRatio ?? 0.3;
      if (validation.stats.totalProducts < lastProductCount) {
        const dropRatio = (lastProductCount - validation.stats.totalProducts) / lastProductCount;
        if (dropRatio > maxDropRatio) {
          const dropError = `Product count dropped by ${(dropRatio * 100).toFixed(1)}% (${validation.stats.totalProducts} vs baseline ${lastProductCount}), exceeding max allowed drop of ${(maxDropRatio * 100).toFixed(1)}%.`;
          if (options.throwOnError) {
            throw new Error(dropError);
          }
          return {
            success: false,
            publishedCount: 0,
            errors: [dropError],
            warnings: validation.warnings,
            stats: validation.stats
          };
        }
      }
    }
  }

  let sqliteDb: Database.Database | null = null;

  try {
    // e. Read candidate SQLite database rows
    sqliteDb = new Database(options.dbPath, {
      readonly: true,
      fileMustExist: true
    });

    const rows = sqliteDb
      .prepare("SELECT * FROM products")
      .all() as Array<Record<string, unknown>>;

    const candidateRetailerCounts = new Map<string, number>();
    const candidateScopeKeys = new Set<string>();
    const candidateIds = new Set<string>();
    for (const r of rows) {
      candidateIds.add(String(r.id));
      const ret = String(r.retailer ?? "").trim();
      if (ret) {
        candidateRetailerCounts.set(ret, (candidateRetailerCounts.get(ret) ?? 0) + 1);
        candidateScopeKeys.add(
          scopeKey(String(r.country_code ?? "").trim(), ret, String(r.category ?? "").trim())
        );
      }
    }
    const sweep = readSweepScopes(sqliteDb);

    // f. Check for retailers in remote database (or expected retailers) that have 0 rows in candidate DB
    let existingRetailers: string[] = [];
    try {
      const retRes = await client.execute(
        "SELECT DISTINCT retailer FROM products WHERE retailer IS NOT NULL AND retailer != ''"
      );
      existingRetailers = retRes.rows.map((r) => String(r.retailer));
    } catch {
      // Table may be empty
    }

    const allKnownRetailers = new Set([...existingRetailers, ...(options.expectedRetailers ?? [])]);
    const warnings: string[] = [...(validation.warnings ?? []), ...sweep.warnings];

    for (const retailer of allKnownRetailers) {
      if (!candidateRetailerCounts.has(retailer) || (candidateRetailerCounts.get(retailer) ?? 0) === 0) {
        const warnMsg = `Retailer "${retailer}" has 0 rows in candidate snapshot; treating as failed scrape and preserving existing listings.`;
        warnings.push(warnMsg);
        console.warn(`[publish-catalog] ${warnMsg}`);
      }
    }

    // g. Identify stale listings: in-stock Turso rows of a completely crawled
    //    (country, retailer, category) scope that are missing from the snapshot.
    //    A complete scope with no snapshot rows is treated as suspect and kept.
    const activeScopes = sweep.scopes.filter((scope) =>
      candidateScopeKeys.has(scopeKey(scope.countryCode, scope.retailer, scope.category))
    );
    const staleIds: string[] = [];
    if (activeScopes.length > 0) {
      const scopeChunkSize = 25;
      for (let s = 0; s < activeScopes.length; s += scopeChunkSize) {
        const chunk = activeScopes.slice(s, s + scopeChunkSize);
        const placeholders = chunk
          .map(() => "(country_code = ? AND retailer = ? AND category = ?)")
          .join(" OR ");
        const args = chunk.flatMap((scope) => [scope.countryCode, scope.retailer, scope.category]);
        const existingProds = await client.execute({
          sql: `SELECT id FROM products WHERE (${placeholders}) AND in_stock = 1`,
          args
        });
        for (const row of existingProds.rows) {
          const id = String(row.id);
          if (!candidateIds.has(id)) {
            staleIds.push(id);
          }
        }
      }
    }

    // g2. Safety net for scopes that never complete: retire in-stock rows of the
    //     snapshot's countries that no scrape has seen for staleAfterDays.
    const snapshotCountries = [...new Set(rows.map((r) => String(r.country_code ?? "").trim()).filter(Boolean))];
    if (snapshotCountries.length > 0) {
      const cutoff = new Date(Date.now() - (options.staleAfterDays ?? 7) * 86_400_000).toISOString();
      const expired = await client.execute({
        sql: `SELECT id FROM products WHERE in_stock = 1 AND last_scraped < ? AND country_code IN (${snapshotCountries.map(() => "?").join(", ")})`,
        args: [cutoff, ...snapshotCountries]
      });
      const already = new Set(staleIds);
      for (const row of expired.rows) {
        const id = String(row.id);
        if (!candidateIds.has(id) && !already.has(id)) staleIds.push(id);
      }
    }

    // h. Execute atomic publish in a single write transaction (fail closed)
    if (typeof client.transaction !== "function") {
      throw new Error(
        "Turso client does not support transactions (client.transaction is not a function). Atomic publish aborted."
      );
    }

    const tx: Transaction = await client.transaction("write");

    try {
      // 1. Mark stale listings out of stock (in_stock = 0, NOT delete)
      if (staleIds.length > 0) {
        const staleChunkSize = 100;
        for (let i = 0; i < staleIds.length; i += staleChunkSize) {
          const chunk = staleIds.slice(i, i + staleChunkSize);
          const placeholders = chunk.map(() => "?").join(", ");
          await tx.execute({
            sql: `UPDATE products SET in_stock = 0 WHERE id IN (${placeholders})`,
            args: chunk
          });
        }
      }

      // 2. Batch upsert candidate products
      const batchSize = Math.max(1, options.batchSize ?? 100);
      let publishedCount = 0;

      const upsertSql = `INSERT OR REPLACE INTO products (
        id, name, normalized_name, registry_key, price, currency,
        country_code, retailer, url, image_url, in_stock, category,
        subcategory, specs, first_seen, last_scraped
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

      for (let i = 0; i < rows.length; i += batchSize) {
        const chunk = rows.slice(i, i + batchSize);
        const statements: InStatement[] = chunk.map((r) => ({
          sql: upsertSql,
          args: [
            String(r.id),
            String(r.name ?? ""),
            r.normalized_name != null ? String(r.normalized_name) : null,
            r.registry_key != null ? String(r.registry_key) : null,
            r.price != null ? Number(r.price) : null,
            String(r.currency ?? "USD"),
            String(r.country_code ?? "US"),
            String(r.retailer ?? ""),
            String(r.url ?? ""),
            r.image_url != null ? String(r.image_url) : null,
            Number(r.in_stock ?? 1) ? 1 : 0,
            String(r.category ?? ""),
            r.subcategory != null ? String(r.subcategory) : null,
            typeof r.specs === "object" && r.specs !== null
              ? JSON.stringify(r.specs)
              : r.specs != null
              ? String(r.specs)
              : null,
            String(r.first_seen ?? new Date().toISOString()),
            String(r.last_scraped ?? new Date().toISOString())
          ]
        }));

        if (typeof tx.batch === "function") {
          await tx.batch(statements);
        } else {
          for (const stmt of statements) {
            await tx.execute(stmt);
          }
        }

        publishedCount += chunk.length;
      }

      // 3. Write audit record to catalog_runs
      const runId = `run_${Date.now()}_${randomUUID().slice(0, 8)}`;
      const publishedAt = new Date().toISOString();
      const sourceDbHash = computeDatabaseHash(options.dbPath);

      const metadata = JSON.stringify({
        batchSize,
        durationMs: Date.now() - startTime,
        stats: validation.stats,
        warnings,
        staleCount: staleIds.length
      });

      await tx.execute({
        sql: `INSERT INTO catalog_runs (id, published_at, product_count, source_db_hash, status, metadata) VALUES (?, ?, ?, ?, ?, ?)`,
        args: [runId, publishedAt, publishedCount, sourceDbHash, "success", metadata]
      });

      // 4. Commit write transaction
      await tx.commit();

      return {
        success: true,
        publishedCount,
        runId,
        warnings,
        staleCount: staleIds.length,
        stats: validation.stats
      };
    } catch (txErr: unknown) {
      try {
        await tx.rollback();
      } catch {
        // ignore rollback failure
      }
      throw txErr;
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);

    if (options.throwOnError) {
      throw err;
    }

    return {
      success: false,
      publishedCount: 0,
      errors: [`Publish failed: ${msg}`]
    };
  } finally {
    if (sqliteDb && sqliteDb.open) {
      sqliteDb.close();
    }
    if (shouldCloseClient && client) {
      try {
        await client.close();
      } catch {
        // ignore client close errors
      }
    }
  }
}
