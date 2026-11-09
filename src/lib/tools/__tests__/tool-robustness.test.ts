import { describe, expect, it, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initializeSchema } from "@/lib/db";
import { SqliteCatalogRepository } from "@/lib/catalog/sqlite-repository";
import { createSearchProductsTool, searchProducts } from "../search-products";
import { createListModelsTool, listModels } from "../list-models";
import { addPriceFigures, createValidateBuildTool, labelModelsMissing } from "../validate-build";
import type { BuildSnapshot } from "@/lib/catalog/build-snapshot";

const scope = { countryCode: "IN", currency: "INR" };
const ctx = { toolCallId: "t", messages: [] } as never;

function insert(db: Database.Database, row: { id: string; name: string; category: string; price: number; specs?: Record<string, unknown>; in_stock?: number }) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO products (id, name, normalized_name, registry_key, price, currency, country_code, retailer, url, image_url, in_stock, category, subcategory, specs, first_seen, last_scraped)
     VALUES (@id, @name, @normalized_name, NULL, @price, 'INR', 'IN', 'Shop', @url, NULL, @in_stock, @category, NULL, @specs, @now, @now)`
  ).run({
    id: row.id,
    name: row.name,
    normalized_name: row.name.toLowerCase(),
    price: row.price,
    url: `https://example.com/${row.id}`,
    in_stock: row.in_stock ?? 1,
    category: row.category,
    specs: row.specs ? JSON.stringify(row.specs) : null,
    now
  });
}

type Validator = { validate: (v: unknown) => { success: boolean; value?: Record<string, unknown>; error?: Error } };
const validatorOf = (tool: { inputSchema: unknown }) => tool.inputSchema as Validator;

describe("lenient tool inputs", () => {
  const search = validatorOf(createSearchProductsTool(scope));
  const list = validatorOf(createListModelsTool(scope));

  it("accepts numeric and boolean strings as sent by small models", () => {
    const out = search.validate({ category: "ram", in_stock: "true", limit: "12", price_max: "20000" });
    expect(out.success).toBe(true);
    expect(out.value).toMatchObject({ category: "ram", in_stock: true, limit: 12, price_max: 20000 });
  });

  it('turns "false" into false, not true', () => {
    expect(search.validate({ in_stock: "false" }).value?.in_stock).toBe(false);
    expect(list.validate({ in_stock: " FALSE " }).value?.in_stock).toBe(false);
  });

  it("rejects empty and non-numeric strings with a message naming the field", () => {
    for (const bad of ["", "abc", "20k"]) {
      const out = search.validate({ price_max: bad });
      expect(out.success).toBe(false);
      expect(out.error?.message).toContain("price_max");
      expect(out.error?.message).toContain(JSON.stringify(bad));
    }
    expect(search.validate({ in_stock: "yes" }).success).toBe(false);
    expect(list.validate({ limit: "2.5" }).success).toBe(false);
  });

  it("keeps unknown fields on the parsed value for execute to report, instead of rejecting", () => {
    const out = list.validate({ category: "gpu", colour: "red" });
    expect(out.success).toBe(true);
    expect(out.value?.colour).toBe("red");
  });

  it("still sends providers the strict, described JSON schema", async () => {
    const schema = (createListModelsTool(scope).inputSchema as { jsonSchema: unknown }).jsonSchema as {
      properties: Record<string, { type?: string; description?: string }>;
      additionalProperties: boolean;
    };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.price_max.type).toBe("number");
    expect(schema.properties.segment.description).toMatch(/segment/i);
    expect(schema.properties.in_stock.type).toBe("boolean");
  });
});

describe("tool results against a catalog", () => {
  let db: Database.Database;
  let repo: SqliteCatalogRepository;

  beforeEach(() => {
    db = new Database(":memory:");
    initializeSchema(db);
    insert(db, { id: "g1", name: "Acme Blaster 900", category: "gpu", price: 30000, specs: { model: "Acme Blaster 900", segment: "gaming", vram_gb: 8 } });
    insert(db, { id: "g2", name: "Acme ProViz 500", category: "gpu", price: 40000, specs: { model: "Acme ProViz 500", segment: "workstation", vram_gb: 16 } });
    insert(db, { id: "r1", name: "Zento Vengeance 16GB DDR5 Kit", category: "ram", price: 25199, specs: { ddr: "DDR5", capacity_gb: 16 } });
    insert(db, { id: "r2", name: "Zento Fury 32GB DDR5 Kit", category: "ram", price: 41000, specs: { ddr: "DDR5", capacity_gb: 32 } });
    insert(db, { id: "r3", name: "Zento Basic 8GB DDR4", category: "ram", price: 1500, specs: { ddr: "DDR4", capacity_gb: 8 } });
    insert(db, { id: "r4", name: "Zento Cheap 8GB DDR5 (retired)", category: "ram", price: 900, specs: { ddr: "DDR5", capacity_gb: 8 }, in_stock: 0 });
    repo = new SqliteCatalogRepository(db);
  });

  afterEach(async () => {
    await repo.close();
  });

  it("search_products drops an unknown field and reports it", async () => {
    const out = await searchProducts({ category: "gpu", colour: "red" } as never, scope, repo);
    expect(out.error).toBeUndefined();
    expect(out.results.length).toBe(2);
    expect(out.ignored_fields).toEqual(["colour"]);
    expect(out.hint).toContain("Ignored unknown field(s): colour");
  });

  it("list_models filters by GPU segment", async () => {
    const gaming = await listModels({ category: "gpu", segment: "gaming" }, scope, repo);
    expect(gaming.models.map((m) => m.name)).toEqual(["Acme Blaster 900"]);
    expect(gaming.total_matching_models).toBe(1);
    const workstation = await listModels({ category: "gpu", segment: "workstation" }, scope, repo);
    expect(workstation.models.map((m) => m.name)).toEqual(["Acme ProViz 500"]);
  });

  it("search_products zero-result hint names the cheapest in-stock match without the price bounds", async () => {
    const out = await searchProducts({ category: "ram", ddr: "DDR5", price_min: 3000, price_max: 20000 }, scope, repo);
    expect(out.results).toHaveLength(0);
    // The out-of-stock ₹900 kit and the DDR4 kit are not candidates.
    expect(out.nearest_match).toEqual({ id: "r1", name: "Zento Vengeance 16GB DDR5 Kit", price: 25199, retailer: "Shop" });
    expect(out.matches_without_price_limit).toBe(2);
    expect(out.hint).toMatch(
      /^No matches between ₹3,000 and ₹20,000\. Cheapest in-stock match for these filters: Zento Vengeance 16GB DDR5 Kit at ₹25,199 from Shop \(2 matches without the price limit\)\./
    );
  });

  it("search_products keeps the old hint when nothing matches even without price bounds", async () => {
    const out = await searchProducts({ category: "ram", ddr: "DDR3", price_max: 20000 }, scope, repo);
    expect(out.nearest_match).toBeUndefined();
    expect(out.hint).not.toMatch(/Cheapest in-stock match/);
  });

  it("list_models zero-result hint names the cheapest model without the price bounds", async () => {
    const out = await listModels({ category: "gpu", segment: "workstation", price_max: 35000 }, scope, repo);
    expect(out.models).toHaveLength(0);
    expect(out.nearest_match).toMatchObject({ name: "Acme ProViz 500", price: 40000 });
    expect(out.hint).toContain("No models at or under ₹35,000. Cheapest in-stock model for these filters: Acme ProViz 500 from ₹40,000 (1 model without the price limit).");
  });

  it("validate_build reports budget figures and the difference from the cheapest build", async () => {
    const tool = createValidateBuildTool(scope, repo);
    const out = (await tool.execute!(
      { budget: 45000, builds: [{ label: "Within budget", parts: { gpu: { product_id: "g1" } } }, { label: "Pro", parts: { gpu: { product_id: "g2" } } }] },
      ctx
    )) as { builds: Record<string, { budget?: unknown; vs_cheapest?: unknown; price_summary?: string }> };
    expect(out.builds["Within budget"].budget).toEqual({ target: 45000, total: 30000, over_by: 0, under_by: 15000 });
    expect(out.builds["Pro"].vs_cheapest).toEqual({ cheapest_label: "Within budget", more_by: 10000 });
    expect(out.builds["Pro"].price_summary).toBe("Total ₹40,000; ₹5,000 under the ₹45,000 budget; ₹10,000 more than 'Within budget'");
  });

  it("validate_build flags a build labelled Within budget that is over the budget", async () => {
    const tool = createValidateBuildTool(scope, repo);
    const out = (await tool.execute!({ budget: 25000, builds: [{ label: "Within budget", parts: { gpu: { product_id: "g1" } } }] }, ctx)) as {
      builds: Record<string, { price_summary?: string }>;
    };
    expect(out.builds["Within budget"].price_summary).toBe(
      "Total ₹30,000; ₹5,000 over the ₹25,000 budget; labelled 'Within budget' but over budget: swap a part to bring it under, or relabel it and add a build within the budget"
    );
  });

  it("validate_build tells the model to cut a build far over the budget, not one just over it", async () => {
    const tool = createValidateBuildTool(scope, repo);
    const run = async (budget: number) =>
      ((await tool.execute!({ budget, builds: [{ label: "Pro", parts: { gpu: { product_id: "g2" } } }] }, ctx)) as {
        builds: Record<string, { price_summary?: string }>;
      }).builds["Pro"].price_summary;
    // ₹40,000 against ₹35,000 is 14% over.
    expect(await run(35000)).toBe(
      "Total ₹40,000; ₹5,000 over the ₹35,000 budget; 14% over: the budget is the user's limit, so swap the priciest parts for cheaper search_products picks and validate again; present a build this far over only beside one within the budget"
    );
    // 2.6% over is the small value-jump margin the prompt allows.
    expect(await run(39000)).toBe("Total ₹40,000; ₹1,000 over the ₹39,000 budget");
  });

  it("finds model numbers a label names that no part in the build has", () => {
    const parts = ["AMD Ryzen 3 3200G 4 Cores", "MSI B450M Pro-VDH Max", "Klevv Bolt X 16GB DDR4"];
    expect(labelModelsMissing("RTX 3050 Esports", parts)).toEqual(["3050"]);
    expect(labelModelsMissing("3200G iGPU build", parts)).toEqual([]);
    // Resolutions, budgets and price fragments aren't parts.
    expect(labelModelsMissing("1080p under 60k (₹45,000 / 45000)", parts)).toEqual([]);
  });

  it("validate_build names the core parts a partial build left out", async () => {
    const tool = createValidateBuildTool(scope, repo);
    const out = (await tool.execute!(
      { builds: [{ label: "Partial", parts: { gpu: { product_id: "g1" } } }] },
      ctx
    )) as { builds: Record<string, { missing_parts?: string[]; missing_parts_note?: string }> };
    expect(out.builds["Partial"].missing_parts).toEqual(["cpu", "motherboard", "ram", "storage", "psu", "case"]);
    expect(out.builds["Partial"].missing_parts_note).toContain("keeps no parts between calls");
    expect(out.builds["Partial"].missing_parts_note).not.toContain("no CPU in parts");
  });

  it("sends providers parts with no fixed key order, and still validates each part", async () => {
    const { asSchema } = await import("ai");
    const tool = createValidateBuildTool(scope, repo);
    const json = (await asSchema(tool.inputSchema as never).jsonSchema) as { properties: { builds: { items: { properties: { parts: Record<string, unknown> } } } } };
    const parts = json.properties.builds.items.properties.parts;
    // Listed properties make a grammar-constrained provider emit them in schema order only.
    expect(parts.properties).toBeUndefined();
    expect(parts.additionalProperties).toBeTruthy();
    expect(String(parts.description)).toContain("in any order: cpu, gpu");
    const validate = (input: unknown) => (asSchema(tool.inputSchema as never) as { validate: (v: unknown) => { success: boolean } }).validate(input);
    expect((await validate({ builds: [{ label: "A", parts: { gpu: { product_id: "g1" }, cpu: { product_id: "c1" } } }] })).success).toBe(true);
    expect((await validate({ builds: [{ label: "A", parts: { cpu: 42 } }] })).success).toBe(false);
  });

  it("validate_build fails a build that has a motherboard and no CPU", async () => {
    const tool = createValidateBuildTool(scope, repo);
    const out = (await tool.execute!(
      { builds: [{ label: "RX 7600 + Ryzen 5 5600", parts: { gpu: { product_id: "g1" }, motherboard: { product_id: "m1" } } }] },
      ctx
    )) as { builds: Record<string, { valid?: boolean; missing_parts_note?: string; issues: Array<{ severity: string }>; summary: { failed: number }; snapshot: { valid: boolean; validation_summary: { failed: number } } }> };
    const build = out.builds["RX 7600 + Ryzen 5 5600"];
    expect(build.valid).toBe(false);
    expect(build.missing_parts_note).toMatch(/^Invalid: no CPU in parts/);
    // The card and the snapshot show the same failed check.
    expect(build.issues.filter((i) => i.severity === "blocking")).toHaveLength(1);
    expect(build.summary.failed).toBeGreaterThan(0);
    expect(build.snapshot.valid).toBe(false);
    expect(build.snapshot.validation_summary.failed).toBe(build.summary.failed);
  });
});

describe("addPriceFigures", () => {
  const snap = (total: number | null) => ({ snapshot: { total, currency: "INR" } as BuildSnapshot });

  it("computes non-negative over_by / under_by and vs_cheapest in code", () => {
    // The chat-run case: ₹3,878 over budget, ₹5,240 more than the cheaper build.
    const results: Record<string, ReturnType<typeof snap> & Record<string, unknown>> = {
      "Within budget": snap(43638),
      "1TB upgrade": snap(48878)
    };
    addPriceFigures(results, 45000);
    expect(results["1TB upgrade"].budget).toEqual({ target: 45000, total: 48878, over_by: 3878, under_by: 0 });
    expect(results["Within budget"].budget).toEqual({ target: 45000, total: 43638, over_by: 0, under_by: 1362 });
    expect(results["1TB upgrade"].vs_cheapest).toEqual({ cheapest_label: "Within budget", more_by: 5240 });
    expect(results["Within budget"].vs_cheapest).toEqual({ cheapest_label: "Within budget", more_by: 0 });
  });

  it("adds nothing without a budget for a single build, and skips unpriced builds", () => {
    const single: Record<string, ReturnType<typeof snap> & Record<string, unknown>> = { A: snap(1000) };
    addPriceFigures(single);
    expect(single.A.budget).toBeUndefined();
    expect(single.A.vs_cheapest).toBeUndefined();

    const mixed: Record<string, ReturnType<typeof snap> & Record<string, unknown>> = { A: snap(1000), B: snap(null) };
    addPriceFigures(mixed, 900);
    expect(mixed.A.budget).toEqual({ target: 900, total: 1000, over_by: 100, under_by: 0 });
    expect(mixed.A.vs_cheapest).toBeUndefined();
    expect(mixed.B.budget).toBeUndefined();
  });
});
