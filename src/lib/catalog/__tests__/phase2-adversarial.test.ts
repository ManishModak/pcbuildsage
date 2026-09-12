/**
 * src/lib/catalog/__tests__/phase2-adversarial.test.ts
 *
 * Rigorous adversarial verification and stress testing suite for Phase 2:
 * Snapshot Validator & Turso Publisher.
 *
 * Requirements:
 * 1. Fail-Closed Verification:
 *    - Verify invalid candidate databases (zero products, WAF challenge text like
 *      Cloudflare or 403 Forbidden, negative price, duplicate URLs, dropped count > 30%)
 *      abort immediately and NEVER invoke client.batch or write to catalog_runs.
 * 2. Network & Transaction Fault Tolerance:
 *    - Verify that if Turso client.batch fails midway (e.g. network disconnect or unique
 *      constraint failure), no record is created in catalog_runs and the operation
 *      rejects cleanly with exit code 1.
 * 3. Dry-Run Integrity:
 *    - Verify that passing dryRun: true performs full schema and product validation
 *      without initializing client writes or mutating remote state.
 * 4. End-to-End Success Path:
 *    - Verify that publishing a valid candidate SQLite database correctly writes rows
 *      into products and records an audit row in catalog_runs with status: 'success',
 *      SHA-256 hash, and product count.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Client, InStatement, ResultSet } from "@libsql/client";
import {
  publishCatalogSnapshot,
  computeDatabaseHash
} from "../publisher";
import { runPublishCatalog as runPublishCli } from "../../../../scripts/publish-catalog";
import {
  validateCandidateSnapshotSync,
  DATABASE_SCHEMA_VERSION,
  REQUIRED_COLUMNS
} from "../snapshot-validator";
import { PRODUCTS_TABLE_DDL, CATALOG_RUNS_TABLE_DDL } from "../turso-schema";

// ============================================================================
// Mock Turso Client with Adversarial Fault Injection
// ============================================================================

interface MockTursoController extends Client {
  executed: Array<{ sql: string; args?: unknown[] }>;
  batches: Array<Array<{ sql: string; args?: unknown[] }>>;
  catalogRuns: Array<{ sql: string; args?: unknown[] }>;
  batchCallsCount: number;
  shouldFailBatch: boolean;
  batchFailureMessage: string;
  failBatchAtIndex?: number;
  shouldFailExecute: boolean;
  executeFailureMessage: string;
  failOnCatalogRunsInsert?: boolean;
  isClosed: boolean;
  reset: () => void;
}

function createControllableTursoClient(): MockTursoController {
  const executed: Array<{ sql: string; args?: unknown[] }> = [];
  const batches: Array<Array<{ sql: string; args?: unknown[] }>> = [];
  const catalogRuns: Array<{ sql: string; args?: unknown[] }> = [];

  const client: MockTursoController = {
    executed,
    batches,
    catalogRuns,
    batchCallsCount: 0,
    shouldFailBatch: false,
    batchFailureMessage: "Simulated Turso remote batch rejection",
    failBatchAtIndex: undefined,
    shouldFailExecute: false,
    executeFailureMessage: "Simulated Turso execution error",
    failOnCatalogRunsInsert: false,
    isClosed: false,
    protocol: "http",

    reset() {
      executed.length = 0;
      batches.length = 0;
      catalogRuns.length = 0;
      client.batchCallsCount = 0;
      client.shouldFailBatch = false;
      client.failBatchAtIndex = undefined;
      client.shouldFailExecute = false;
      client.failOnCatalogRunsInsert = false;
      client.isClosed = false;
    },

    execute: (async (stmt: InStatement): Promise<ResultSet> => {
      if (client.isClosed) throw new Error("Client is closed");
      if (client.shouldFailExecute) throw new Error(client.executeFailureMessage);

      const sql = typeof stmt === "string" ? stmt : stmt.sql;
      const args = typeof stmt === "object" && "args" in stmt ? (stmt.args as unknown[]) : undefined;
      executed.push({ sql, args });

      const upper = sql.trim().toUpperCase();
      if (upper.startsWith("INSERT INTO CATALOG_RUNS")) {
        if (client.failOnCatalogRunsInsert) {
          throw new Error("Simulated disk full or failure during catalog_runs write");
        }
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

      const currentIndex = client.batchCallsCount++;

      if (client.shouldFailBatch) {
        throw new Error(client.batchFailureMessage);
      }

      if (client.failBatchAtIndex !== undefined && currentIndex === client.failBatchAtIndex) {
        throw new Error(`Simulated fault on batch index ${currentIndex}: ${client.batchFailureMessage}`);
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

// ============================================================================
// Test Product Generators & Database Helpers
// ============================================================================

interface CandidateProductRow {
  id?: string;
  name?: string;
  normalized_name?: string;
  registry_key?: string | null;
  price?: number | null | string;
  currency?: string;
  country_code?: string;
  retailer?: string;
  url?: string;
  image_url?: string | null;
  in_stock?: number | boolean;
  category?: string;
  subcategory?: string | null;
  specs?: string | null;
  first_seen?: string;
  last_scraped?: string;
}

const trackedTempDirs: string[] = [];

function createTempCandidateDb(
  products: CandidateProductRow[] = [],
  options: {
    schemaVersion?: number;
    omitProductsTable?: boolean;
    omitColumns?: string[];
  } = {}
): { dbPath: string; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "phase2-adv-"));
  trackedTempDirs.push(tmpDir);
  const dbPath = path.join(tmpDir, "candidate.db");
  const db = new Database(dbPath);

  const version = options.schemaVersion ?? DATABASE_SCHEMA_VERSION;
  db.pragma(`user_version = ${version}`);

  if (!options.omitProductsTable) {
    const columns = [
      "id TEXT PRIMARY KEY",
      "name TEXT NOT NULL",
      "normalized_name TEXT",
      "registry_key TEXT",
      "price REAL",
      "currency TEXT NOT NULL",
      "country_code TEXT NOT NULL",
      "retailer TEXT NOT NULL",
      "url TEXT NOT NULL",
      "image_url TEXT",
      "in_stock INTEGER DEFAULT 1",
      "category TEXT NOT NULL",
      "subcategory TEXT",
      "specs TEXT",
      "first_seen TEXT NOT NULL",
      "last_scraped TEXT NOT NULL"
    ].filter((colDef) => {
      if (!options.omitColumns) return true;
      const colName = colDef.split(" ")[0];
      return !options.omitColumns.includes(colName);
    });

    db.exec(`
      CREATE TABLE IF NOT EXISTS products (
        ${columns.join(",\n")}
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

    if (products.length > 0) {
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
          p.name ?? `Valid Test Component ${i + 1}`,
          p.normalized_name ?? `valid test component ${i + 1}`,
          p.registry_key ?? "cpu-key",
          p.price !== undefined ? p.price : 149.99,
          p.currency ?? "USD",
          p.country_code ?? "US",
          p.retailer ?? "RetailerPrime",
          p.url ?? `https://retailer.example.com/item-${i + 1}`,
          p.image_url ?? "https://example.com/img.jpg",
          p.in_stock !== undefined ? (p.in_stock ? 1 : 0) : 1,
          p.category ?? (i % 2 === 0 ? "cpu" : "gpu"),
          p.subcategory ?? "desktop",
          p.specs ?? JSON.stringify({ cores: 8, threads: 16 }),
          p.first_seen ?? now,
          p.last_scraped ?? now
        );
      }
    }
  }

  db.close();

  const cleanup = () => {
    try {
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    } catch {
      // ignore cleanup errors
    }
  };

  return { dbPath, cleanup };
}

function createBaselineDb(count: number): { baselinePath: string; cleanup: () => void } {
  const products: CandidateProductRow[] = Array.from({ length: count }, (_, i) => ({
    id: `base-${i + 1}`,
    name: `Baseline Component ${i + 1}`,
    price: 99.99 + i,
    category: i % 2 === 0 ? "cpu" : "gpu",
    url: `https://retailer.example.com/baseline-${i + 1}`
  }));
  const { dbPath, cleanup } = createTempCandidateDb(products);
  return { baselinePath: dbPath, cleanup };
}

function generatePristineProducts(count = 55): CandidateProductRow[] {
  const categories = ["cpu", "gpu", "motherboard", "ram", "storage"];
  const retailers = ["RetailerA", "RetailerB", "RetailerC"];

  return Array.from({ length: count }, (_, i) => ({
    id: `pristine-${i + 1}`,
    name: `Pristine Hardware Component ${i + 1}`,
    normalized_name: `pristine hardware component ${i + 1}`,
    registry_key: `key-${i + 1}`,
    price: 49.99 + (i % 50) * 10,
    currency: "USD",
    country_code: "US",
    retailer: retailers[i % retailers.length],
    url: `https://store.example.com/items/part-${i + 1}`,
    image_url: `https://store.example.com/images/part-${i + 1}.png`,
    in_stock: 1,
    category: categories[i % categories.length],
    subcategory: "desktop",
    specs: JSON.stringify({ index: i, verified: true })
  }));
}

// ============================================================================
// Phase 2 Adversarial Test Suite
// ============================================================================

describe("Phase 2 Adversarial Verification & Stress Testing Suite", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.TURSO_DATABASE_URL;
    delete process.env.TURSO_INGEST_TOKEN;
    delete process.env.TURSO_AUTH_TOKEN;
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
    for (const tmpDir of trackedTempDirs) {
      try {
        if (fs.existsSync(tmpDir)) {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        }
      } catch {
        // ignore cleanup error
      }
    }
    trackedTempDirs.length = 0;
  });

  // =========================================================================
  // 1. Fail-Closed Verification
  // =========================================================================
  describe("1. Fail-Closed Verification (Gate Integrity & Non-Invocation)", () => {
    it("rejects candidate database with 0 products and NEVER invokes client.batch or writes to catalog_runs", async () => {
      const { dbPath } = createTempCandidateDb([]);
      const mockClient = createControllableTursoClient();

      const result = await publishCatalogSnapshot({
        dbPath,
        client: mockClient
      });

      // Fail-closed assertions
      expect(result.success).toBe(false);
      expect(result.publishedCount).toBe(0);
      expect(result.errors).toBeDefined();
      expect(
        result.errors!.some((e) => e.includes("0 products") || e.includes("zero-product anomaly"))
      ).toBe(true);

      // Verify complete lack of remote writes
      expect(mockClient.batches.length).toBe(0);
      expect(mockClient.catalogRuns.length).toBe(0);
      expect(mockClient.executed.length).toBe(0);

      // Verify CLI runner also fails closed with exit code 1
      const exitCode = await runPublishCli([dbPath], { client: mockClient });
      expect(exitCode).toBe(1);
      expect(mockClient.batches.length).toBe(0);
      expect(mockClient.catalogRuns.length).toBe(0);
    });

    it("detects WAF challenge signatures ('Cloudflare', '403 Forbidden', etc.) and NEVER touches remote client", async () => {
      const wafTestCases: Array<{ name: string; url?: string; description: string }> = [
        { name: "Attention Required! | Cloudflare", description: "Cloudflare challenge title" },
        { name: "403 Forbidden - Access Blocked", description: "403 Forbidden error page" },
        { name: "Just a moment... Verify you are human", description: "Cloudflare Turnstile title" },
        { name: "Access Denied by Security Policy", description: "Access Denied signature" },
        { name: "DDoS-Guard Bot Detection Challenge", description: "DDoS-Guard signature" },
        { name: "DataDome CAPTCHA Protected", description: "DataDome bot detection" },
        {
          name: "Legit Component Name",
          url: "https://example.com/challenge-platform/h/b/orchestrate/chk_jschl",
          description: "WAF challenge-platform in URL"
        }
      ];

      for (const tc of wafTestCases) {
        const prods = [
          ...generatePristineProducts(49),
          {
            id: "waf-bad",
            name: tc.name,
            url: tc.url ?? "https://example.com/blocked",
            price: 99.99,
            category: "cpu"
          }
        ];
        const { dbPath } = createTempCandidateDb(prods);
        const mockClient = createControllableTursoClient();

        const result = await publishCatalogSnapshot({
          dbPath,
          client: mockClient,
          validatorOptions: { minProducts: 10 }
        });

        expect(result.success).toBe(false);
        expect(result.publishedCount).toBe(0);
        expect(
          result.errors!.some(
            (e) => e.includes("WAF challenge") || e.includes("CAPTCHA")
          )
        ).toBe(true);

        // Client must be 100% untouched
        expect(mockClient.batches.length).toBe(0);
        expect(mockClient.catalogRuns.length).toBe(0);
        expect(mockClient.executed.length).toBe(0);

        // CLI runner check
        const exitCode = await runPublishCli([dbPath], { client: mockClient });
        expect(exitCode).toBe(1);
        expect(mockClient.batches.length).toBe(0);
      }
    });

    it("rejects non-positive and corrupt prices (negative, zero, NaN) without invoking client writes", async () => {
      const corruptPrices = [-99.99, -0.01, 0, "NaN", null];

      for (const badPrice of corruptPrices) {
        const prods = [
          ...generatePristineProducts(49),
          {
            id: `corrupt-price-${String(badPrice)}`,
            price: badPrice as unknown as number
          }
        ];
        const { dbPath } = createTempCandidateDb(prods);
        const mockClient = createControllableTursoClient();

        const result = await publishCatalogSnapshot({
          dbPath,
          client: mockClient,
          validatorOptions: { minProducts: 10 }
        });

        expect(result.success).toBe(false);
        expect(result.publishedCount).toBe(0);
        expect(
          result.errors!.some((e) => e.includes("invalid or non-positive price"))
        ).toBe(true);

        expect(mockClient.batches.length).toBe(0);
        expect(mockClient.catalogRuns.length).toBe(0);
        expect(mockClient.executed.length).toBe(0);
      }
    });

    it("rejects candidate when duplicate URLs exceed threshold and aborts before remote execution", async () => {
      // 50 products where 10 have duplicate URLs (20% duplicate ratio > default 5% threshold)
      const baseProds = generatePristineProducts(40);
      const duplicateProds = Array.from({ length: 10 }, (_, i) => ({
        id: `dup-${i + 1}`,
        name: `Duplicate Part ${i + 1}`,
        price: 99.99,
        category: "cpu",
        url: "https://store.example.com/items/shared-collision-url"
      }));

      const { dbPath } = createTempCandidateDb([...baseProds, ...duplicateProds]);
      const mockClient = createControllableTursoClient();

      const result = await publishCatalogSnapshot({
        dbPath,
        client: mockClient,
        validatorOptions: { minProducts: 10 }
      });

      expect(result.success).toBe(false);
      expect(result.publishedCount).toBe(0);
      expect(
        result.errors!.some((e) => e.includes("Duplicate URL ratio"))
      ).toBe(true);

      // Verify zero interaction with Turso client
      expect(mockClient.batches.length).toBe(0);
      expect(mockClient.catalogRuns.length).toBe(0);
      expect(mockClient.executed.length).toBe(0);

      const exitCode = await runPublishCli([dbPath], { client: mockClient });
      expect(exitCode).toBe(1);
    });

    it("rejects catastrophic product drop (> 30% drop vs baseline) and prevents remote publication", async () => {
      // Baseline has 100 products. Candidate has 60 products (40% drop > 30% threshold).
      const { baselinePath } = createBaselineDb(100);
      const candidateProds = generatePristineProducts(60);
      const { dbPath } = createTempCandidateDb(candidateProds);
      const mockClient = createControllableTursoClient();

      // Test with baselineDbPath option
      const resultDisk = await publishCatalogSnapshot({
        dbPath,
        client: mockClient,
        validatorOptions: {
          baselineDbPath: baselinePath,
          maxDropRatio: 0.3
        }
      });

      expect(resultDisk.success).toBe(false);
      expect(resultDisk.publishedCount).toBe(0);
      expect(
        resultDisk.errors!.some((e) => e.includes("dropped by") && e.includes("max allowed drop of 30.0%"))
      ).toBe(true);

      expect(mockClient.batches.length).toBe(0);
      expect(mockClient.catalogRuns.length).toBe(0);

      // Test with baselineProductCount option
      const resultNumeric = await publishCatalogSnapshot({
        dbPath,
        client: mockClient,
        validatorOptions: {
          baselineProductCount: 100,
          maxDropRatio: 0.3
        }
      });

      expect(resultNumeric.success).toBe(false);
      expect(resultNumeric.errors!.some((e) => e.includes("dropped by"))).toBe(true);
      expect(mockClient.batches.length).toBe(0);
      expect(mockClient.catalogRuns.length).toBe(0);
    });

    it("aggregates all failures when database contains multiple concurrent violations", async () => {
      // Simultaneous: schema mismatch, price error, duplicate URL, WAF text
      const prods: CandidateProductRow[] = [
        {
          id: "bad-1",
          name: "Attention Required! | Cloudflare",
          price: -500,
          url: "https://example.com/same"
        },
        {
          id: "bad-2",
          name: "403 Forbidden",
          price: 0,
          url: "https://example.com/same"
        }
      ];

      const { dbPath } = createTempCandidateDb(prods, { schemaVersion: 2 });
      const mockClient = createControllableTursoClient();

      const result = await publishCatalogSnapshot({
        dbPath,
        client: mockClient,
        validatorOptions: { minProducts: 5 }
      });

      expect(result.success).toBe(false);
      expect(result.errors!.length).toBeGreaterThanOrEqual(4);

      // Ensure error aggregation contains schema, price, WAF, and product count issues
      const allErrors = result.errors!.join(" | ");
      expect(allErrors).toContain("schema version");
      expect(allErrors).toContain("price");
      expect(allErrors).toContain("WAF");

      // Verify fail-closed guarantee: Turso client was never touched
      expect(mockClient.executed.length).toBe(0);
      expect(mockClient.batches.length).toBe(0);
      expect(mockClient.catalogRuns.length).toBe(0);
    });

    it("verifies required columns validation prevents writes if any required column is missing", async () => {
      for (const requiredCol of REQUIRED_COLUMNS) {
        const { dbPath } = createTempCandidateDb([], {
          omitColumns: [requiredCol]
        });
        const validation = validateCandidateSnapshotSync(new Database(dbPath, { readonly: true }));

        expect(validation.valid).toBe(false);
        expect(
          validation.errors.some((e) => e.includes("missing required column") && e.includes(requiredCol))
        ).toBe(true);

        const mockClient = createControllableTursoClient();
        const res = await publishCatalogSnapshot({ dbPath, client: mockClient });
        expect(res.success).toBe(false);
        expect(mockClient.batches.length).toBe(0);
        expect(mockClient.catalogRuns.length).toBe(0);
      }
    });
  });

  // =========================================================================
  // 2. Network & Transaction Fault Tolerance
  // =========================================================================
  describe("2. Network & Transaction Fault Tolerance", () => {
    it("handles Turso client.batch network disconnect midway, leaves catalog_runs empty, and exits code 1", async () => {
      const prods = generatePristineProducts(50);
      const { dbPath } = createTempCandidateDb(prods);
      const mockClient = createControllableTursoClient();

      // Simulate abrupt TCP reset or network timeout during client.batch
      mockClient.shouldFailBatch = true;
      mockClient.batchFailureMessage = "ECONNRESET: Connection reset by peer to turso endpoint";

      // 1. Programmatic call with throwOnError: false
      const result = await publishCatalogSnapshot({
        dbPath,
        client: mockClient,
        throwOnError: false
      });

      expect(result.success).toBe(false);
      expect(result.publishedCount).toBe(0);
      expect(result.errors![0]).toContain("ECONNRESET");
      // Fault-tolerance invariant: catalog_runs MUST remain completely empty
      expect(mockClient.catalogRuns.length).toBe(0);

      // 2. Programmatic call with throwOnError: true rejects cleanly
      await expect(
        publishCatalogSnapshot({
          dbPath,
          client: mockClient,
          throwOnError: true
        })
      ).rejects.toThrow("ECONNRESET");
      expect(mockClient.catalogRuns.length).toBe(0);

      // 3. CLI runner rejects cleanly with exit code 1
      const exitCode = await runPublishCli([dbPath], { client: mockClient });
      expect(exitCode).toBe(1);
      expect(mockClient.catalogRuns.length).toBe(0);
    });

    it("handles SQL constraint violation during batch upsert, does NOT write audit record, and exits code 1", async () => {
      const prods = generatePristineProducts(50);
      const { dbPath } = createTempCandidateDb(prods);
      const mockClient = createControllableTursoClient();

      mockClient.shouldFailBatch = true;
      mockClient.batchFailureMessage =
        "LibsqlError: SQLITE_CONSTRAINT_UNIQUE: UNIQUE constraint failed: products.id";

      const result = await publishCatalogSnapshot({
        dbPath,
        client: mockClient,
        throwOnError: false
      });

      expect(result.success).toBe(false);
      expect(result.publishedCount).toBe(0);
      expect(result.errors![0]).toContain("SQLITE_CONSTRAINT_UNIQUE");

      // Audit row MUST NOT be created
      expect(mockClient.catalogRuns.length).toBe(0);

      const exitCode = await runPublishCli([dbPath], { client: mockClient });
      expect(exitCode).toBe(1);
      expect(mockClient.catalogRuns.length).toBe(0);
    });

    it("handles partial failure across multi-batch stream (batch 1 succeeds, batch 2 fails), recording 0 runs", async () => {
      const prods = generatePristineProducts(90);
      const { dbPath } = createTempCandidateDb(prods);
      const mockClient = createControllableTursoClient();

      // With 90 products and batchSize 30: 3 batches (0, 1, 2). Fail on batch index 1.
      mockClient.failBatchAtIndex = 1;
      mockClient.batchFailureMessage = "Network timeout during chunk 2 of batch upload";

      const result = await publishCatalogSnapshot({
        dbPath,
        client: mockClient,
        batchSize: 30,
        throwOnError: false
      });

      expect(result.success).toBe(false);
      expect(result.publishedCount).toBe(0);
      expect(result.errors![0]).toContain("chunk 2 of batch upload");

      // Crucial: Batch 0 was sent, but overall operation failed; NO audit row in catalog_runs!
      expect(mockClient.catalogRuns.length).toBe(0);

      // CLI execution also reports exit code 1
      mockClient.reset();
      mockClient.failBatchAtIndex = 1;
      mockClient.batchFailureMessage = "Network timeout during chunk 2 of batch upload";

      const exitCode = await runPublishCli([dbPath], { client: mockClient, batchSize: 30 });
      expect(exitCode).toBe(1);
      expect(mockClient.catalogRuns.length).toBe(0);
    });

    it("handles schema DDL execution failure fail-closed before any product statements run", async () => {
      const prods = generatePristineProducts(50);
      const { dbPath } = createTempCandidateDb(prods);
      const mockClient = createControllableTursoClient();

      mockClient.shouldFailExecute = true;
      mockClient.executeFailureMessage = "Unauthorized: read-only token cannot execute DDL";

      const result = await publishCatalogSnapshot({
        dbPath,
        client: mockClient,
        throwOnError: false
      });

      expect(result.success).toBe(false);
      expect(result.publishedCount).toBe(0);
      expect(result.errors![0]).toContain("read-only token cannot execute DDL");

      expect(mockClient.batches.length).toBe(0);
      expect(mockClient.catalogRuns.length).toBe(0);

      const exitCode = await runPublishCli([dbPath], { client: mockClient });
      expect(exitCode).toBe(1);
    });

    it("handles failure when writing to catalog_runs audit table and returns exit code 1", async () => {
      const prods = generatePristineProducts(50);
      const { dbPath } = createTempCandidateDb(prods);
      const mockClient = createControllableTursoClient();

      // Product batches succeed, but catalog_runs insert throws
      mockClient.failOnCatalogRunsInsert = true;

      const result = await publishCatalogSnapshot({
        dbPath,
        client: mockClient,
        throwOnError: false
      });

      expect(result.success).toBe(false);
      expect(result.publishedCount).toBe(0);
      expect(result.errors![0]).toContain("catalog_runs write");

      // Verify CLI runner reports failure
      mockClient.reset();
      mockClient.failOnCatalogRunsInsert = true;
      const exitCode = await runPublishCli([dbPath], { client: mockClient });
      expect(exitCode).toBe(1);
    });

    it("verifies scripts/publish-catalog.ts process execution exits with code 1 for invalid databases", () => {
      const scriptPath = fileURLToPath(new URL("../../../../scripts/publish-catalog.ts", import.meta.url));
      expect(fs.existsSync(scriptPath)).toBe(true);

      // Run against non-existent DB
      const resNonExistent = spawnSync(
        process.execPath,
        ["--import", "tsx", scriptPath, "/tmp/non-existent-db-9999.db"],
        { encoding: "utf8" }
      );
      expect(resNonExistent.status).toBe(1);

      // Run with zero products DB
      const { dbPath } = createTempCandidateDb([]);
      const resZeroProds = spawnSync(
        process.execPath,
        ["--import", "tsx", scriptPath, "--validate-only", dbPath],
        { encoding: "utf8" }
      );
      expect(resZeroProds.status).toBe(1);
    });
  });

  // =========================================================================
  // 3. Dry-Run Integrity
  // =========================================================================
  describe("3. Dry-Run Integrity", () => {
    it("performs full schema and product validation on valid DB without initializing client writes or mutating remote state", async () => {
      const prods = generatePristineProducts(60);
      const { dbPath } = createTempCandidateDb(prods);
      const mockClient = createControllableTursoClient();

      const result = await publishCatalogSnapshot({
        dbPath,
        dryRun: true,
        client: mockClient,
        validatorOptions: { minProducts: 50 }
      });

      // Verification of dry-run output
      expect(result.success).toBe(true);
      expect(result.dryRun).toBe(true);
      expect(result.publishedCount).toBe(0);
      expect(result.stats).toBeDefined();

      const stats = result.stats as { totalProducts: number; inStockProducts: number };
      expect(stats.totalProducts).toBe(60);
      expect(stats.inStockProducts).toBe(60);

      // STRICT CHECK: Remote client was never touched
      expect(mockClient.executed.length).toBe(0);
      expect(mockClient.batches.length).toBe(0);
      expect(mockClient.catalogRuns.length).toBe(0);
    });

    it("dry-run fails closed if candidate database fails any acceptance gate", async () => {
      // Candidate with WAF challenge text
      const prods = [
        ...generatePristineProducts(49),
        {
          id: "waf-dry",
          name: "Attention Required! | Cloudflare",
          price: 199.99,
          category: "cpu"
        }
      ];
      const { dbPath } = createTempCandidateDb(prods);
      const mockClient = createControllableTursoClient();

      const result = await publishCatalogSnapshot({
        dbPath,
        dryRun: true,
        client: mockClient,
        validatorOptions: { minProducts: 50 }
      });

      expect(result.success).toBe(false);
      expect(result.dryRun).toBeUndefined();
      expect(result.errors).toBeDefined();
      expect(
        result.errors!.some((e) => e.includes("WAF challenge"))
      ).toBe(true);

      // Remote client must be completely untouched
      expect(mockClient.executed.length).toBe(0);
      expect(mockClient.batches.length).toBe(0);
      expect(mockClient.catalogRuns.length).toBe(0);
    });

    it("CLI runner dry-run options (--dry-run and --validate-only) preserve zero-write integrity", async () => {
      const prods = generatePristineProducts(55);
      const { dbPath } = createTempCandidateDb(prods);
      const mockClient = createControllableTursoClient();

      // 1. --dry-run
      const dryRunCode = await runPublishCli([dbPath, "--dry-run"], { client: mockClient });
      expect(dryRunCode).toBe(0);
      expect(mockClient.executed.length).toBe(0);
      expect(mockClient.batches.length).toBe(0);
      expect(mockClient.catalogRuns.length).toBe(0);

      // 2. --validate-only
      const validateOnlyCode = await runPublishCli([dbPath, "--validate-only"]);
      expect(validateOnlyCode).toBe(0);
    });
  });

  // =========================================================================
  // 4. End-to-End Success Path
  // =========================================================================
  describe("4. End-to-End Success Path", () => {
    it("correctly writes product rows and records audit row in catalog_runs with 'success', SHA-256 hash, and product count", async () => {
      const prods = generatePristineProducts(55);
      const { dbPath } = createTempCandidateDb(prods);
      const mockClient = createControllableTursoClient();

      const result = await publishCatalogSnapshot({
        dbPath,
        client: mockClient,
        validatorOptions: { minProducts: 50 }
      });

      expect(result.success).toBe(true);
      expect(result.publishedCount).toBe(55);
      expect(result.runId).toBeDefined();
      expect(result.runId).toMatch(/^run_\d+_[a-f0-9]{8}$/);

      // DDL verification
      const executedSqls = mockClient.executed.map((e) => e.sql);
      expect(executedSqls).toContain(PRODUCTS_TABLE_DDL);
      expect(executedSqls).toContain(CATALOG_RUNS_TABLE_DDL);

      // Product rows verification in client.batch
      expect(mockClient.batches.length).toBeGreaterThanOrEqual(1);
      const allProductStmts = mockClient.batches.flat();
      expect(allProductStmts.length).toBe(55);

      for (const stmt of allProductStmts) {
        expect(stmt.sql).toContain("INSERT OR REPLACE INTO products");
        expect(stmt.args).toBeDefined();
        expect(stmt.args!.length).toBe(16); // 16 product columns
        expect(typeof stmt.args![0]).toBe("string"); // id
        expect(typeof stmt.args![1]).toBe("string"); // name
        expect(typeof stmt.args![4]).toBe("number"); // price
        expect(stmt.args![4] as number).toBeGreaterThan(0);
        expect(stmt.args![5]).toBe("USD"); // currency
        expect(stmt.args![6]).toBe("US"); // country_code
      }

      // catalog_runs audit row verification
      expect(mockClient.catalogRuns.length).toBe(1);
      const auditEntry = mockClient.catalogRuns[0];
      expect(auditEntry.sql).toContain("INSERT INTO catalog_runs");

      const args = auditEntry.args as [string, string, number, string, string, string];
      const [runId, publishedAt, productCount, sourceDbHash, status, metadata] = args;

      expect(runId).toBe(result.runId);
      expect(new Date(publishedAt).toISOString()).toBe(publishedAt);
      expect(productCount).toBe(55);
      expect(status).toBe("success");

      // Verify SHA-256 hash
      const actualFileHash = createHash("sha256")
        .update(fs.readFileSync(dbPath))
        .digest("hex");
      expect(sourceDbHash).toBe(actualFileHash);
      expect(sourceDbHash).toMatch(/^[a-f0-9]{64}$/);

      // Verify metadata JSON structure
      const parsedMeta = JSON.parse(metadata) as {
        batchSize: number;
        durationMs: number;
        stats: { totalProducts: number };
      };
      expect(parsedMeta.batchSize).toBeGreaterThan(0);
      expect(parsedMeta.durationMs).toBeGreaterThanOrEqual(0);
      expect(parsedMeta.stats.totalProducts).toBe(55);
    });

    it("verifies computeDatabaseHash accurately reflects SHA-256 mutations", () => {
      const { dbPath } = createTempCandidateDb(generatePristineProducts(50));
      const hash1 = computeDatabaseHash(dbPath);
      expect(hash1).toMatch(/^[a-f0-9]{64}$/);

      // Mutate database
      const db = new Database(dbPath);
      db.prepare("UPDATE products SET price = 999.99 WHERE id = 'pristine-1'").run();
      db.close();

      const hash2 = computeDatabaseHash(dbPath);
      expect(hash2).toMatch(/^[a-f0-9]{64}$/);
      expect(hash1).not.toBe(hash2);
    });

    it("streams records in configured batchSize chunks accurately without record loss", async () => {
      const prods = generatePristineProducts(125);
      const { dbPath } = createTempCandidateDb(prods);
      const mockClient = createControllableTursoClient();

      const result = await publishCatalogSnapshot({
        dbPath,
        client: mockClient,
        batchSize: 50,
        validatorOptions: { minProducts: 50 }
      });

      expect(result.success).toBe(true);
      expect(result.publishedCount).toBe(125);

      // 125 items chunked by 50 = 3 batches (50, 50, 25)
      expect(mockClient.batches.length).toBe(3);
      expect(mockClient.batches[0].length).toBe(50);
      expect(mockClient.batches[1].length).toBe(50);
      expect(mockClient.batches[2].length).toBe(25);

      // Catalog run verifies 125 items
      expect(mockClient.catalogRuns.length).toBe(1);
      expect(mockClient.catalogRuns[0].args?.[2]).toBe(125);
    });

    it("CLI runner executes full publish successfully on valid candidate database with exit code 0", async () => {
      const prods = generatePristineProducts(55);
      const { dbPath } = createTempCandidateDb(prods);
      const mockClient = createControllableTursoClient();

      const exitCode = await runPublishCli([dbPath], { client: mockClient });
      expect(exitCode).toBe(0);

      expect(mockClient.catalogRuns.length).toBe(1);
      expect(mockClient.catalogRuns[0].args?.[4]).toBe("success");
    });

    it("executes CLI script subprocess successfully with --validate-only on valid candidate DB", () => {
      const scriptPath = fileURLToPath(new URL("../../../../scripts/publish-catalog.ts", import.meta.url));
      const { dbPath } = createTempCandidateDb(generatePristineProducts(55));

      const res = spawnSync(
        process.execPath,
        ["--import", "tsx", scriptPath, "--validate-only", dbPath],
        { encoding: "utf8" }
      );

      expect(res.status).toBe(0);
    });
  });
});
