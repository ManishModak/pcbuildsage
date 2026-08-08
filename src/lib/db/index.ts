import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";

export const DEFAULT_DB_PATH = process.env.PCBUILDSAGE_DB_PATH ?? path.join(process.cwd(), "data", "products.db");
export const DEFAULT_LOGS_DB_PATH = process.env.PCBUILDSAGE_LOGS_DB_PATH ?? path.join(process.cwd(), "data", "logs.db");
// Keep in lockstep with SCHEMA_VERSION in scraper/db.py. The Python scraper
// owns the migrations; this side only needs to recognise the version it is given,
// and initializeSchema() throws outright if the file is newer than this constant.
export const DATABASE_SCHEMA_VERSION = 4;

const activeDbs = new Map<string, Database.Database>();
const activeLogsDbs = new Map<string, Database.Database>();

// Keep in lockstep with LOGS_TABLE_DDL in scraper/db.py.
const LOGS_TABLE_DDL = `
      CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        level TEXT NOT NULL,
        component TEXT NOT NULL,
        message TEXT NOT NULL,
        details TEXT
      );

      CREATE TRIGGER IF NOT EXISTS limit_logs_size AFTER INSERT ON logs
      BEGIN
        DELETE FROM logs WHERE id IN (
          SELECT id FROM logs ORDER BY id DESC LIMIT -1 OFFSET 1000
        );
      END;
    `;

/**
 * Returns a cached database connection for the given path.
 * Connections are keyed by resolved absolute path, so multiple
 * callers with different paths coexist safely without closing
 * each other's connections.
 */
export function getDb(dbPath = DEFAULT_DB_PATH): Database.Database {
  const resolvedPath = path.resolve(dbPath);
  let db = activeDbs.get(resolvedPath);

  if (!db || !db.open) {
    db = openDb(resolvedPath);
    activeDbs.set(resolvedPath, db);
  }

  return db;
}

/**
 * Returns the cached logs database connection, opening it (with the
 * same pragmas as db.ts's openDb) and creating the schema on first use.
 */
export function getLogsDb(dbPath = DEFAULT_LOGS_DB_PATH): Database.Database {
  const resolvedPath = path.resolve(dbPath);
  let db = activeLogsDbs.get(resolvedPath);

  if (!db || !db.open) {
    mkdirSync(path.dirname(resolvedPath), { recursive: true });
    db = new Database(resolvedPath);
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    db.pragma("foreign_keys = ON");
    db.exec(LOGS_TABLE_DDL);
    activeLogsDbs.set(resolvedPath, db);
  }

  return db;
}

/**
 * Close a specific database connection (by path) or all open connections.
 */
export function closeDb(dbPath?: string): void {
  if (dbPath) {
    const resolvedPath = path.resolve(dbPath);
    const db = activeDbs.get(resolvedPath);

    if (db?.open) {
      db.close();
    }

    activeDbs.delete(resolvedPath);

    const logDb = activeLogsDbs.get(resolvedPath);
    if (logDb?.open) {
      logDb.close();
    }
    activeLogsDbs.delete(resolvedPath);
    return;
  }

  // Close all connections
  for (const db of activeDbs.values()) {
    if (db.open) {
      db.close();
    }
  }
  activeDbs.clear();

  for (const db of activeLogsDbs.values()) {
    if (db.open) {
      db.close();
    }
  }
  activeLogsDbs.clear();
}

function openDb(dbPath = DEFAULT_DB_PATH): Database.Database {
  mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  initializeSchema(db);

  return db;
}

export function initializeSchema(db: Database.Database): void {
  const userVersion = Number(db.pragma("user_version", { simple: true }));

  if (userVersion > DATABASE_SCHEMA_VERSION) {
    throw new Error(
      `Database schema version ${userVersion} is newer than supported version ${DATABASE_SCHEMA_VERSION}. Update PCBuildSage before opening this database.`
    );
  }

  // Migrations are owned by the Python scraper (see SCHEMA_VERSION and
  // _backfill_build_roles in src/scraper/db.py). Column-shape changes AND the
  // build-role backfill are stamped together there. If this side migrated a
  // populated legacy DB and bumped user_version, Python would later see a current
  // version and skip the backfill, leaving every legacy row with a NULL
  // subcategory - i.e. wrongly build-relevant (pen drives back in builds). So this
  // side is recognise-only: it creates the schema for a brand-new DB, but refuses
  // to touch an older populated one and directs the user to run the scraper.
  const productsExists = (db.pragma("table_info(products)") as Array<{ name: string }>).length > 0;
  if (productsExists && userVersion < DATABASE_SCHEMA_VERSION) {
    throw new Error(
      `Database schema version ${userVersion} is older than supported version ${DATABASE_SCHEMA_VERSION}. Run the scraper (python -m scraper) to migrate this database before opening it.`
    );
  }

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

    CREATE INDEX IF NOT EXISTS idx_products_lookup ON products(country_code, currency, category, subcategory, price);
    CREATE INDEX IF NOT EXISTS idx_products_norm ON products(normalized_name);

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
      confidence TEXT NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
      researched_at TEXT NOT NULL
    );
  `);

  db.pragma(`user_version = ${DATABASE_SCHEMA_VERSION}`);
}

export function writeDbLog(
  dbPath = DEFAULT_LOGS_DB_PATH,
  level: "INFO" | "WARN" | "ERROR" | "DEBUG",
  component: string,
  message: string,
  details?: Record<string, unknown> | null
): void {
  try {
    const db = getLogsDb(dbPath);
    const detailsStr = details ? JSON.stringify(details) : null;
    const now = new Date().toISOString();
    
    db.prepare(
      `INSERT INTO logs (timestamp, level, component, message, details)
       VALUES (?, ?, ?, ?, ?)`
    ).run(now, level, component, message, detailsStr);
  } catch (error) {
    console.error("Failed to write to DB logs:", error);
  }
}
