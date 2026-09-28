import { describe, expect, it, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initializeSchema } from "@/lib/db";
import { SqliteCatalogRepository } from "@/lib/catalog/sqlite-repository";
import { createValidateBuildTool } from "../validate-build";
import { createPresentBuildTool } from "../present-build";
import { createTurnValidationStore } from "../turn-state";

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
    currency: "IN" === row.country_code ? "INR" : row.currency ?? "INR",
    country_code: row.country_code ?? "IN",
    retailer: row.retailer ?? "R",
    url: row.url ?? `https://example.com/${row.id}`,
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

describe("present_build per-turn validation", () => {
  let db: Database.Database;
  let repo: SqliteCatalogRepository;

  beforeEach(() => {
    db = createDb();
    insert(db, { id: FULL_CPU, name: "Intel Core i9-14900K Desktop Processor", category: "cpu", registry_key: "intel-core-i9-14900k", price: 55000, country_code: "IN" });
    insert(db, { id: FULL_BOARD, name: "ASUS ROG Strix Z790-E Gaming WiFi Motherboard", category: "motherboard", registry_key: "asus-rog-strix-z790-e", price: 45000, country_code: "IN" });
    repo = new SqliteCatalogRepository(db);
  });

  afterEach(async () => {
    await repo.close();
  });

  it("errors listing valid labels when label has no validation this turn", async () => {
    const store = createTurnValidationStore();
    const validate = createValidateBuildTool(scope, repo, store);
    await validate.execute!(
      { builds: [{ label: "Within budget", parts: { cpu: { product_id: FULL_CPU }, motherboard: { product_id: FULL_BOARD } } }] },
      ctx
    );
    const present = createPresentBuildTool(store);
    const out = (await present.execute!({ builds: [{ label: "Nope" }] }, ctx)) as {
      presented: boolean;
      error: string;
      valid_labels: string[];
    };
    expect(out.presented).toBe(false);
    expect(out.error).toContain("Within budget");
    expect(out.valid_labels).toEqual(["Within budget"]);
  });

  it("presents by label only, storing full IDs", async () => {
    const store = createTurnValidationStore();
    const validate = createValidateBuildTool(scope, repo, store);
    await validate.execute!(
      { builds: [{ label: "Within budget", parts: { cpu: { product_id: FULL_CPU.slice(0, 10) }, motherboard: { product_id: FULL_BOARD.slice(0, 10) } } }] },
      ctx
    );
    const present = createPresentBuildTool(store);
    const out = (await present.execute!({ builds: [{ label: "Within budget" }] }, ctx)) as {
      presented: boolean;
      builds: Array<{ product_ids: string[] }>;
    };
    expect(out.presented).toBe(true);
    expect(out.builds[0].product_ids).toContain(FULL_CPU);
    expect(out.builds[0].product_ids).toContain(FULL_BOARD);
  });

  it("refuses builds with blocking issues", async () => {
    const store = createTurnValidationStore();
    const { recordValidation } = await import("../turn-state");
    const snapshot = {
      label: "Blocked",
      components: [
        { category: "cpu", product_id: FULL_CPU, name: "CPU", price: 1, currency: "INR" },
        { category: "motherboard", product_id: FULL_BOARD, name: "Board", price: 1, currency: "INR" }
      ],
      total: 2,
      subtotal: 2,
      currency: "INR",
      is_complete: true,
      component_count: 2,
      unpriced_count: 0,
      missing_prices: [],
      currencies: ["INR"],
      parts: {},
      valid: false,
      created_at: new Date().toISOString()
    } as never;
    recordValidation(store, "Blocked", {
      valid: false,
      issues: [{ rule: "socket", severity: "blocking", detail: "Socket mismatch", components: ["cpu"] }],
      resolved: {},
      checks: [],
      summary: { passed: 0, failed: 1, unverified: 0, text: "1 failed" },
      snapshot
    } as never);
    const present = createPresentBuildTool(store);
    const out = (await present.execute!({ builds: [{ label: "Blocked" }] }, ctx)) as {
      presented: boolean;
      error: string;
    };
    expect(out.presented).toBe(false);
    expect(out.error).toMatch(/blocking/i);
  });

  it("refuses IDs differing from the validation snapshot", async () => {
    const store = createTurnValidationStore();
    const validate = createValidateBuildTool(scope, repo, store);
    await validate.execute!(
      { builds: [{ label: "Within budget", parts: { cpu: { product_id: FULL_CPU }, motherboard: { product_id: FULL_BOARD } } }] },
      ctx
    );
    const present = createPresentBuildTool(store);
    const other = "6f5ed45a50ad56603d3534d036036a55749156dc";
    insert(db, { id: other, name: "AMD Ryzen 7 7800X3D Processor", category: "cpu", registry_key: "amd-ryzen-7-7800x3d", price: 38000, country_code: "IN" });
    const out = (await present.execute!(
      { builds: [{ label: "Within budget", product_ids: [other.slice(0, 10), FULL_BOARD.slice(0, 10)] }] },
      ctx
    )) as { presented: boolean; error: string };
    expect(out.presented).toBe(false);
    expect(out.error).toMatch(/differ/i);
  });
});
