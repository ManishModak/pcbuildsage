import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initializeSchema } from "@/lib/db";
import { SqliteCatalogRepository } from "@/lib/catalog/sqlite-repository";
import type { CatalogRepository } from "@/lib/catalog";
import { resolveConfig } from "@/lib/config";
import { createToolRegistry } from "../index";
import { createSearchProductsTool, searchProducts } from "../search-products";
import { createPresentBuildTool } from "../present-build";
import { createTurnValidationStore, recordValidation } from "../turn-state";

const scope = { countryCode: "IN", currency: "INR" };
const ctx = { toolCallId: "t", messages: [] } as never;

function insert(
  db: Database.Database,
  row: { id: string; name: string; category: string; price: number; specs?: Record<string, unknown> }
) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO products (id, name, normalized_name, registry_key, price, currency, country_code, retailer, url, image_url, in_stock, category, subcategory, specs, first_seen, last_scraped)
     VALUES (@id, @name, @normalized_name, NULL, @price, 'INR', 'IN', 'Shop', @url, NULL, 1, @category, NULL, @specs, @now, @now)`
  ).run({
    id: row.id,
    name: row.name,
    normalized_name: row.name.toLowerCase(),
    price: row.price,
    url: `https://example.com/${row.id}`,
    category: row.category,
    specs: row.specs ? JSON.stringify(row.specs) : null,
    now
  });
}

describe("batch search_products", () => {
  let db: Database.Database;
  let repo: SqliteCatalogRepository;

  beforeEach(() => {
    db = new Database(":memory:");
    initializeSchema(db);
    for (let i = 1; i <= 8; i++) {
      insert(db, { id: `gpu-${i}${"0".repeat(35)}`, name: `GPU ${i}`, category: "gpu", price: i * 10000 });
      insert(db, { id: `cpu-${i}${"0".repeat(35)}`, name: `CPU ${i}`, category: "cpu", price: i * 4000, specs: { socket: "AM5", ddr: "DDR5", tdp_w: 65, igpu: true } });
    }
    insert(db, { id: "mobo-00000000000000000000000000000000001", name: "AM5 Board", category: "motherboard", price: 12000, specs: { socket: "AM5", ddr: "DDR5", form_factor: "mATX" } });
    insert(db, { id: "ram-000000000000000000000000000000000001", name: "16GB DDR5 Kit", category: "ram", price: 5000, specs: { ddr: "DDR5", capacity_gb: 16, modules: 2 } });
    insert(db, { id: "ssd-000000000000000000000000000000000001", name: "1TB NVMe SSD", category: "storage", price: 5500, specs: { interface: "nvme", capacity_gb: 1000 } });
    insert(db, { id: "psu-000000000000000000000000000000000001", name: "650W PSU", category: "psu", price: 4500, specs: { wattage: 650 } });
    insert(db, { id: "case-00000000000000000000000000000000001", name: "mATX Case", category: "case", price: 3500, specs: { form_factor: "mATX", max_gpu_length_mm: 330, max_cooler_height_mm: 165 } });
    repo = new SqliteCatalogRepository(db);
  });

  afterEach(async () => {
    await repo.close();
  });

  it("executes sub-queries with bounded concurrency (<=4) and defaults sub-query limit to 12", async () => {
    let active = 0;
    let peakActive = 0;
    const fakeRepo = {
      searchProducts: vi.fn(async (input: { category?: string; limit?: number }) => {
        active++;
        peakActive = Math.max(peakActive, active);
        await new Promise((r) => setTimeout(r, 15));
        active--;
        return {
          results: [{ id: `${input.category}-1234567890abcdef`, name: `${input.category} part`, category: input.category ?? "cpu", price: 1000, currency: "INR", country_code: "IN", retailer: "Shop", url: "https://example.com", in_stock: true }],
          total_matching: input.limit ?? 12,
          scope: { country_code: "IN", currency: "INR" }
        };
      })
    } as unknown as CatalogRepository;

    const out = await searchProducts(
      {
        queries: [
          { category: "gpu", price_max: 35000 },
          { category: "cpu", socket: "AM5" },
          { category: "motherboard", limit: 20 },
          { category: "ram" },
          { category: "storage" },
          { category: "psu" }
        ]
      },
      scope,
      fakeRepo
    );

    expect(peakActive).toBeGreaterThan(1);
    expect(peakActive).toBeLessThanOrEqual(4);
    expect(out.batch).toBe(true);
    expect(out.searches).toHaveLength(6);
    expect(out.searches[0]).toMatchObject({ label: "gpu", category: "gpu" });
    expect(out.searches[1]).toMatchObject({ label: "cpu", category: "cpu" });
    expect(out.searches[2].note).toContain("maximum per search");
    expect(vi.mocked(fakeRepo.searchProducts).mock.calls[0][0].limit).toBe(12);
    expect(vi.mocked(fakeRepo.searchProducts).mock.calls[1][0].limit).toBe(12);
    expect(vi.mocked(fakeRepo.searchProducts).mock.calls[2][0].limit).toBe(12);
  });

  it("handles empty queries, mixed single+batch filters (including top-level limit/in_stock), and >8 sub-queries cleanly", async () => {
    const empty = await searchProducts({ queries: [] }, scope, repo);
    expect(empty.error).toContain("1 to 8");

    const mixedCategory = await searchProducts({ queries: [{ category: "gpu" }], category: "cpu" } as never, scope, repo);
    expect(mixedCategory.error).toContain("Cannot combine 'queries'");

    // Explicit top-level limit or in_stock mixed with queries must be rejected (not obscured by defaults).
    const tool = createSearchProductsTool(scope, repo);
    const schema = tool.inputSchema as unknown as {
      validate: (v: unknown) => { success: boolean; value?: Record<string, unknown>; error?: Error };
      toJSONSchema: () => Record<string, unknown>;
    };
    const parsedMixedLimit = schema.validate({ queries: [{ category: "gpu" }], limit: 2 });
    expect(parsedMixedLimit.success).toBe(true);
    const mixedLimitOut = (await tool.execute!(parsedMixedLimit.value as never, ctx)) as { error?: string };
    expect(mixedLimitOut.error).toContain("Cannot combine 'queries'");
    expect(mixedLimitOut.error).toContain("limit");

    const parsedMixedInStock = schema.validate({ queries: [{ category: "gpu" }], in_stock: true });
    expect(parsedMixedInStock.success).toBe(true);
    const mixedInStockOut = (await tool.execute!(parsedMixedInStock.value as never, ctx)) as { error?: string };
    expect(mixedInStockOut.error).toContain("Cannot combine 'queries'");
    expect(mixedInStockOut.error).toContain("in_stock");

    // Oversized queries array is rejected at schema validation before per-item coercion/validation.
    const oversized = schema.validate({ queries: Array.from({ length: 100 }, () => ({ category: "cpu", price_max: "bad" })) });
    expect(oversized.success).toBe(false);
    expect(oversized.error?.message).toContain("queries");

    // Direct searchProducts still safely caps to 8 with a note.
    const many = Array.from({ length: 10 }, (_, i) => ({ category: "cpu" as const, price_max: (i + 1) * 5000 }));
    const capped = await searchProducts({ queries: many }, scope, repo);
    expect(capped.batch).toBe(true);
    expect(capped.searches).toHaveLength(8);
    expect(capped.note).toContain("first 8 sub-queries");

    // Canonical provider JSON schema exposes queries with minItems/maxItems and zero duplicated top-level filters.
    const jsonSchema = schema.toJSONSchema() as {
      properties: Record<string, { minItems?: number; maxItems?: number; items?: { properties?: Record<string, unknown> } }>;
    };
    expect(Object.keys(jsonSchema.properties)).toEqual(["queries"]);
    expect(jsonSchema.properties.queries.minItems).toBe(1);
    expect(jsonSchema.properties.queries.maxItems).toBe(8);
    expect(jsonSchema.properties.queries.items?.properties).toHaveProperty("category");
    expect(JSON.stringify(jsonSchema).length).toBeLessThan(5500);
  });

  it("retains successful sibling slots when one sub-query throws a transient repository error", async () => {
    const flakyRepo = {
      searchProducts: vi.fn(async (input: { category?: string }) => {
        if (input.category === "gpu") throw new Error("SQLITE_BUSY: database is locked");
        return {
          results: [{ id: "ram-000000000000000000000000000000000001", name: "16GB DDR5 Kit", category: "ram", price: 5000, currency: "INR", country_code: "IN", retailer: "Shop", url: "https://example.com", in_stock: true }],
          total_matching: 1,
          scope: { country_code: "IN", currency: "INR" }
        };
      })
    } as unknown as CatalogRepository;

    const out = await searchProducts({ queries: [{ category: "ram" }, { category: "gpu" }] }, scope, flakyRepo);
    expect(out.batch).toBe(true);
    expect(out.error).toBeUndefined();
    expect(out.searches).toHaveLength(2);
    expect(out.searches[0].results).toHaveLength(1);
    expect(out.searches[0].error).toBeUndefined();
    expect(out.searches[1].results).toEqual([]);
    expect(out.searches[1].error).toContain("SQLITE_BUSY");
  });

  it("coerces stringified queries and scalar sub-query values in lenientToolSchema", async () => {
    const tool = createSearchProductsTool(scope, repo);
    const schema = tool.inputSchema as unknown as {
      validate: (v: unknown) => { success: boolean; value?: Record<string, unknown> };
    };
    const parsed = schema.validate({
      queries: JSON.stringify([{ category: "gpu", price_max: "35000", limit: "4" }])
    });
    expect(parsed.success).toBe(true);
    expect(parsed.value?.queries).toEqual([expect.objectContaining({ category: "gpu", price_max: 35000, limit: 4 })]);
  });

  it("formats batch toModelOutput compactly with 10-char ID prefixes", async () => {
    const tool = createSearchProductsTool(scope, repo);
    const raw = await tool.execute!(
      {
        queries: [
          { category: "gpu", price_max: 25000 },
          { term: "AM5 Board" }
        ]
      } as never,
      ctx
    );
    const modelOut = (await tool.toModelOutput!({ input: {}, output: raw } as never)) as {
      type: string;
      value: { batch: boolean; searches: Array<{ label: string; category?: string; results: Array<Record<string, unknown>> }> };
    };
    expect(modelOut.type).toBe("json");
    expect(modelOut.value.batch).toBe(true);
    expect(modelOut.value.searches).toHaveLength(2);
    // Category-filtered sub-search drops redundant per-row category and shortens IDs.
    expect(modelOut.value.searches[0].results[0].id).toHaveLength(10);
    expect(modelOut.value.searches[0].results[0]).not.toHaveProperty("category");
    expect(modelOut.value.searches[0].results[0]).not.toHaveProperty("url");
    // Uncategorized term sub-search keeps category on rows and shortens IDs.
    expect(modelOut.value.searches[1].results[0].id).toBe("mobo-00000");
    expect(modelOut.value.searches[1].results[0].category).toBe("motherboard");
  });

  it("records every part ID and category from batch searches in tools/index found map for present_build revalidation", async () => {
    const chain = [{ provider: "openai-compatible" as const, model: "m", baseUrl: "http://127.0.0.1:1/v1", keySource: "none" as const }];
    const config = {
      ...resolveConfig({ llmChain: chain, chatLlmChain: chain, subagentLlmChain: chain, dbPath: ":memory:", countryCode: "IN", currency: "INR", searchProvider: "none" }),
      dbPath: ""
    };
    const registry = createToolRegistry(config, { repository: repo, requireCatalogParts: false });

    // Batch search returns all 6 categories.
    const batchOut = (await registry.search_products.execute!(
      {
        queries: [
          { category: "cpu" },
          { category: "motherboard" },
          { category: "ram" },
          { category: "storage" },
          { category: "psu" },
          { category: "case" }
        ]
      } as never,
      ctx
    )) as { searches: Array<{ results: Array<{ id: string }> }> };
    const firstCpuId = batchOut.searches[0].results[0].id;
    const secondCpuId = batchOut.searches[0].results[1].id;
    expect(secondCpuId).not.toBe(firstCpuId);

    // Validate with CPU #1, then present_build swaps in another CPU from the batch search!
    await registry.validate_build.execute!(
      {
        builds: [
          {
            label: "AM5",
            parts: {
              cpu: { product_id: firstCpuId.slice(0, 10) },
              motherboard: { product_id: "mobo-00000" },
              ram: { product_id: "ram-000000" },
              storage: { product_id: "ssd-000000" },
              psu: { product_id: "psu-000000" },
              case: { product_id: "case-00000" }
            }
          }
        ]
      },
      ctx
    );

    const presented = (await registry.present_build.execute!(
      {
        builds: [
          {
            label: "AM5",
            product_ids: [secondCpuId.slice(0, 10), "mobo-00000", "ram-000000", "ssd-000000", "psu-000000", "case-00000"]
          }
        ],
        followups: ["Add a GPU later"]
      },
      ctx
    )) as { presented: boolean; followups?: string[]; builds?: Array<{ product_ids: string[] }> };

    expect(presented.presented).toBe(true);
    expect(presented.followups).toEqual(["Add a GPU later"]);
    expect(presented.builds?.[0].product_ids).toContain(secondCpuId);
  });
});

describe("present_build followups", () => {
  it("returns normalized followups only when presented and non-empty", async () => {
    const store = createTurnValidationStore();
    recordValidation(store, "Within budget", {
      valid: true,
      issues: [],
      snapshot: { label: "Within budget", components: [{ category: "cpu", product_id: "cpu-1" }] }
    } as never);
    const present = createPresentBuildTool(store);

    const ok = (await present.execute!(
      { builds: [{ label: "Within budget" }], followups: ["  Make it quieter ", "Make it quieter", "Add 32GB RAM"] },
      ctx
    )) as { presented: boolean; followups?: string[] };
    expect(ok.presented).toBe(true);
    expect(ok.followups).toEqual(["Make it quieter", "Add 32GB RAM"]);

    const emptyFollowups = (await present.execute!(
      { builds: [{ label: "Within budget" }], followups: [] },
      ctx
    )) as { presented: boolean; followups?: string[] };
    expect(emptyFollowups.presented).toBe(true);
    expect(emptyFollowups).not.toHaveProperty("followups");

    const refused = (await present.execute!(
      { builds: [{ label: "Missing label" }], followups: ["Should not appear"] },
      ctx
    )) as { presented: boolean; followups?: string[] };
    expect(refused.presented).toBe(false);
    expect(refused).not.toHaveProperty("followups");
  });
});
