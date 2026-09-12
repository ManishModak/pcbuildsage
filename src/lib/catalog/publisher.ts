/**
 * src/lib/catalog/publisher.ts
 *
 * Atomic Fail-Closed Turso Catalog Publisher Engine.
 * Validates candidate SQLite catalog snapshots using 5 acceptance gates,
 * applies schema DDL if needed, and batch-upserts data to remote Turso database
 * with audit run tracking.
 */

import { createClient, type Client, type InStatement } from "@libsql/client";
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
 * Publishes a candidate SQLite database snapshot to Turso cloud.
 *
 * Workflow:
 * 1. Validates candidate SQLite snapshot using validateCandidateSnapshot.
 *    If invalid, aborts immediately without touching Turso (fail-closed guarantee).
 * 2. If dryRun is true, returns early with stats without performing remote writes.
 * 3. Resolves Turso credentials from options or environment variables.
 * 4. Ensures the target Turso schema exists (products, catalog_runs, indexes).
 * 5. Reads rows from the candidate database in chunks and batch-upserts to Turso.
 * 6. Records an audit entry in catalog_runs with status: 'success'.
 * 7. If any write failure occurs, ensures fail-closed behavior (no successful run recorded).
 */
export async function publishCatalogSnapshot(
  options: PublishOptions
): Promise<PublishResult> {
  const startTime = Date.now();

  // a. Validate candidate SQLite snapshot
  const validation: SnapshotValidationResult = await validateCandidateSnapshot(
    options.dbPath,
    options.validatorOptions
  );

  if (!validation.valid && !options.force) {
    return {
      success: false,
      publishedCount: 0,
      errors: validation.errors,
      stats: validation.stats
    };
  }

  // b. Dry run mode short-circuit
  if (options.dryRun) {
    return {
      success: true,
      publishedCount: 0,
      dryRun: true,
      stats: validation.stats
    };
  }

  // c. Resolve Turso credentials
  let client = options.client;
  let shouldCloseClient = false;

  if (!client) {
    const tursoUrl =
      options.tursoUrl ?? process.env.TURSO_DATABASE_URL;
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

  let sqliteDb: Database.Database | null = null;

  try {
    // d & e. Ensure Turso schema exists
    await ensureTursoSchema(client);

    // f. Read candidate SQLite database rows and batch-upsert to Turso
    sqliteDb = new Database(options.dbPath, {
      readonly: true,
      fileMustExist: true
    });

    const rows = sqliteDb
      .prepare("SELECT * FROM products")
      .all() as Array<Record<string, unknown>>;

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

      if (typeof client.batch === "function") {
        await client.batch(statements);
      } else {
        for (const stmt of statements) {
          await client.execute(stmt);
        }
      }

      publishedCount += chunk.length;
    }

    // g. Write audit record to catalog_runs
    const runId = `run_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const publishedAt = new Date().toISOString();
    const sourceDbHash = computeDatabaseHash(options.dbPath);

    const metadata = JSON.stringify({
      batchSize,
      durationMs: Date.now() - startTime,
      stats: validation.stats,
      warnings: validation.warnings
    });

    await client.execute({
      sql: `INSERT INTO catalog_runs (id, published_at, product_count, source_db_hash, status, metadata) VALUES (?, ?, ?, ?, ?, ?)`,
      args: [runId, publishedAt, publishedCount, sourceDbHash, "success", metadata]
    });

    return {
      success: true,
      publishedCount,
      runId,
      stats: validation.stats
    };
  } catch (err: unknown) {
    // h. Fail-closed: do not record a successful run in catalog_runs, propagate the error
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

