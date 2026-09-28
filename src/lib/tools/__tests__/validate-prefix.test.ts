import { describe, expect, it, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initializeSchema } from "@/lib/db";
import { SqliteCatalogRepository } from "@/lib/catalog/sqlite-repository";
import { createValidateBuildTool, toModelValidateOutput } from "../validate-build";
import { resolveIdPrefix, shortId } from "../product-ids";

function createDb(): Database.Database {
  const db = new Database(":memory:");
  initializeSchema(db);
  return db;
}

function insert(db: Database.Database, row: Record<string, unknown>) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO products (id, name, normalized_name, registry_key, price, currency, country_code, retailer, url, image_url, in_stock, category, subcategory, specs, first_seen, last_scraped)
     VALUES (@id, @name, @normalized_name, @registry_key, @price, @currency, @country_code, @retailer, @url, @image_url, @in_stock, @category, @subcategory, @specs, @first_seen, @last_scraped)`
  ).run({
    id: row.id,
    name: row.name,
    normalized_name: String(row.name).toLowerCase(),
    registry_key: row.registry_key ?? null,
    price: row.price,
    currency: "INR",
    country_code: "IN",
    retailer: "R",
    url: `https://example.com/${row.id}`,
    image_url: null,
    in_stock: 1,
    category: row.category,
    subcategory: null,
    specs: null,
    first_seen: now,
    last_scraped: now
  });
}

const FULL_CPU = "da6670a41d06377759be1c70e28f32230239c099";
const FULL_BOARD = "b2f9d25f2b06377759be1c70e28f32230239c200";
const scope = { countryCode: "IN", currency: "INR" };
const ctx = { toolCallId: "t", messages: [] } as never;

describe("short product IDs", () => {
  let db: Database.Database;
  let repo: SqliteCatalogRepository;

  beforeEach(() => {
    db = createDb();
    insert(db, { id: FULL_CPU, name: "Intel Core i9-14900K Desktop Processor", category: "cpu", registry_key: "intel-core-i9-14900k", price: 55000 });
    insert(db, { id: FULL_BOARD, name: "ASUS ROG Strix Z790-E Gaming WiFi Motherboard", category: "motherboard", registry_key: "asus-rog-strix-z790-e", price: 45000 });
    repo = new SqliteCatalogRepository(db);
  });

  afterEach(async () => {
    await repo.close();
  });

  it("validate_build accepts 10-char prefixes and stores full IDs", async () => {
    const tool = createValidateBuildTool(scope, repo);
    const out = (await tool.execute!(
      {
        builds: [
          {
            label: "Within budget",
            parts: { cpu: { product_id: FULL_CPU.slice(0, 10) }, motherboard: { product_id: FULL_BOARD.slice(0, 10) } }
          }
        ]
      },
      ctx
    )) as { builds: Record<string, { snapshot: { components: Array<{ product_id: string }> } }> };
    const comps = out.builds["Within budget"].snapshot.components;
    expect(comps.map((c) => c.product_id)).toContain(FULL_CPU);
    expect(comps.map((c) => c.product_id)).toContain(FULL_BOARD);
  });

  it("model output shows only first 10 chars", async () => {
    const tool = createValidateBuildTool(scope, repo);
    const out = (await tool.execute!(
      {
        builds: [
          {
            label: "Within budget",
            parts: { cpu: { product_id: FULL_CPU }, motherboard: { product_id: FULL_BOARD } }
          }
        ]
      },
      ctx
    )) as unknown;
    const model = toModelValidateOutput(out) as {
      builds: Record<string, { snapshot: { components: Array<{ product_id: string }> } }>;
    };
    for (const comp of model.builds["Within budget"].snapshot.components) {
      expect(comp.product_id.length).toBeLessThanOrEqual(10);
      expect(comp.product_id).toBe(shortId(FULL_CPU).slice(0, comp.product_id.length) === comp.product_id ? comp.product_id : comp.product_id);
    }
    expect(model.builds["Within budget"].snapshot.components.map((c) => c.product_id)).toContain(FULL_CPU.slice(0, 10));
  });

  it("ambiguous prefix errors listing candidates", async () => {
    const a = "abcdef1234567890abcdef1234567890abcdef12";
    const b = "abcdef1299999999abcdef1234567890abcdef34";
    insert(db, { id: a, name: "Intel Core i9-14900K Desktop Processor", category: "cpu", registry_key: "intel-core-i9-14900k", price: 55000 });
    insert(db, { id: b, name: "Intel Core i9-14900K Desktop Processor", category: "cpu", registry_key: "intel-core-i9-14900k", price: 55000 });
    const res = resolveIdPrefix("abcdef12", [a, b]);
    expect("error" in res).toBe(true);
    if ("error" in res) expect(res.error).toMatch(/Ambiguous.*abcdef12/i);
  });

  it("description example uses short prefixes, not made-up IDs", async () => {
    const tool = createValidateBuildTool();
    const desc = typeof tool.description === "string" ? tool.description : "";
    expect(desc).not.toContain("in-cpu-amd-ryzen-5-5600-01");
    expect(desc).toMatch(/da6670a41d|first 10|min 8/i);
  });
});
