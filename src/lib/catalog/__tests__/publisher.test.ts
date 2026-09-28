/**
 * src/lib/catalog/__tests__/publisher.test.ts
 *
 * Unit tests for the Turso catalog publisher engine and schema definitions.
 * Tests snapshot validation gate enforcement, dryRun short-circuit, mock Turso Client
 * batch upserting, catalog_runs audit tracking, and fail-closed error recovery.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createClient, type Client, type InStatement, type ResultSet, type Transaction } from "@libsql/client";
import {
  publishCatalogSnapshot,
  computeDatabaseHash
} from "../publisher";
import {
  ensureTursoSchema,
  TURSO_CATALOG_DDL,
  PRODUCTS_TABLE_DDL,
  CATALOG_RUNS_TABLE_DDL
} from "../turso-schema";

interface MockTursoClient extends Client {
  executed: Array<{ sql: string; args?: unknown[] }>;
  batches: Array<Array<{ sql: string; args?: unknown[] }>>;
  catalogRuns: Array<Record<string, unknown>>;
  shouldFailBatch?: boolean;
  shouldFailExecute?: boolean;
  batchFailureMessage?: string;
  executeFailureMessage?: string;
  isClosed?: boolean;
}

function createMockClient(): MockTursoClient {
  const executed: Array<{ sql: string; args?: unknown[] }> = [];
  const batches: Array<Array<{ sql: string; args?: unknown[] }>> = [];
  const catalogRuns: Array<Record<string, unknown>> = [];

  const client: MockTursoClient = {
    executed,
    batches,
    catalogRuns,
    shouldFailBatch: false,
    shouldFailExecute: false,
    batchFailureMessage: "Remote batch write rejected",
    executeFailureMessage: "Remote execution failed",
    isClosed: false,
    protocol: "http",
    execute: (async (stmt: InStatement): Promise<ResultSet> => {
      if (client.isClosed) throw new Error("Client is closed");
      if (client.shouldFailExecute) throw new Error(client.executeFailureMessage);

      const sql = typeof stmt === "string" ? stmt : stmt.sql;
      const args = typeof stmt === "object" && "args" in stmt ? (stmt.args as unknown[]) : undefined;
      executed.push({ sql, args });

      const upper = sql.trim().toUpperCase();
      if (upper.startsWith("INSERT INTO CATALOG_RUNS")) {
        catalogRuns.push({ sql, args });
        return {
          columns: [],
          columnTypes: [],
          rows: [],
          rowsAffected: 1,
          lastInsertRowid: undefined,
          toJSON: () => []
        };
      }

      return {
        columns: [],
        columnTypes: [],
        rows: [],
        rowsAffected: 0,
        lastInsertRowid: undefined,
        toJSON: () => []
      };
    }) as Client["execute"],
    async batch(statements: InStatement[]): Promise<ResultSet[]> {
      if (client.isClosed) throw new Error("Client is closed");
      if (client.shouldFailBatch) {
        throw new Error(client.batchFailureMessage);
      }

      const recordedBatch: Array<{ sql: string; args?: unknown[] }> = [];
      const results: ResultSet[] = [];

      for (const stmt of statements) {
        const sql = typeof stmt === "string" ? stmt : stmt.sql;
        const args = typeof stmt === "object" && "args" in stmt ? (stmt.args as unknown[]) : undefined;
        recordedBatch.push({ sql, args });
        results.push(await client.execute(stmt));
      }

      batches.push(recordedBatch);
      return results;
    },
    async migrate() {
      return [];
    },
    async transaction() {
      if (client.isClosed) throw new Error("Client is closed");
      let txClosed = false;
      const tx = {
        execute: async (stmt: InStatement) => {
          if (client.isClosed || txClosed) throw new Error("Transaction is closed");
          return await client.execute(stmt);
        },
        batch: async (statements: InStatement[]) => {
          if (client.isClosed || txClosed) throw new Error("Transaction is closed");
          return await client.batch(statements);
        },
        commit: async () => {
          if (client.isClosed || txClosed) throw new Error("Transaction is closed");
          txClosed = true;
        },
        rollback: async () => {
          if (client.isClosed || txClosed) throw new Error("Transaction is closed");
          txClosed = true;
        },
        close: () => { txClosed = true; },
        get closed() { return txClosed; },
        executeMultiple: async () => {}
      };
      return tx as unknown as Transaction;
    },
    async executeMultiple() {
      return undefined;
    },
    async sync() {
      return undefined;
    },
    get closed() {
      return Boolean(client.isClosed);
    },
    close() {
      client.isClosed = true;
    },
    async reconnect() {
      client.isClosed = false;
    }
  };

  return client;
}

interface TestProduct {
  id?: string;
  name?: string;
  normalized_name?: string;
  registry_key?: string;
  price?: number;
  currency?: string;
  country_code?: string;
  retailer?: string;
  url?: string;
  image_url?: string;
  in_stock?: number;
  category?: string;
  subcategory?: string;
  specs?: string;
  first_seen?: string;
  last_scraped?: string;
}

interface TestScrapeJob {
  country_code?: string;
  retailer: string;
  category?: string;
  status: "complete" | "partial" | "failed";
}

function createCandidateDatabase(
  products: TestProduct[] = [],
  options: { schemaVersion?: number; omitProductsTable?: boolean; jobs?: TestScrapeJob[] } = {}
): { dbPath: string; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "publisher-test-"));
  const dbPath = path.join(tmpDir, "candidate.db");
  const db = new Database(dbPath);
  db.pragma("journal_mode = MEMORY");
  db.pragma("synchronous = OFF");

  const version = options.schemaVersion ?? 5;
  db.pragma(`user_version = ${version}`);

  if (!options.omitProductsTable) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS products (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        normalized_name TEXT,
        registry_key TEXT,
        price REAL,
        currency TEXT NOT NULL,
        country_code TEXT NOT NULL,
        retailer TEXT NOT NULL,
        url TEXT NOT NULL,
        image_url TEXT,
        in_stock INTEGER DEFAULT 1,
        category TEXT NOT NULL,
        subcategory TEXT,
        specs TEXT,
        first_seen TEXT NOT NULL,
        last_scraped TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit_cache (
        pair_key TEXT PRIMARY KEY,
        verdict TEXT NOT NULL,
        checked_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS registry_research (
        key TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        specs TEXT NOT NULL,
        sources TEXT,
        confidence TEXT NOT NULL,
        researched_at TEXT NOT NULL
      );
    `);

    const insert = db.prepare(`
      INSERT INTO products (
        id, name, normalized_name, registry_key, price, currency,
        country_code, retailer, url, image_url, in_stock, category,
        subcategory, specs, first_seen, last_scraped
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMany = db.transaction((items: TestProduct[]) => {
      const now = new Date().toISOString();
      for (let i = 0; i < items.length; i++) {
        const p = items[i];
        insert.run(
          p.id ?? `prod-${i + 1}`,
          p.name ?? `Test CPU Component ${i + 1}`,
          p.normalized_name ?? `test cpu component ${i + 1}`,
          p.registry_key ?? "cpu-key",
          p.price !== undefined ? p.price : 199.99,
          p.currency ?? "USD",
          p.country_code ?? "US",
          p.retailer ?? "TestRetailer",
          p.url ?? `https://example.com/item-${i + 1}`,
          p.image_url ?? "https://example.com/img.jpg",
          p.in_stock !== undefined ? p.in_stock : 1,
          p.category ?? "cpu",
          p.subcategory ?? "desktop",
          p.specs ?? JSON.stringify({ cores: 8, threads: 16 }),
          p.first_seen ?? now,
          p.last_scraped ?? now
        );
      }
    });

    insertMany(products);
  }

  if (options.jobs) {
    // Mirrors SCRAPE_JOBS_DDL in scraper/db.py.
    db.exec(`
      CREATE TABLE scrape_jobs (
        country_code TEXT NOT NULL,
        retailer TEXT NOT NULL,
        category TEXT NOT NULL,
        status TEXT NOT NULL,
        finished_at TEXT NOT NULL,
        error TEXT,
        PRIMARY KEY (country_code, retailer, category)
      );
    `);
    const insertJob = db.prepare(
      "INSERT INTO scrape_jobs (country_code, retailer, category, status, finished_at) VALUES (?, ?, ?, ?, ?)"
    );
    for (const job of options.jobs) {
      insertJob.run(job.country_code ?? "US", job.retailer, job.category ?? "cpu", job.status, new Date().toISOString());
    }
  }

  db.close();

  return {
    dbPath,
    cleanup: () => {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  };
}

describe("Publisher Engine & Turso Schema", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.TURSO_DATABASE_URL;
    delete process.env.TURSO_INGEST_TOKEN;
    delete process.env.TURSO_AUTH_TOKEN;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe("Turso Schema Definitions (turso-schema.ts)", () => {
    it("exports valid canonical DDL statements for products, runs, and indexes", () => {
      expect(PRODUCTS_TABLE_DDL).toContain("CREATE TABLE IF NOT EXISTS products");
      expect(CATALOG_RUNS_TABLE_DDL).toContain("CREATE TABLE IF NOT EXISTS catalog_runs");
      expect(TURSO_CATALOG_DDL.length).toBeGreaterThanOrEqual(6);

      const ddlTexts = TURSO_CATALOG_DDL.join("\n");
      expect(ddlTexts).toContain("idx_products_country_currency_cat");
      expect(ddlTexts).toContain("idx_products_lookup");
      expect(ddlTexts).toContain("idx_products_last_scraped");
      expect(ddlTexts).toContain("idx_catalog_runs_published_at");
    });

    it("ensureTursoSchema safely applies all DDL statements to client", async () => {
      const mockClient = createMockClient();
      await ensureTursoSchema(mockClient);

      expect(mockClient.executed.length).toBe(TURSO_CATALOG_DDL.length);
      const executedSqls = mockClient.executed.map((e) => e.sql);
      expect(executedSqls).toContain(PRODUCTS_TABLE_DDL);
      expect(executedSqls).toContain(CATALOG_RUNS_TABLE_DDL);
    });
  });

  describe("Snapshot Validation Guard (Gate Fail-Closed Guarantee)", () => {
    it("aborts before touching Turso client when candidate DB fails Gate 1 (version mismatch)", async () => {
      const { dbPath, cleanup } = createCandidateDatabase([{ id: "p1" }], { schemaVersion: 4 });
      const mockClient = createMockClient();

      const result = await publishCatalogSnapshot({
        dbPath,
        client: mockClient,
        validatorOptions: { minProducts: 1 }
      });

      expect(result.success).toBe(false);
      expect(result.publishedCount).toBe(0);
      expect(result.errors).toBeDefined();
      expect(result.errors!.some((e) => e.includes("schema version") || e.includes("Gate 1"))).toBe(true);

      // Verify Turso client was NOT touched at all
      expect(mockClient.executed.length).toBe(0);
      expect(mockClient.batches.length).toBe(0);
      expect(mockClient.catalogRuns.length).toBe(0);

      cleanup();
    });

    it("aborts before touching Turso client when candidate DB has zero products", async () => {
      const { dbPath, cleanup } = createCandidateDatabase([]);
      const mockClient = createMockClient();

      const result = await publishCatalogSnapshot({
        dbPath,
        client: mockClient
      });

      expect(result.success).toBe(false);
      expect(result.publishedCount).toBe(0);
      expect(result.errors!.some((e) => e.includes("0 products") || e.includes("below minimum"))).toBe(true);

      expect(mockClient.executed.length).toBe(0);
      expect(mockClient.batches.length).toBe(0);

      cleanup();
    });

    it("aborts before touching Turso client when candidate DB has corrupted price or WAF challenge", async () => {
      const { dbPath, cleanup } = createCandidateDatabase([
        { id: "bad1", price: -50 },
        { id: "bad2", name: "Attention Required! | Cloudflare" }
      ]);
      const mockClient = createMockClient();

      const result = await publishCatalogSnapshot({
        dbPath,
        client: mockClient,
        validatorOptions: { minProducts: 1 }
      });

      expect(result.success).toBe(false);
      expect(result.errors!.length).toBeGreaterThan(0);
      expect(mockClient.executed.length).toBe(0);

      cleanup();
    });
  });

  describe("Dry Run Execution", () => {
    it("succeeds without performing remote writes when dryRun is true", async () => {
      const { dbPath, cleanup } = createCandidateDatabase([
        { id: "dry1", name: "Dry Run Item 1" },
        { id: "dry2", name: "Dry Run Item 2" }
      ]);
      const mockClient = createMockClient();

      const result = await publishCatalogSnapshot({
        dbPath,
        dryRun: true,
        client: mockClient,
        validatorOptions: { minProducts: 1 }
      });

      expect(result.success).toBe(true);
      expect(result.dryRun).toBe(true);
      expect(result.publishedCount).toBe(0);
      expect(result.stats).toBeDefined();

      // Ensure Turso was never touched
      expect(mockClient.executed.length).toBe(0);
      expect(mockClient.batches.length).toBe(0);
      expect(mockClient.catalogRuns.length).toBe(0);

      cleanup();
    });
  });

  describe("Credential Resolution", () => {
    it("returns error when credentials are missing and no client is provided", async () => {
      const { dbPath, cleanup } = createCandidateDatabase([{ id: "p1" }]);

      const result = await publishCatalogSnapshot({
        dbPath,
        validatorOptions: { minProducts: 1 }
      });

      expect(result.success).toBe(false);
      expect(result.publishedCount).toBe(0);
      expect(result.errors!.some((e) => e.includes("Missing required Turso credentials"))).toBe(true);

      cleanup();
    });

    it("throws when credentials are missing and throwOnError is true", async () => {
      const { dbPath, cleanup } = createCandidateDatabase([{ id: "p1" }]);

      await expect(
        publishCatalogSnapshot({
          dbPath,
          throwOnError: true,
          validatorOptions: { minProducts: 1 }
        })
      ).rejects.toThrow("Missing required Turso credentials");

      cleanup();
    });
  });

  describe("Successful Publication Workflow", () => {
    it("successfully ensures schema, batch-upserts products, and records catalog_runs", async () => {
      const prods: TestProduct[] = [
        { id: "p-1", name: "AMD Ryzen 7 7800X3D", price: 349, category: "cpu" },
        { id: "p-2", name: "NVIDIA GeForce RTX 4070", price: 549, category: "gpu" },
        { id: "p-3", name: "Corsair Vengeance 32GB", price: 119, category: "ram" }
      ];
      const { dbPath, cleanup } = createCandidateDatabase(prods);
      const mockClient = createMockClient();

      const result = await publishCatalogSnapshot({
        dbPath,
        client: mockClient,
        validatorOptions: { minProducts: 1 }
      });

      expect(result.success).toBe(true);
      expect(result.publishedCount).toBe(3);
      expect(result.runId).toBeDefined();
      expect(result.runId).toMatch(/^run_\d+_[a-f0-9]{8}$/);

      // Verify DDL execution occurred
      const schemaSqls = mockClient.executed.map((e) => e.sql);
      expect(schemaSqls).toContain(PRODUCTS_TABLE_DDL);
      expect(schemaSqls).toContain(CATALOG_RUNS_TABLE_DDL);

      // Verify product batch upsert
      expect(mockClient.batches.length).toBeGreaterThan(0);
      const allBatchStmts = mockClient.batches.flat();
      expect(allBatchStmts.length).toBe(3);
      expect(allBatchStmts[0].sql).toContain("INSERT OR REPLACE INTO products");
      expect(allBatchStmts[0].args?.[0]).toBe("p-1");
      expect(allBatchStmts[1].args?.[0]).toBe("p-2");
      expect(allBatchStmts[2].args?.[0]).toBe("p-3");

      // Verify catalog_runs insert
      expect(mockClient.catalogRuns.length).toBe(1);
      const runEntry = mockClient.catalogRuns[0];
      expect(runEntry.sql).toContain("INSERT INTO catalog_runs");
      const args = runEntry.args as unknown[];
      expect(args[0]).toBe(result.runId); // id
      expect(typeof args[1]).toBe("string"); // published_at
      expect(args[2]).toBe(3); // product_count
      expect(typeof args[3]).toBe("string"); // source_db_hash
      expect(args[4]).toBe("success"); // status
      expect(typeof args[5]).toBe("string"); // metadata JSON

      cleanup();
    });

    it("respects custom batchSize when streaming records to Turso", async () => {
      const prods: TestProduct[] = Array.from({ length: 5 }, (_, i) => ({
        id: `batch-p-${i}`,
        name: `Component ${i}`
      }));
      const { dbPath, cleanup } = createCandidateDatabase(prods);
      const mockClient = createMockClient();

      const result = await publishCatalogSnapshot({
        dbPath,
        client: mockClient,
        batchSize: 2,
        validatorOptions: { minProducts: 1 }
      });

      expect(result.success).toBe(true);
      expect(result.publishedCount).toBe(5);

      // With 5 items and batchSize 2, expect 3 batches (2, 2, 1)
      expect(mockClient.batches.length).toBe(3);
      expect(mockClient.batches[0].length).toBe(2);
      expect(mockClient.batches[1].length).toBe(2);
      expect(mockClient.batches[2].length).toBe(1);

      cleanup();
    });
  });

  describe("Fail-Closed Behavior on Turso Write Errors", () => {
    it("handles batch write failure cleanly and does NOT record a successful run", async () => {
      const prods: TestProduct[] = [{ id: "fail-p1", name: "Failing Product" }];
      const { dbPath, cleanup } = createCandidateDatabase(prods);
      const mockClient = createMockClient();
      mockClient.shouldFailBatch = true;
      mockClient.batchFailureMessage = "Turso transaction write abort";

      const result = await publishCatalogSnapshot({
        dbPath,
        client: mockClient,
        validatorOptions: { minProducts: 1 }
      });

      expect(result.success).toBe(false);
      expect(result.publishedCount).toBe(0);
      expect(result.errors).toBeDefined();
      expect(result.errors![0]).toContain("Turso transaction write abort");

      // Crucial: Fail-closed guarantee: NO catalog_runs entry recorded!
      expect(mockClient.catalogRuns.length).toBe(0);

      cleanup();
    });

    it("rethrows error when throwOnError is true during batch failure", async () => {
      const prods: TestProduct[] = [{ id: "fail-p1", name: "Failing Product" }];
      const { dbPath, cleanup } = createCandidateDatabase(prods);
      const mockClient = createMockClient();
      mockClient.shouldFailBatch = true;
      mockClient.batchFailureMessage = "Fatal network partition during write";

      await expect(
        publishCatalogSnapshot({
          dbPath,
          client: mockClient,
          throwOnError: true,
          validatorOptions: { minProducts: 1 }
        })
      ).rejects.toThrow("Fatal network partition during write");

      // Verify no run audit was recorded
      expect(mockClient.catalogRuns.length).toBe(0);

      cleanup();
    });

    it("handles schema migration failure fail-closed", async () => {
      const prods: TestProduct[] = [{ id: "fail-schema", name: "Schema Fail Product" }];
      const { dbPath, cleanup } = createCandidateDatabase(prods);
      const mockClient = createMockClient();
      mockClient.shouldFailExecute = true;
      mockClient.executeFailureMessage = "DDL permissions denied";

      const result = await publishCatalogSnapshot({
        dbPath,
        client: mockClient,
        validatorOptions: { minProducts: 1 }
      });

      expect(result.success).toBe(false);
      expect(result.publishedCount).toBe(0);
      expect(result.errors![0]).toContain("DDL permissions denied");
      expect(mockClient.catalogRuns.length).toBe(0);

      cleanup();
    });
  });

  describe("computeDatabaseHash", () => {
    it("computes valid sha256 hex string for an existing file", () => {
      const { dbPath, cleanup } = createCandidateDatabase([{ id: "hash-test" }]);
      const hash = computeDatabaseHash(dbPath);

      expect(hash).toBeDefined();
      expect(hash).toMatch(/^[a-f0-9]{64}$/);

      cleanup();
    });

    it("returns null for non-existent file", () => {
      const hash = computeDatabaseHash("/path/to/nonexistent-file.db");
      expect(hash).toBeNull();
    });
  });

  describe("Atomic Transaction, Stale Sweeping & Zero-Row Retailer Resilience (libSQL in-memory)", () => {
    it("marks stale rows out of stock (in_stock = 0) without deleting them for active retailers", async () => {
      const client = createClient({ url: "file::memory:" });
      await ensureTursoSchema(client);

      const now = new Date().toISOString();
      // Pre-populate Turso with two products from RetailerA
      await client.execute({
        sql: `INSERT INTO products (id, name, currency, country_code, retailer, url, in_stock, category, first_seen, last_scraped)
              VALUES ('p-keep', 'Kept Item', 'USD', 'US', 'RetailerA', 'https://example.com/keep', 1, 'cpu', ?, ?),
                     ('p-stale', 'Stale Item', 'USD', 'US', 'RetailerA', 'https://example.com/stale', 1, 'cpu', ?, ?)`,
        args: [now, now, now, now]
      });

      // Candidate DB only has p-keep and a new product p-new (p-stale is missing from snapshot)
      const { dbPath, cleanup } = createCandidateDatabase(
        [
          { id: "p-keep", name: "Kept Item", retailer: "RetailerA" },
          { id: "p-new", name: "New Item", retailer: "RetailerA" }
        ],
        { jobs: [{ retailer: "RetailerA", status: "complete" }] }
      );

      const result = await publishCatalogSnapshot({
        dbPath,
        client,
        validatorOptions: { minProducts: 1 }
      });

      expect(result.success).toBe(true);
      expect(result.publishedCount).toBe(2);
      expect(result.staleCount).toBe(1);

      // Verify in Turso database:
      const rowsRes = await client.execute("SELECT id, in_stock FROM products ORDER BY id");
      const rows = rowsRes.rows;
      expect(rows.length).toBe(3); // p-stale was NOT deleted!

      const staleRow = rows.find((r) => r.id === "p-stale");
      const keepRow = rows.find((r) => r.id === "p-keep");
      const newRow = rows.find((r) => r.id === "p-new");

      expect(staleRow?.in_stock).toBe(0); // marked out of stock!
      expect(keepRow?.in_stock).toBe(1);
      expect(newRow?.in_stock).toBe(1);

      cleanup();
    });

    it("preserves listings for retailers with 0 rows in candidate DB and emits warning", async () => {
      const client = createClient({ url: "file::memory:" });
      await ensureTursoSchema(client);

      const now = new Date().toISOString();
      // Turso has products from RetailerA and RetailerB
      await client.execute({
        sql: `INSERT INTO products (id, name, currency, country_code, retailer, url, in_stock, category, first_seen, last_scraped)
              VALUES ('p-ret-b', 'Retailer B Product', 'USD', 'US', 'RetailerB', 'https://example.com/b', 1, 'cpu', ?, ?),
                     ('p-ret-a', 'Retailer A Product', 'USD', 'US', 'RetailerA', 'https://example.com/a', 1, 'cpu', ?, ?)`,
        args: [now, now, now, now]
      });

      // Candidate DB ONLY has products from RetailerA; RetailerB scrape failed (0 rows)
      const { dbPath, cleanup } = createCandidateDatabase([
        { id: "p-ret-a", name: "Retailer A Product", retailer: "RetailerA" },
        { id: "p-ret-a2", name: "Retailer A Second Product", retailer: "RetailerA" }
      ]);

      const result = await publishCatalogSnapshot({
        dbPath,
        client,
        validatorOptions: { minProducts: 1 }
      });

      expect(result.success).toBe(true);
      // Warning emitted for RetailerB
      expect(result.warnings?.some((w) => w.includes("Retailer \"RetailerB\" has 0 rows in candidate snapshot"))).toBe(true);

      // Verify RetailerB product was NOT swept or marked out of stock!
      const retBRow = (await client.execute("SELECT in_stock FROM products WHERE id = 'p-ret-b'")).rows[0];
      expect(retBRow.in_stock).toBe(1);

      cleanup();
    });

    it("rolls back entire transaction on write failure, leaving stale listings and new products untouched", async () => {
      const client = createClient({ url: "file::memory:" });
      await ensureTursoSchema(client);

      const now = new Date().toISOString();
      await client.execute({
        sql: `INSERT INTO products (id, name, currency, country_code, retailer, url, in_stock, category, first_seen, last_scraped)
              VALUES ('p-initial', 'Initial Product', 'USD', 'US', 'RetailerA', 'https://example.com/init', 1, 'cpu', ?, ?)`,
        args: [now, now]
      });

      const { dbPath, cleanup } = createCandidateDatabase([
        { id: "p-new-item", name: "Candidate Product", retailer: "RetailerA" }
      ]);

      // Intercept client.transaction to simulate failure before commit
      const origTransaction = client.transaction.bind(client);
      vi.spyOn(client, "transaction").mockImplementation(async (mode?: "write" | "read" | "deferred") => {
        const tx = await origTransaction(mode);
        const origBatch = tx.batch.bind(tx);
        tx.batch = async (stmts) => {
          await origBatch(stmts);
          throw new Error("Simulated network error during transaction batch write");
        };
        return tx;
      });

      const result = await publishCatalogSnapshot({
        dbPath,
        client,
        validatorOptions: { minProducts: 1 }
      });

      expect(result.success).toBe(false);
      expect(result.errors?.[0]).toContain("Simulated network error during transaction batch write");

      // Verify database state was completely rolled back:
      // 1. p-initial must STILL be in_stock = 1 (not swept to 0)
      const initialRow = (await client.execute("SELECT in_stock FROM products WHERE id = 'p-initial'")).rows[0];
      expect(initialRow.in_stock).toBe(1);

      // 2. p-new-item must NOT exist in database
      const newRows = (await client.execute("SELECT id FROM products WHERE id = 'p-new-item'")).rows;
      expect(newRows.length).toBe(0);

      // 3. No catalog_runs row must be recorded
      const runs = (await client.execute("SELECT id FROM catalog_runs")).rows;
      expect(runs.length).toBe(0);

      cleanup();
    });

    it("enforces drop-threshold gate against last successful catalog_runs product_count", async () => {
      const client = createClient({ url: "file::memory:" });
      await ensureTursoSchema(client);

      // Insert a previous successful catalog run with 100 products
      await client.execute({
        sql: `INSERT INTO catalog_runs (id, published_at, product_count, source_db_hash, status, metadata)
              VALUES ('run-prev', '2026-09-27T00:00:00.000Z', 100, 'hash123', 'success', '{}')`
      });

      // Create candidate DB with only 60 products (40% drop, exceeding 30% maxDropRatio)
      const prods = Array.from({ length: 60 }, (_, i) => ({
        id: `drop-p-${i}`,
        name: `Product ${i}`,
        retailer: "RetailerA"
      }));
      const { dbPath, cleanup } = createCandidateDatabase(prods);

      const result = await publishCatalogSnapshot({
        dbPath,
        client
      });

      expect(result.success).toBe(false);
      expect(result.errors?.some((e) => e.includes("40.0%") && e.includes("baseline 100"))).toBe(true);

      // Turso products table must have 0 products published
      const productsInTurso = (await client.execute("SELECT COUNT(*) as count FROM products")).rows[0];
      expect(productsInTurso.count).toBe(0);

      cleanup();
    });

    it("fails closed and publishes nothing when transaction is unavailable or throws", async () => {
      // 1. Transaction unavailable (not a function / missing)
      const { dbPath: dbPath1, cleanup: cleanup1 } = createCandidateDatabase([
        { id: "p-no-tx", name: "No Transaction Product", retailer: "RetailerA" }
      ]);
      const mockClientNoTx = createMockClient();
      // @ts-expect-error simulating client without transaction support
      delete mockClientNoTx.transaction;

      const resultNoTx = await publishCatalogSnapshot({
        dbPath: dbPath1,
        client: mockClientNoTx,
        validatorOptions: { minProducts: 1 }
      });

      expect(resultNoTx.success).toBe(false);
      expect(resultNoTx.publishedCount).toBe(0);
      expect(resultNoTx.errors).toBeDefined();
      expect(resultNoTx.errors![0]).toContain("transactions");
      expect(mockClientNoTx.batches.length).toBe(0);
      expect(mockClientNoTx.catalogRuns.length).toBe(0);
      cleanup1();

      // 2. Transaction rejected / throws
      const { dbPath: dbPath2, cleanup: cleanup2 } = createCandidateDatabase([
        { id: "p-tx-throws", name: "Tx Throws Product", retailer: "RetailerA" }
      ]);
      const mockClientTxThrows = createMockClient();
      vi.spyOn(mockClientTxThrows, "transaction").mockRejectedValue(
        new Error("Turso transaction lock timeout")
      );

      const resultTxThrows = await publishCatalogSnapshot({
        dbPath: dbPath2,
        client: mockClientTxThrows,
        validatorOptions: { minProducts: 1 }
      });

      expect(resultTxThrows.success).toBe(false);
      expect(resultTxThrows.publishedCount).toBe(0);
      expect(resultTxThrows.errors).toBeDefined();
      expect(resultTxThrows.errors![0]).toContain("Turso transaction lock timeout");
      expect(mockClientTxThrows.batches.length).toBe(0);
      expect(mockClientTxThrows.catalogRuns.length).toBe(0);

      // Verify throwOnError also propagates the rejection
      await expect(
        publishCatalogSnapshot({
          dbPath: dbPath2,
          client: mockClientTxThrows,
          throwOnError: true,
          validatorOptions: { minProducts: 1 }
        })
      ).rejects.toThrow("Turso transaction lock timeout");

      cleanup2();
    });

    it("scopes stale sweep by (country_code, retailer) so sweeping retailer in country Y does not sweep in country Z", async () => {
      const client = createClient({ url: "file::memory:" });
      await ensureTursoSchema(client);

      const now = new Date().toISOString();
      // Seed Turso with Amazon products across two countries:
      // Amazon US: 2 products (in_stock = 1)
      // Amazon IN: 2 products (in_stock = 1)
      await client.execute({
        sql: `INSERT INTO products (id, name, currency, country_code, retailer, url, in_stock, category, first_seen, last_scraped)
              VALUES ('amz-us-1', 'Amazon US Laptop', 'USD', 'US', 'Amazon', 'https://amazon.com/us1', 1, 'cpu', ?, ?),
                     ('amz-us-2', 'Amazon US GPU', 'USD', 'US', 'Amazon', 'https://amazon.com/us2', 1, 'gpu', ?, ?),
                     ('amz-in-keep', 'Amazon IN CPU', 'INR', 'IN', 'Amazon', 'https://amazon.in/cpu', 1, 'cpu', ?, ?),
                     ('amz-in-stale', 'Amazon IN Stale Item', 'INR', 'IN', 'Amazon', 'https://amazon.in/stale', 1, 'cpu', ?, ?)`,
        args: [now, now, now, now, now, now, now, now]
      });

      // Candidate DB is an IN snapshot:
      // - amz-in-keep is present
      // - amz-in-new is a newly added item
      // - amz-in-stale is omitted (should be swept)
      // - amz-us-1 and amz-us-2 are not in this candidate DB at all
      const { dbPath, cleanup } = createCandidateDatabase(
        [
          { id: "amz-in-keep", name: "Amazon IN CPU", currency: "INR", country_code: "IN", retailer: "Amazon" },
          { id: "amz-in-new", name: "Amazon IN New RAM", currency: "INR", country_code: "IN", retailer: "Amazon" }
        ],
        { jobs: [{ country_code: "IN", retailer: "Amazon", status: "complete" }] }
      );

      const result = await publishCatalogSnapshot({
        dbPath,
        client,
        validatorOptions: { minProducts: 1 }
      });

      expect(result.success).toBe(true);
      expect(result.publishedCount).toBe(2);
      expect(result.staleCount).toBe(1);

      // Verify Turso state:
      const allRows = (
        await client.execute("SELECT id, country_code, retailer, in_stock FROM products ORDER BY id")
      ).rows;

      const us1 = allRows.find((r) => r.id === "amz-us-1");
      const us2 = allRows.find((r) => r.id === "amz-us-2");
      const inKeep = allRows.find((r) => r.id === "amz-in-keep");
      const inNew = allRows.find((r) => r.id === "amz-in-new");
      const inStale = allRows.find((r) => r.id === "amz-in-stale");

      // IN sweep correctly swept the omitted IN product
      expect(inStale?.in_stock).toBe(0);
      expect(inKeep?.in_stock).toBe(1);
      expect(inNew?.in_stock).toBe(1);

      // CRITICAL: US Amazon products MUST NOT be swept! They must remain in_stock = 1
      expect(us1?.in_stock).toBe(1);
      expect(us2?.in_stock).toBe(1);

      cleanup();
    });

    it("sweeps only (country, retailer, category) scopes whose scrape job is complete", async () => {
      const client = createClient({ url: "file::memory:" });
      await ensureTursoSchema(client);

      const now = new Date().toISOString();
      await client.execute({
        sql: `INSERT INTO products (id, name, currency, country_code, retailer, url, in_stock, category, first_seen, last_scraped)
              VALUES ('cpu-keep', 'CPU Keep', 'INR', 'IN', 'Shop', 'https://shop.in/cpu-keep', 1, 'cpu', ?, ?),
                     ('cpu-gone', 'CPU Gone', 'INR', 'IN', 'Shop', 'https://shop.in/cpu-gone', 1, 'cpu', ?, ?),
                     ('gpu-keep', 'GPU Keep', 'INR', 'IN', 'Shop', 'https://shop.in/gpu-keep', 1, 'gpu', ?, ?),
                     ('gpu-unseen', 'GPU Unseen', 'INR', 'IN', 'Shop', 'https://shop.in/gpu-unseen', 1, 'gpu', ?, ?),
                     ('ram-unseen', 'RAM Unseen', 'INR', 'IN', 'Shop', 'https://shop.in/ram-unseen', 1, 'ram', ?, ?),
                     ('psu-unseen', 'PSU Unseen', 'INR', 'IN', 'Shop', 'https://shop.in/psu-unseen', 1, 'psu', ?, ?)`,
        args: Array(12).fill(now)
      });

      const base = { currency: "INR", country_code: "IN", retailer: "Shop" };
      const { dbPath, cleanup } = createCandidateDatabase(
        [
          { ...base, id: "cpu-keep", category: "cpu" },
          { ...base, id: "gpu-keep", category: "gpu" },
          { ...base, id: "ram-seen", category: "ram" }
        ],
        {
          jobs: [
            { country_code: "IN", retailer: "Shop", category: "cpu", status: "complete" },
            { country_code: "IN", retailer: "Shop", category: "gpu", status: "partial" },
            { country_code: "IN", retailer: "Shop", category: "ram", status: "failed" }
            // psu: no job recorded at all
          ]
        }
      );

      const result = await publishCatalogSnapshot({ dbPath, client, validatorOptions: { minProducts: 1 } });

      expect(result.success).toBe(true);
      expect(result.staleCount).toBe(1);
      const stock = Object.fromEntries(
        (await client.execute("SELECT id, in_stock FROM products")).rows.map((r) => [String(r.id), Number(r.in_stock)])
      );
      expect(stock["cpu-gone"]).toBe(0); // complete scope: retired
      expect(stock["gpu-unseen"]).toBe(1); // partial scope: untouched
      expect(stock["ram-unseen"]).toBe(1); // failed scope: untouched
      expect(stock["psu-unseen"]).toBe(1); // no job: untouched
      expect(result.warnings?.some((w) => w.includes("IN/Shop/gpu is partial"))).toBe(true);

      cleanup();
    });

    it("marks nothing out of stock when the snapshot has no scrape_jobs table", async () => {
      const client = createClient({ url: "file::memory:" });
      await ensureTursoSchema(client);

      const now = new Date().toISOString();
      await client.execute({
        sql: `INSERT INTO products (id, name, currency, country_code, retailer, url, in_stock, category, first_seen, last_scraped)
              VALUES ('old', 'Old Item', 'USD', 'US', 'RetailerA', 'https://example.com/old', 1, 'cpu', ?, ?)`,
        args: [now, now]
      });
      const { dbPath, cleanup } = createCandidateDatabase([{ id: "new", retailer: "RetailerA" }]);

      const result = await publishCatalogSnapshot({ dbPath, client, validatorOptions: { minProducts: 1 } });

      expect(result.success).toBe(true);
      expect(result.staleCount).toBe(0);
      expect((await client.execute("SELECT in_stock FROM products WHERE id = 'old'")).rows[0].in_stock).toBe(1);
      expect(result.warnings?.some((w) => w.includes("no scrape_jobs table"))).toBe(true);

      cleanup();
    });
  });
});
