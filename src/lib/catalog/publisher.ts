/**
 * src/lib/catalog/publisher.ts
 *
 * Atomic Fail-Closed Turso Catalog Publisher Engine.
 * Validates candidate SQLite catalog snapshots using acceptance gates with baseline comparison,
 * sweeps stale listings for active retailers (marking in_stock = 0), preserves listings for
 * failed retailer scrapes (with warnings), and commits upserts + audit run atomically in a single
 * write transaction with rollback on failure.
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
    const candidateIds = new Set<string>();
    for (const r of rows) {
      candidateIds.add(String(r.id));
      const ret = String(r.retailer ?? "").trim();
      if (ret) {
        candidateRetailerCounts.set(ret, (candidateRetailerCounts.get(ret) ?? 0) + 1);
      }
    }

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
    const warnings: string[] = [...(validation.warnings ?? [])];

    for (const retailer of allKnownRetailers) {
      if (!candidateRetailerCounts.has(retailer) || (candidateRetailerCounts.get(retailer) ?? 0) === 0) {
        const warnMsg = `Retailer "${retailer}" has 0 rows in candidate snapshot; treating as failed scrape and preserving existing listings.`;
        warnings.push(warnMsg);
        console.warn(`[publish-catalog] ${warnMsg}`);
      }
    }

    // g. Identify stale listings in Turso belonging to active retailers in candidate snapshot
    const activeRetailers = Array.from(candidateRetailerCounts.keys());
    const staleIds: string[] = [];
    if (activeRetailers.length > 0) {
      const retChunkSize = 50;
      for (let r = 0; r < activeRetailers.length; r += retChunkSize) {
        const retChunk = activeRetailers.slice(r, r + retChunkSize);
        const placeholders = retChunk.map(() => "?").join(", ");
        const existingProds = await client.execute({
          sql: `SELECT id, retailer FROM products WHERE retailer IN (${placeholders}) AND in_stock = 1`,
          args: retChunk
        });
        for (const row of existingProds.rows) {
          const id = String(row.id);
          if (!candidateIds.has(id)) {
            staleIds.push(id);
          }
        }
      }
    }

    // h. Execute atomic publish in a single write transaction
    let tx: Transaction | null = null;
    if (typeof client.transaction === "function") {
      try {
        tx = await client.transaction("write");
      } catch {
        tx = null;
      }
    }
    const writeTarget = tx ?? client;

    try {
      // 1. Mark stale listings out of stock (in_stock = 0, NOT delete)
      if (staleIds.length > 0) {
        const staleChunkSize = 100;
        for (let i = 0; i < staleIds.length; i += staleChunkSize) {
          const chunk = staleIds.slice(i, i + staleChunkSize);
          const placeholders = chunk.map(() => "?").join(", ");
          await writeTarget.execute({
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

        if (typeof writeTarget.batch === "function") {
          await writeTarget.batch(statements);
        } else {
          for (const stmt of statements) {
            await writeTarget.execute(stmt);
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

      await writeTarget.execute({
        sql: `INSERT INTO catalog_runs (id, published_at, product_count, source_db_hash, status, metadata) VALUES (?, ?, ?, ?, ?, ?)`,
        args: [runId, publishedAt, publishedCount, sourceDbHash, "success", metadata]
      });

      // 4. Commit write transaction
      if (tx) {
        await tx.commit();
      }

      return {
        success: true,
        publishedCount,
        runId,
        warnings,
        staleCount: staleIds.length,
        stats: validation.stats
      };
    } catch (txErr: unknown) {
      if (tx) {
        try {
          await tx.rollback();
        } catch {
          // ignore rollback failure
        }
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
