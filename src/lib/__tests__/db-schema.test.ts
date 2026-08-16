import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { DATABASE_SCHEMA_VERSION, initializeSchema } from "../db";

let databases: Database.Database[] = [];

afterEach(() => {
  for (const db of databases) {
    if (db.open) db.close();
  }
  databases = [];
});

function memoryDb(): Database.Database {
  const db = new Database(":memory:");
  databases.push(db);
  return db;
}

describe("catalog schema ownership", () => {
  it("initializes an empty database from the canonical v5 schema", () => {
    const db = memoryDb();

    initializeSchema(db);

    const tables = new Set((db.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table'"
    ).all() as Array<{ name: string }>).map((row) => row.name));
    const indexes = new Set((db.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'products'"
    ).all() as Array<{ name: string }>).map((row) => row.name));

    expect(tables.has("products")).toBe(true);
    expect(tables.has("audit_cache")).toBe(true);
    expect(tables.has("registry_research")).toBe(true);
    expect(indexes.has("idx_products_url_unique")).toBe(true);
    expect(indexes.has("idx_products_lookup")).toBe(true);
    expect(indexes.has("idx_products_norm")).toBe(true);
    expect(indexes.has("idx_products_retailer_sweep")).toBe(true);
    expect(Number(db.pragma("user_version", { simple: true }))).toBe(DATABASE_SCHEMA_VERSION);
  });

  it("enforces the canonical URL uniqueness constraint", () => {
    const db = memoryDb();
    initializeSchema(db);
    const insert = db.prepare(`
      INSERT INTO products (
        id, name, currency, country_code, retailer, url, category, first_seen, last_scraped
      ) VALUES (?, ?, 'INR', 'IN', 'Shop', ?, 'gpu', '2026-01-01', '2026-01-01')
    `);
    insert.run("a", "A", "https://example.com/same");

    expect(() => insert.run("b", "B", "https://example.com/same")).toThrow();
  });

  it.each([0, 1, 2, 3, 4])("refuses populated legacy v%s for Python migration", (version) => {
    const db = memoryDb();
    db.exec("CREATE TABLE products (id TEXT PRIMARY KEY)");
    db.pragma(`user_version = ${version}`);

    expect(() => initializeSchema(db)).toThrow("Run the scraper");
    expect(Number(db.pragma("user_version", { simple: true }))).toBe(version);
  });

  it("rejects a future schema version without mutating it", () => {
    const db = memoryDb();
    db.pragma(`user_version = ${DATABASE_SCHEMA_VERSION + 1}`);

    expect(() => initializeSchema(db)).toThrow("newer than supported");
    expect(Number(db.pragma("user_version", { simple: true }))).toBe(DATABASE_SCHEMA_VERSION + 1);
  });
});
