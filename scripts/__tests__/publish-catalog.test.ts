/**
 * scripts/__tests__/publish-catalog.test.ts
 *
 * Tests for scripts/publish-catalog.ts CLI script:
 * - Argument parsing (--help, --db, --dry-run, --json, --force, --batch-size)
 * - Environment variable fallback for --db ($PCBUILDSAGE_DB_PATH)
 * - Exit code 1 when candidate DB does not exist
 * - Exit code 0 when dry-run validation passes on a valid database
 * - Exit code 1 when candidate DB fails validation (version mismatch, empty catalog)
 * - Subprocess end-to-end integration tests using tsx
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import type { Client, InStatement, ResultSet } from "@libsql/client";
import {
  parseCliArgs,
  runPublishCatalog
} from "../publish-catalog";

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  }
  tempDirs.length = 0;
});

interface CreateTestDbOptions {
  count?: number;
  schemaVersion?: number;
  omitProductsTable?: boolean;
  categories?: string[];
  retailers?: string[];
}

function createTestDatabase(options: CreateTestDbOptions = {}): string {
  const dir = createTempDir("publish-cli-test-");
  const dbPath = path.join(dir, "candidate.db");
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

    const count = options.count ?? 55;
    const categories = options.categories ?? ["cpu", "gpu", "ram"];
    const retailers = options.retailers ?? ["Best Buy", "MicroCenter", "Amazon"];

    if (count > 0) {
      const insert = db.prepare(`
        INSERT INTO products (
          id, name, normalized_name, registry_key, price, currency,
          country_code, retailer, url, image_url, in_stock, category,
          subcategory, specs, first_seen, last_scraped
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const now = new Date().toISOString();
      const insertMany = db.transaction(() => {
        for (let i = 0; i < count; i++) {
          const category = categories[i % categories.length];
          const retailer = retailers[i % retailers.length];
          insert.run(
            `prod-${i + 1}`,
            `Component ${i + 1} Edition`,
            `component ${i + 1} edition`,
            `${category}-key`,
            199.99 + (i * 10),
            "USD",
            "US",
            retailer,
            `https://example.com/item-${i + 1}`,
            "https://example.com/item.jpg",
            1,
            category,
            "desktop",
            JSON.stringify({ index: i }),
            now,
            now
          );
        }
      });
      insertMany();
    }
  }

  db.close();
  return dbPath;
}

function createMockTursoClient(): Client & { executed: string[] } {
  const executed: string[] = [];
  const client = {
    executed,
    protocol: "http" as const,
    closed: false,
    close: () => {
      client.closed = true;
    },
    execute: async (stmt: InStatement): Promise<ResultSet> => {
      const sql = typeof stmt === "string" ? stmt : stmt.sql;
      executed.push(sql);
      return {
        columns: [],
        columnTypes: [],
        rows: [],
        rowsAffected: 1,
        lastInsertRowid: undefined,
        toJSON: () => []
      };
    },
    batch: async (statements: InStatement[]): Promise<ResultSet[]> => {
      for (const stmt of statements) {
        const sql = typeof stmt === "string" ? stmt : stmt.sql;
        executed.push(sql);
      }
      return statements.map(() => ({
        columns: [],
        columnTypes: [],
        rows: [],
        rowsAffected: 1,
        lastInsertRowid: undefined,
        toJSON: () => []
      }));
    }
  } as unknown as Client & { executed: string[] };

  return client;
}

describe("scripts/publish-catalog.ts CLI", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.PCBUILDSAGE_DB_PATH;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe("1. CLI argument parsing (parseCliArgs)", () => {
    it("parses --help and -h flags", () => {
      expect(parseCliArgs(["--help"]).help).toBe(true);
      expect(parseCliArgs(["-h"]).help).toBe(true);
      expect(parseCliArgs([]).help).toBe(false);
    });

    it("parses --db flag with path argument and equals syntax", () => {
      const parsed1 = parseCliArgs(["--db", "/custom/path/catalog.db"]);
      expect(parsed1.db).toBe("/custom/path/catalog.db");

      const parsed2 = parseCliArgs(["--db=/another/path/catalog.db"]);
      expect(parsed2.db).toBe("/another/path/catalog.db");
    });

    it("defaults --db to process.env.PCBUILDSAGE_DB_PATH when defined", () => {
      process.env.PCBUILDSAGE_DB_PATH = "/env/catalog/override.db";
      const parsed = parseCliArgs([]);
      expect(parsed.db).toBe("/env/catalog/override.db");
    });

    it("defaults --db to data/products.db when process.env.PCBUILDSAGE_DB_PATH is unset", () => {
      delete process.env.PCBUILDSAGE_DB_PATH;
      const parsed = parseCliArgs([]);
      expect(parsed.db).toBe(path.join(process.cwd(), "data", "products.db"));
    });

    it("prefers explicit --db over process.env.PCBUILDSAGE_DB_PATH", () => {
      process.env.PCBUILDSAGE_DB_PATH = "/env/catalog/override.db";
      const parsed = parseCliArgs(["--db", "/explicit/path.db"]);
      expect(parsed.db).toBe("/explicit/path.db");
    });

    it("parses --dry-run and --dryRun boolean flags", () => {
      expect(parseCliArgs(["--dry-run"]).dryRun).toBe(true);
      expect(parseCliArgs(["--dryRun"]).dryRun).toBe(true);
      expect(parseCliArgs([]).dryRun).toBe(false);
    });

    it("parses --json boolean flag", () => {
      expect(parseCliArgs(["--json"]).json).toBe(true);
      expect(parseCliArgs([]).json).toBe(false);
    });

    it("parses --force boolean flag", () => {
      expect(parseCliArgs(["--force"]).force).toBe(true);
      expect(parseCliArgs([]).force).toBe(false);
    });

    it("parses --batch-size and --batchSize numeric options", () => {
      expect(parseCliArgs(["--batch-size", "250"]).batchSize).toBe(250);
      expect(parseCliArgs(["--batch-size=500"]).batchSize).toBe(500);
      expect(parseCliArgs(["--batchSize", "75"]).batchSize).toBe(75);
      expect(parseCliArgs([]).batchSize).toBeUndefined();
    });

    it("throws a clear error on non-positive or non-numeric --batch-size", () => {
      expect(() => parseCliArgs(["--batch-size", "invalid"])).toThrow(/Invalid --batch-size/);
      expect(() => parseCliArgs(["--batch-size", "0"])).toThrow(/Invalid --batch-size/);
      expect(() => parseCliArgs(["--batch-size=-10"])).toThrow(/Invalid --batch-size/);
    });

    it("parses a comprehensive combination of all flags", () => {
      const parsed = parseCliArgs([
        "--db",
        "/tmp/custom.db",
        "--dry-run",
        "--force",
        "--json",
        "--batch-size",
        "150"
      ]);
      expect(parsed).toEqual({
        db: "/tmp/custom.db",
        dryRun: true,
        force: true,
        json: true,
        batchSize: 150,
        help: false
      });
    });
  });

  describe("2. Exit code 1 when candidate DB does not exist", () => {
    it("returns exit code 1 and prints human-readable error when DB file is missing", async () => {
      const nonExistentPath = path.join(os.tmpdir(), "definitely-non-existent-db-12345.db");
      const stdoutLines: string[] = [];
      const stderrLines: string[] = [];

      const exitCode = await runPublishCatalog(
        ["--db", nonExistentPath, "--dry-run"],
        {
          stdout: (msg) => stdoutLines.push(msg),
          stderr: (msg) => stderrLines.push(msg)
        }
      );

      expect(exitCode).toBe(1);
      const combinedStderr = stderrLines.join("\n");
      expect(combinedStderr).toContain("Candidate database file does not exist");
      expect(combinedStderr).toContain(nonExistentPath);
      expect(combinedStderr).toContain("Status:         FAILED");
    });

    it("returns exit code 1 and outputs structured JSON with error when DB file is missing", async () => {
      const nonExistentPath = path.join(os.tmpdir(), "missing-catalog-file-67890.db");
      const stdoutLines: string[] = [];
      const stderrLines: string[] = [];

      const exitCode = await runPublishCatalog(
        ["--db", nonExistentPath, "--dry-run", "--json"],
        {
          stdout: (msg) => stdoutLines.push(msg),
          stderr: (msg) => stderrLines.push(msg)
        }
      );

      expect(exitCode).toBe(1);
      expect(stderrLines).toHaveLength(0);

      const jsonOutput = JSON.parse(stdoutLines.join("\n"));
      expect(jsonOutput.success).toBe(false);
      expect(jsonOutput.dryRun).toBe(true);
      expect(jsonOutput.dbPath).toBe(nonExistentPath);
      expect(jsonOutput.errors).toBeDefined();
      expect(jsonOutput.errors[0]).toContain("Candidate database file does not exist");
    });
  });

  describe("3. Exit code 0 when dry-run validation passes on a valid database", () => {
    it("returns exit code 0 and prints human-readable formatted summary on valid DB in dry-run mode", async () => {
      const dbPath = createTestDatabase({
        count: 55,
        categories: ["cpu", "gpu"],
        retailers: ["Best Buy", "MicroCenter"]
      });

      const stdoutLines: string[] = [];
      const stderrLines: string[] = [];

      const exitCode = await runPublishCatalog(
        ["--db", dbPath, "--dry-run"],
        {
          stdout: (msg) => stdoutLines.push(msg),
          stderr: (msg) => stderrLines.push(msg)
        }
      );

      expect(exitCode).toBe(0);
      expect(stderrLines).toHaveLength(0);

      const combinedStdout = stdoutLines.join("\n");
      expect(combinedStdout).toContain("Status:         SUCCESS");
      expect(combinedStdout).toContain("Total Products: 55");
      expect(combinedStdout).toContain("Categories (2):");
      expect(combinedStdout).toContain("cpu:");
      expect(combinedStdout).toContain("gpu:");
      expect(combinedStdout).toContain("Retailers (2):");
      expect(combinedStdout).toContain("Best Buy:");
      expect(combinedStdout).toContain("MicroCenter:");
      expect(combinedStdout).toContain("Run ID:         N/A");
    });

    it("returns exit code 0 and emits valid structured JSON on valid DB in dry-run mode", async () => {
      const dbPath = createTestDatabase({
        count: 60,
        categories: ["storage"],
        retailers: ["Amazon"]
      });

      const stdoutLines: string[] = [];
      const stderrLines: string[] = [];

      const exitCode = await runPublishCatalog(
        ["--db", dbPath, "--dry-run", "--json"],
        {
          stdout: (msg) => stdoutLines.push(msg),
          stderr: (msg) => stderrLines.push(msg)
        }
      );

      expect(exitCode).toBe(0);
      expect(stderrLines).toHaveLength(0);

      const jsonOutput = JSON.parse(stdoutLines.join("\n"));
      expect(jsonOutput.success).toBe(true);
      expect(jsonOutput.dryRun).toBe(true);
      expect(jsonOutput.dbPath).toBe(dbPath);
      expect(jsonOutput.publishedCount).toBe(0);
      expect(jsonOutput.runId).toBeNull();
      expect(jsonOutput.stats.totalProducts).toBe(60);
      expect(jsonOutput.stats.categories.storage).toBe(60);
      expect(jsonOutput.stats.retailers.Amazon).toBe(60);
      expect(jsonOutput.errors).toEqual([]);
    });
  });

  describe("4. Exit code 1 when candidate DB fails validation", () => {
    it("returns exit code 1 when schema version mismatches", async () => {
      const dbPath = createTestDatabase({
        count: 55,
        schemaVersion: 1 // version 1 is invalid, expected 5
      });

      const stdoutLines: string[] = [];
      const stderrLines: string[] = [];

      const exitCode = await runPublishCatalog(
        ["--db", dbPath, "--dry-run"],
        {
          stdout: (msg) => stdoutLines.push(msg),
          stderr: (msg) => stderrLines.push(msg)
        }
      );

      expect(exitCode).toBe(1);
      const combinedStderr = stderrLines.join("\n");
      expect(combinedStderr).toContain("Status:         FAILED");
      expect(combinedStderr).toContain("Invalid schema version 1");
    });

    it("returns exit code 1 and structured JSON when catalog has 0 products", async () => {
      const dbPath = createTestDatabase({ count: 0, schemaVersion: 5 }); // 0 products is forbidden

      const stdoutLines: string[] = [];
      const stderrLines: string[] = [];

      const exitCode = await runPublishCatalog(
        ["--db", dbPath, "--dry-run", "--json"],
        {
          stdout: (msg) => stdoutLines.push(msg),
          stderr: (msg) => stderrLines.push(msg)
        }
      );

      expect(exitCode).toBe(1);
      const jsonOutput = JSON.parse(stdoutLines.join("\n"));
      expect(jsonOutput.success).toBe(false);
      expect(jsonOutput.errors.length).toBeGreaterThan(0);
      expect(jsonOutput.errors.some((e: string) => e.includes("0 products"))).toBe(true);
    });

    it("returns exit code 1 when candidate DB is missing products table", async () => {
      const dbPath = createTestDatabase({ count: 0, schemaVersion: 5, omitProductsTable: true });

      const stdoutLines: string[] = [];
      const stderrLines: string[] = [];

      const exitCode = await runPublishCatalog(
        ["--db", dbPath, "--dry-run", "--json"],
        {
          stdout: (msg) => stdoutLines.push(msg),
          stderr: (msg) => stderrLines.push(msg)
        }
      );

      expect(exitCode).toBe(1);
      const jsonOutput = JSON.parse(stdoutLines.join("\n"));
      expect(jsonOutput.success).toBe(false);
      expect(jsonOutput.errors.some((e: string) => e.includes("products' is missing"))).toBe(true);
    });
  });

  describe("5. Help and Argument Validation", () => {
    it("prints help and exits with code 0 when --help is supplied", async () => {
      const stdoutLines: string[] = [];
      const exitCode = await runPublishCatalog(["--help"], {
        stdout: (msg) => stdoutLines.push(msg)
      });

      expect(exitCode).toBe(0);
      const helpOutput = stdoutLines.join("\n");
      expect(helpOutput).toContain("Usage: publish-catalog [options]");
      expect(helpOutput).toContain("--db <path>");
      expect(helpOutput).toContain("--dry-run");
      expect(helpOutput).toContain("--force");
      expect(helpOutput).toContain("--batch-size <num>");
      expect(helpOutput).toContain("--json");
    });

    it("returns code 1 when argument parsing throws", async () => {
      const stdoutLines: string[] = [];
      const stderrLines: string[] = [];

      const exitCode = await runPublishCatalog(["--batch-size", "not-a-number"], {
        stdout: (msg) => stdoutLines.push(msg),
        stderr: (msg) => stderrLines.push(msg)
      });

      expect(exitCode).toBe(1);
      expect(stderrLines.join("\n")).toContain("Invalid --batch-size");
    });

    it("outputs JSON error when argument parsing fails with --json", async () => {
      const stdoutLines: string[] = [];

      const exitCode = await runPublishCatalog(["--batch-size", "not-a-number", "--json"], {
        stdout: (msg) => stdoutLines.push(msg)
      });

      expect(exitCode).toBe(1);
      const jsonOutput = JSON.parse(stdoutLines.join("\n"));
      expect(jsonOutput.success).toBe(false);
      expect(jsonOutput.errors[0]).toContain("Invalid --batch-size");
    });
  });

  describe("6. Live publication with mock client", () => {
    it("successfully publishes to Turso when valid client is provided", async () => {
      const dbPath = createTestDatabase({ count: 55, categories: ["cpu"], retailers: ["Amazon"] });
      const mockClient = createMockTursoClient();
      const stdoutLines: string[] = [];

      const exitCode = await runPublishCatalog(
        ["--db", dbPath, "--json"],
        {
          client: mockClient,
          stdout: (msg) => stdoutLines.push(msg)
        }
      );

      expect(exitCode).toBe(0);
      const jsonOutput = JSON.parse(stdoutLines.join("\n"));
      expect(jsonOutput.success).toBe(true);
      expect(jsonOutput.dryRun).toBe(false);
      expect(jsonOutput.publishedCount).toBe(55);
      expect(jsonOutput.runId).toMatch(/^run_\d+_/);
      expect(mockClient.executed.length).toBeGreaterThan(0);
    });
  });

  describe("7. Subprocess Integration Tests (CLI invocation)", () => {
    const tsxCli = path.resolve(process.cwd(), "node_modules/tsx/dist/cli.mjs");
    const scriptPath = path.resolve(process.cwd(), "scripts/publish-catalog.ts");

    it("subprocess exits with 0 on --help", () => {
      const res = spawnSync(process.execPath, [tsxCli, scriptPath, "--help"], {
        cwd: process.cwd(),
        encoding: "utf8"
      });

      expect(res.status).toBe(0);
      expect(res.stdout).toContain("Usage: publish-catalog [options]");
    });

    it("subprocess exits with 1 when candidate DB does not exist", () => {
      const nonExistentPath = path.join(os.tmpdir(), "subprocess-missing-db.db");
      const res = spawnSync(
        process.execPath,
        [tsxCli, scriptPath, "--db", nonExistentPath, "--dry-run"],
        {
          cwd: process.cwd(),
          encoding: "utf8"
        }
      );

      expect(res.status).toBe(1);
      expect(res.stderr).toContain("Candidate database file does not exist");
    });

    it("subprocess exits with 0 on valid DB with --dry-run and --json", () => {
      const dbPath = createTestDatabase({
        count: 55,
        categories: ["ram"],
        retailers: ["Amazon"]
      });

      const res = spawnSync(
        process.execPath,
        [tsxCli, scriptPath, "--db", dbPath, "--dry-run", "--json"],
        {
          cwd: process.cwd(),
          encoding: "utf8"
        }
      );

      expect(res.status).toBe(0);
      const json = JSON.parse(res.stdout);
      expect(json.success).toBe(true);
      expect(json.dryRun).toBe(true);
      expect(json.stats.totalProducts).toBe(55);
      expect(json.stats.categories.ram).toBe(55);
    });

    it("subprocess exits with 1 on candidate DB failing validation", () => {
      const dbPath = createTestDatabase({
        count: 55,
        schemaVersion: 2
      });

      const res = spawnSync(
        process.execPath,
        [tsxCli, scriptPath, "--db", dbPath, "--dry-run", "--json"],
        {
          cwd: process.cwd(),
          encoding: "utf8"
        }
      );

      expect(res.status).toBe(1);
      const json = JSON.parse(res.stdout);
      expect(json.success).toBe(false);
      expect(json.errors.some((e: string) => e.includes("Invalid schema version"))).toBe(true);
    });
  });
});
