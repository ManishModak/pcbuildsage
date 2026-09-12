/**
 * src/lib/catalog/__tests__/publisher.test.ts
 *
 * Unit tests for the Turso catalog publisher engine and schema definitions.
 * Tests snapshot validation gate enforcement, dryRun short-circuit, mock Turso Client
 * batch upserting, catalog_runs audit tracking, and fail-closed error recovery.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Client, InStatement, ResultSet } from "@libsql/client";
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
      throw new Error("transaction not implemented in mock");
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

function createCandidateDatabase(
  products: TestProduct[] = [],
  options: { schemaVersion?: number; omitProductsTable?: boolean } = {}
): { dbPath: string; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "publisher-test-"));
  const dbPath = path.join(tmpDir, "candidate.db");
  const db = new Database(dbPath);

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

    for (let i = 0; i < products.length; i++) {
      const p = products[i];
      const now = new Date().toISOString();
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
});
