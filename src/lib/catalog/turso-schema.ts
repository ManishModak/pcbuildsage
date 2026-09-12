/**
 * src/lib/catalog/turso-schema.ts
 *
 * Turso remote catalog schema definitions and safe migration / bootstrap utility.
 * Defines DDL statements for products, catalog runs, and performance indexes.
 */

import type { Client } from "@libsql/client";

export const PRODUCTS_TABLE_DDL = `
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
`.trim();

export const PRODUCTS_INDEX_COUNTRY_CURRENCY_CAT_DDL = `
CREATE INDEX IF NOT EXISTS idx_products_country_currency_cat ON products(country_code, currency, category);
`.trim();

export const PRODUCTS_INDEX_LOOKUP_DDL = `
CREATE INDEX IF NOT EXISTS idx_products_lookup ON products(country_code, currency, category, subcategory, price);
`.trim();

export const PRODUCTS_INDEX_LAST_SCRAPED_DDL = `
CREATE INDEX IF NOT EXISTS idx_products_last_scraped ON products(last_scraped DESC);
`.trim();

export const PRODUCTS_INDEX_URL_UNIQUE_DDL = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_products_url_unique ON products(url);
`.trim();

export const CATALOG_RUNS_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS catalog_runs (
  id TEXT PRIMARY KEY,
  published_at TEXT NOT NULL,
  product_count INTEGER NOT NULL,
  source_db_hash TEXT,
  status TEXT NOT NULL,
  metadata TEXT
);
`.trim();

export const CATALOG_RUNS_INDEX_PUBLISHED_AT_DDL = `
CREATE INDEX IF NOT EXISTS idx_catalog_runs_published_at ON catalog_runs(published_at DESC);
`.trim();

export const TURSO_CATALOG_DDL = [
  PRODUCTS_TABLE_DDL,
  PRODUCTS_INDEX_COUNTRY_CURRENCY_CAT_DDL,
  PRODUCTS_INDEX_LOOKUP_DDL,
  PRODUCTS_INDEX_LAST_SCRAPED_DDL,
  PRODUCTS_INDEX_URL_UNIQUE_DDL,
  CATALOG_RUNS_TABLE_DDL,
  CATALOG_RUNS_INDEX_PUBLISHED_AT_DDL
] as const;

/**
 * Safely applies catalog DDL statements to Turso to ensure all required tables
 * and indexes exist prior to snapshot ingestion or query execution.
 *
 * @param client LibSQL client instance
 */
export async function ensureTursoSchema(client: Client): Promise<void> {
  for (const ddl of TURSO_CATALOG_DDL) {
    await client.execute(ddl);
  }
}
