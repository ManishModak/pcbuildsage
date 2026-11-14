import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initializeSchema } from "@/lib/db";
import { SqliteCatalogRepository } from "@/lib/catalog/sqlite-repository";
import { listModels, listModelsInputSchema, type ListModelsScope } from "@/lib/tools/list-models";
import type { BenchmarkDataset } from "@/lib/benchmarks";

const dataset: BenchmarkDataset = {
  id: "test-rendering",
  metric: "rendering",
  source: { name: "Test Data", url: "https://example.com/", licence: "CC0-1.0", snapshot: "2026-10-31" },
  method: "test",
  baselines: { gpu: "nvidia-rtx-4060" },
  // The partner card below has no score of its own: it uses its chip's.
  scores: { gpu: { "nvidia-rtx-5070": 200, "nvidia-rtx-5060-ti-8gb": 150, "nvidia-rtx-4060": 100 } },
  runs: { "nvidia-rtx-5070": 10, "nvidia-rtx-5060-ti-8gb": 10, "nvidia-rtx-4060": 10 }
};

const GPUS = [
  { key: "nvidia-rtx-3060-12gb", name: "GeForce RTX 3060 12GB", price: 250, vram: 12 },
  { key: "nvidia-rtx-4060", name: "GeForce RTX 4060", price: 300, vram: 8 },
  { key: "msi-rtx-5060-ti-shadow-2x-oc-plus-8gb", name: "MSI GeForce RTX 5060 Ti 8G SHADOW 2X OC PLUS", price: 450, vram: 8 },
  { key: "nvidia-rtx-5070", name: "GeForce RTX 5070", price: 500, vram: 12 }
];

describe("list_models performance ranking", () => {
  let db: Database.Database;
  let repo: SqliteCatalogRepository;
  const scope: ListModelsScope = { countryCode: "US", currency: "USD", benchmarks: [dataset] };

  beforeEach(() => {
    db = new Database(":memory:");
    initializeSchema(db);
    repo = new SqliteCatalogRepository(db);
    const now = new Date().toISOString();
    const insert = db.prepare(`
      INSERT INTO products (id, name, normalized_name, registry_key, price, currency, country_code, retailer, url,
        image_url, in_stock, category, subcategory, specs, first_seen, last_scraped)
      VALUES (?, ?, ?, ?, ?, 'USD', 'US', 'Shop', ?, NULL, 1, 'gpu', NULL, ?, ?, ?)`);
    for (const gpu of GPUS) {
      insert.run(gpu.key, gpu.name, gpu.name.toLowerCase(), gpu.key, gpu.price, `https://example.com/${gpu.key}`,
        JSON.stringify({ vram_gb: gpu.vram }), now, now);
    }
  });

  afterEach(async () => {
    await repo.close();
    db.close();
  });

  it("ranks scored models first, scores partner cards by their chip and keeps unscored ones last", async () => {
    const res = await listModels({ category: "gpu", performance: "rendering" }, scope, repo);

    expect(res.models.map((model) => model.model_id)).toEqual([
      "nvidia-rtx-5070-12gb",
      "msi-rtx-5060-ti-shadow-2x-oc-plus-8gb",
      "nvidia-rtx-4060-8gb",
      "nvidia-rtx-3060-12gb"
    ]);
    expect(res.models.map((model) => model.perf)).toEqual([
      { score: 200, vs_leader_pct: 0, per_1k: 400 },
      { score: 150, vs_leader_pct: -25, per_1k: 333.33 },
      { score: 100, vs_leader_pct: -50, per_1k: 333.33 },
      null
    ]);
    expect(res.perf_info).toMatchObject({
      metric: "rendering",
      dataset: "test-rendering",
      baseline: "nvidia-rtx-4060",
      leader: "nvidia-rtx-5070-12gb",
      scored: 3,
      unscored: 1
    });
    expect(res.perf_info?.note).toMatch(/nothing about gaming/);
    expect(res.hint).toMatch(/1 of 4 models have no rendering score/);
    expect(res.models.some((model) => "registry_key" in model)).toBe(false);
  });

  it("ranks across every matching model before applying the limit", async () => {
    const res = await listModels({ category: "gpu", performance: "rendering", limit: 2 }, scope, repo);

    expect(res.models.map((model) => model.model_id)).toEqual(["nvidia-rtx-5070-12gb", "msi-rtx-5060-ti-shadow-2x-oc-plus-8gb"]);
    expect(res.total_matching_models).toBe(4);
    expect(res.truncated).toBe(true);
    expect(res.perf_info).toMatchObject({ scored: 3, unscored: 1 });
  });

  it("compares only the finalists named in model_ids, including a JSON-string list", async () => {
    const res = await listModels(
      { category: "gpu", performance: "rendering", model_ids: ["nvidia-rtx-5070-12gb", "nvidia-rtx-4060"] },
      scope,
      repo
    );
    expect(res.models.map((model) => [model.model_id, model.perf?.vs_leader_pct])).toEqual([
      ["nvidia-rtx-5070-12gb", 0],
      ["nvidia-rtx-4060-8gb", -50]
    ]);

    const parsed = listModelsInputSchema.parse({ model_ids: '["nvidia-rtx-5070-12gb", "nvidia-rtx-4060"]' });
    expect(parsed.model_ids).toEqual(["nvidia-rtx-5070-12gb", "nvidia-rtx-4060"]);
  });

  it("explains model_ids that match nothing, such as product ids", async () => {
    const res = await listModels({ category: "gpu", model_ids: ["5e02764d63", "07193e1e33"] }, scope, repo);

    expect(res.models).toEqual([]);
    expect(res.hint).toMatch(/^No models matched model_ids with these filters\. model_ids takes model_id values/);

    const priced = await listModels(
      { category: "gpu", model_ids: ["nvidia-rtx-5070-12gb", "nvidia-rtx-4060"], price_max: 100 },
      scope,
      repo
    );
    expect(priced.matches_without_price_limit).toBe(2);
    expect(priced.hint).not.toMatch(/model_ids/);
  });

  it("leaves results unchanged without performance and explains a missing dataset", async () => {
    const plain = await listModels({ category: "gpu" }, scope, repo);
    expect(plain.models.map((model) => model.model_id)[0]).toBe("nvidia-rtx-3060-12gb");
    expect(plain.perf_info).toBeUndefined();
    expect(plain.models.some((model) => "perf" in model || "registry_key" in model)).toBe(false);

    const noData = await listModels({ category: "gpu", performance: "rendering" }, { ...scope, benchmarks: [] }, repo);
    expect(noData.models.map((model) => model.model_id)[0]).toBe("nvidia-rtx-3060-12gb");
    expect(noData.hint).toMatch(/No rendering benchmark data is installed/);
  });

  it("names the cheapest model, not the top scorer, when the price band is empty", async () => {
    const res = await listModels({ category: "gpu", performance: "rendering", price_max: 100 }, scope, repo);

    expect(res.models).toEqual([]);
    expect(res.nearest_match?.model_id).toBe("nvidia-rtx-3060-12gb");
    expect(res.matches_without_price_limit).toBe(4);
  });

  it("rejects performance outside GPUs and CPUs and malformed model_ids", async () => {
    const wrongCategory = await listModels({ category: "ram", performance: "rendering" }, scope, repo);
    expect(wrongCategory.error).toMatch(/GPUs or CPUs only/);

    const oneModel = await listModels({ category: "gpu", model_ids: ["nvidia-rtx-5070-12gb"] }, scope, repo);
    expect(oneModel.error).toMatch(/2 to 5 model_id values/);
  });
});
