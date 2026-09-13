import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initializeSchema } from "@/lib/db";
import type { Product } from "@/types/db";
import { SqliteCatalogRepository } from "@/lib/catalog/sqlite-repository";
import { listModels, listModelsInputSchema, createListModelsTool } from "@/lib/tools/list-models";
import type { CatalogScope } from "@/lib/catalog/repository";

function createInMemoryDb(): Database.Database {
  const db = new Database(":memory:");
  initializeSchema(db);
  return db;
}

function insertProduct(
  db: Database.Database,
  product: Partial<Omit<Product, "specs">> & { specs?: string | Record<string, unknown> | null }
) {
  const now = new Date().toISOString();
  const row = {
    id: product.id ?? `prod-${Math.random().toString(36).slice(2, 8)}`,
    name: product.name ?? "Test Product",
    normalized_name: product.normalized_name ?? product.name?.toLowerCase() ?? "test product",
    registry_key: product.registry_key ?? null,
    price: product.price !== undefined ? product.price : 100,
    currency: product.currency ?? "USD",
    country_code: product.country_code ?? "US",
    retailer: product.retailer ?? "RetailerX",
    url: product.url ?? `https://example.com/${product.id}`,
    image_url: product.image_url ?? null,
    in_stock: product.in_stock !== undefined ? product.in_stock : 1,
    category: product.category ?? "cpu",
    subcategory: product.subcategory ?? null,
    specs: typeof product.specs === "object" ? JSON.stringify(product.specs) : (product.specs ?? null),
    first_seen: product.first_seen ?? now,
    last_scraped: product.last_scraped ?? now
  };

  db.prepare(`
    INSERT INTO products (
      id, name, normalized_name, registry_key, price, currency,
      country_code, retailer, url, image_url, in_stock, category,
      subcategory, specs, first_seen, last_scraped
    ) VALUES (
      @id, @name, @normalized_name, @registry_key, @price, @currency,
      @country_code, @retailer, @url, @image_url, @in_stock, @category,
      @subcategory, @specs, @first_seen, @last_scraped
    )
  `).run(row);
  return row;
}

describe("list_models tool & repository implementation", () => {
  let db: Database.Database;
  let repo: SqliteCatalogRepository;
  const scope: CatalogScope = { countryCode: "US", currency: "USD" };

  beforeEach(() => {
    db = createInMemoryDb();
    repo = new SqliteCatalogRepository(db);
  });

  afterEach(async () => {
    await repo.close();
    db.close();
  });

  describe("model aggregation", () => {
    it("aggregates multiple listings of the same model into a single item with price range and listing count", async () => {
      insertProduct(db, {
        id: "asus-4070",
        name: "ASUS Dual GeForce RTX 4070 OC",
        registry_key: "nvidia-rtx-4070",
        price: 549,
        category: "gpu",
        specs: { brand: "NVIDIA", model: "NVIDIA GeForce RTX 4070", vram_gb: 12, tdp_w: 200 }
      });

      insertProduct(db, {
        id: "msi-4070",
        name: "MSI Ventus 2X GeForce RTX 4070",
        registry_key: "nvidia-rtx-4070",
        price: 529,
        category: "gpu",
        specs: { brand: "NVIDIA", model: "NVIDIA GeForce RTX 4070", vram_gb: 12, tdp_w: 200 }
      });

      insertProduct(db, {
        id: "gigabyte-4070",
        name: "Gigabyte Windforce GeForce RTX 4070",
        registry_key: "nvidia-rtx-4070",
        price: 569,
        category: "gpu",
        specs: { brand: "NVIDIA", model: "NVIDIA GeForce RTX 4070", vram_gb: 12, tdp_w: 200 }
      });

      const res = await listModels({ category: "gpu" }, scope, repo);

      expect(res.models).toHaveLength(1);
      const model = res.models[0];
      expect(model.model_id).toBe("nvidia-rtx-4070-12gb");
      expect(model.name).toBe("NVIDIA GeForce RTX 4070");
      expect(model.category).toBe("gpu");
      expect(model.listing_count).toBe(3);
      expect(model.price_range).toEqual({ min: 529, max: 569 });
      expect(model.specs.vram_gb).toBe(12);
      expect(model.specs.tdp_w).toBe(200);
      expect(res.total_matching_models).toBe(1);
      expect(res.returned_models).toBe(1);
      expect(res.truncated).toBe(false);
    });
  });

  describe("variant separation", () => {
    it("distinguishes GPU VRAM variants (e.g. 8GB vs 16GB) as separate models", async () => {
      insertProduct(db, {
        id: "4060ti-8gb-1",
        name: "ASUS Dual RTX 4060 Ti 8GB",
        registry_key: "nvidia-rtx-4060-ti",
        price: 399,
        category: "gpu",
        specs: { brand: "NVIDIA", model: "RTX 4060 Ti", vram_gb: 8, tdp_w: 160 }
      });

      insertProduct(db, {
        id: "4060ti-8gb-2",
        name: "MSI Ventus RTX 4060 Ti 8GB",
        registry_key: "nvidia-rtx-4060-ti",
        price: 389,
        category: "gpu",
        specs: { brand: "NVIDIA", model: "RTX 4060 Ti", vram_gb: 8, tdp_w: 160 }
      });

      insertProduct(db, {
        id: "4060ti-16gb-1",
        name: "Gigabyte Gaming RTX 4060 Ti 16GB",
        registry_key: "nvidia-rtx-4060-ti",
        price: 479,
        category: "gpu",
        specs: { brand: "NVIDIA", model: "RTX 4060 Ti", vram_gb: 16, tdp_w: 165 }
      });

      const res = await listModels({ category: "gpu" }, scope, repo);

      expect(res.models).toHaveLength(2);
      const model8gb = res.models.find((m) => m.specs.vram_gb === 8);
      const model16gb = res.models.find((m) => m.specs.vram_gb === 16);

      expect(model8gb).toBeDefined();
      expect(model8gb?.model_id).toContain("8gb");
      expect(model8gb?.listing_count).toBe(2);
      expect(model8gb?.price_range).toEqual({ min: 389, max: 399 });

      expect(model16gb).toBeDefined();
      expect(model16gb?.model_id).toContain("16gb");
      expect(model16gb?.listing_count).toBe(1);
      expect(model16gb?.price_range).toEqual({ min: 479, max: 479 });
    });

    it("distinguishes storage capacity variants (e.g. 1TB vs 2TB) as separate models", async () => {
      insertProduct(db, {
        id: "980pro-1tb",
        name: "Samsung 980 Pro 1TB NVMe SSD",
        registry_key: "samsung-980-pro",
        price: 89,
        category: "storage",
        specs: { brand: "Samsung", model: "Samsung 980 Pro", capacity_gb: 1000, interface: "nvme" }
      });

      insertProduct(db, {
        id: "980pro-2tb",
        name: "Samsung 980 Pro 2TB NVMe SSD",
        registry_key: "samsung-980-pro",
        price: 159,
        category: "storage",
        specs: { brand: "Samsung", model: "Samsung 980 Pro", capacity_gb: 2000, interface: "nvme" }
      });

      const res = await listModels({ category: "storage" }, scope, repo);

      expect(res.models).toHaveLength(2);
      const model1tb = res.models.find((m) => m.specs.capacity_gb === 1000);
      const model2tb = res.models.find((m) => m.specs.capacity_gb === 2000);

      expect(model1tb).toBeDefined();
      expect(model1tb?.model_id).not.toBe(model2tb?.model_id);
      expect(model1tb?.price_range).toEqual({ min: 89, max: 89 });
      expect(model2tb?.price_range).toEqual({ min: 159, max: 159 });
    });

    it("preserves variant model ID (e.g. test-family-16gb) stably with and without variant filters [r5]", async () => {
      insertProduct(db, {
        id: "tf-8",
        name: "Test Family 8GB",
        registry_key: "test-family",
        price: 300,
        category: "gpu",
        specs: { brand: "TestBrand", model: "Test Family", vram_gb: 8 }
      });
      insertProduct(db, {
        id: "tf-16",
        name: "Test Family 16GB",
        registry_key: "test-family",
        price: 450,
        category: "gpu",
        specs: { brand: "TestBrand", model: "Test Family", vram_gb: 16 }
      });

      // Without filter: both variants returned with stable suffixes
      const resUnfiltered = await listModels({ category: "gpu" }, scope, repo);
      expect(resUnfiltered.models).toHaveLength(2);
      const m8 = resUnfiltered.models.find((m) => m.specs.vram_gb === 8);
      const m16 = resUnfiltered.models.find((m) => m.specs.vram_gb === 16);
      expect(m8?.model_id).toBe("test-family-8gb");
      expect(m16?.model_id).toBe("test-family-16gb");

      // With variant-isolating filter: 16gb variant retains exact same model_id
      const resFiltered = await listModels({ category: "gpu", min_vram_gb: 16 }, scope, repo);
      expect(resFiltered.models).toHaveLength(1);
      expect(resFiltered.models[0].model_id).toBe("test-family-16gb");

      // Verify searchProducts({ model_id: 'test-family-16gb' }) retrieves exact variant
      const searchRes = await repo.searchProducts({ model_id: "test-family-16gb" }, scope);
      expect(searchRes.results).toHaveLength(1);
      expect(searchRes.results[0].id).toBe("tf-16");
    });

    it("includes wattage suffix for PSU model IDs and matches in searchProducts [r5]", async () => {
      insertProduct(db, {
        id: "psu-rm750x",
        name: "Corsair RM750x",
        registry_key: "corsair-rm750x",
        price: 119,
        category: "psu",
        specs: { brand: "Corsair", wattage: 750 }
      });
      insertProduct(db, {
        id: "psu-rm850x",
        name: "Corsair RM850x",
        registry_key: "corsair-rm850x",
        price: 139,
        category: "psu",
        specs: { brand: "Corsair", wattage: 850 }
      });

      const res = await listModels({ category: "psu" }, scope, repo);
      expect(res.models).toHaveLength(2);
      const rm750 = res.models.find((m) => m.specs.wattage === 750);
      const rm850 = res.models.find((m) => m.specs.wattage === 850);
      expect(rm750?.model_id).toBe("corsair-rm750x-750w");
      expect(rm850?.model_id).toBe("corsair-rm850x-850w");

      // Verify exact variant retrieval via searchProducts
      const searchRes = await repo.searchProducts({ model_id: "corsair-rm750x-750w" }, scope);
      expect(searchRes.results).toHaveLength(1);
      expect(searchRes.results[0].id).toBe("psu-rm750x");
    });
  });

  describe("truncation and pagination", () => {
    it("truncates models when total exceeds limit and sets truncated flag and hint", async () => {
      for (let i = 1; i <= 5; i++) {
        insertProduct(db, {
          id: `cpu-${i}`,
          name: `Ryzen Model ${i}`,
          registry_key: `amd-ryzen-${i}`,
          price: 100 * i,
          category: "cpu",
          specs: { brand: "AMD", model: `Ryzen ${i}`, socket: "AM5" }
        });
      }

      const res = await listModels({ category: "cpu", limit: 3 }, scope, repo);

      expect(res.total_matching_models).toBe(5);
      expect(res.returned_models).toBe(3);
      expect(res.models).toHaveLength(3);
      expect(res.truncated).toBe(true);
      expect(res.hint).toContain("Showing 3 of 5 matching models");
    });

    it("defaults to limit 20 and does not truncate when total <= limit", async () => {
      insertProduct(db, {
        id: "psu-1",
        name: "Corsair RM750e",
        registry_key: "corsair-rm750e",
        price: 99,
        category: "psu",
        specs: { brand: "Corsair", wattage: 750 }
      });

      const res = await listModels({ category: "psu" }, scope, repo);

      expect(res.total_matching_models).toBe(1);
      expect(res.returned_models).toBe(1);
      expect(res.truncated).toBe(false);
      expect(res.models).toHaveLength(1);
    });
  });

  describe("filtering criteria", () => {
    it("filters by min_vram_gb", async () => {
      insertProduct(db, {
        id: "gpu-8gb",
        name: "GPU 8GB",
        registry_key: "gpu-8gb",
        price: 300,
        category: "gpu",
        specs: { vram_gb: 8 }
      });

      insertProduct(db, {
        id: "gpu-16gb",
        name: "GPU 16GB",
        registry_key: "gpu-16gb",
        price: 500,
        category: "gpu",
        specs: { vram_gb: 16 }
      });

      const res = await listModels({ category: "gpu", min_vram_gb: 12 }, scope, repo);
      expect(res.models).toHaveLength(1);
      expect(res.models[0].specs.vram_gb).toBe(16);
    });

    it("filters by price bounds", async () => {
      insertProduct(db, {
        id: "cheap-cpu",
        name: "Budget CPU",
        registry_key: "budget-cpu",
        price: 80,
        category: "cpu"
      });

      insertProduct(db, {
        id: "mid-cpu",
        name: "Mid CPU",
        registry_key: "mid-cpu",
        price: 200,
        category: "cpu"
      });

      insertProduct(db, {
        id: "high-cpu",
        name: "High CPU",
        registry_key: "high-cpu",
        price: 500,
        category: "cpu"
      });

      const res = await listModels({ category: "cpu", price_min: 100, price_max: 300 }, scope, repo);
      expect(res.models).toHaveLength(1);
      expect(res.models[0].model_id).toBe("mid-cpu");
    });

    it("returns defensive hint when price_min > price_max", async () => {
      const res = await listModels({ price_min: 500, price_max: 100 }, scope, repo);
      expect(res.models).toEqual([]);
      expect(res.hint).toContain("price_min (500) cannot be greater than price_max (100)");
    });

    it("matches socket, ddr, and form_factor case-insensitively and canonicalized", async () => {
      insertProduct(db, {
        id: "cpu-am5",
        name: "AMD Ryzen 5 7600",
        registry_key: "amd-ryzen-5-7600",
        category: "cpu",
        specs: { socket: "AM5" }
      });
      insertProduct(db, {
        id: "mobo-matx",
        name: "MSI B650M Mortar",
        registry_key: "msi-b650m-mortar",
        category: "motherboard",
        specs: { socket: "AM5", form_factor: "micro-atx", ddr: "DDR5" }
      });

      // Socket filter: lowercase "am5" matches "AM5"
      const resSocket = await listModels({ category: "cpu", socket: "am5" }, scope, repo);
      expect(resSocket.models).toHaveLength(1);
      expect(resSocket.models[0].model_id).toBe("amd-ryzen-5-7600");

      // Form factor filter: "Micro-ATX" matches "micro-atx"
      const resForm = await listModels({ category: "motherboard", form_factor: "Micro-ATX" }, scope, repo);
      expect(resForm.models).toHaveLength(1);
      expect(resForm.models[0].model_id).toBe("msi-b650m-mortar");

      // DDR filter: "DDR5" matches "DDR5" / case-insensitive
      const resDdr = await listModels({ category: "motherboard", ddr: "DDR5" }, scope, repo);
      expect(resDdr.models).toHaveLength(1);
      expect(resDdr.models[0].model_id).toBe("msi-b650m-mortar");
    });

    it("returns error on unknown filter", async () => {
      const res = await listModels({ bad_param: 123 } as unknown as Parameters<typeof listModels>[0], scope, repo);
      expect(res.models).toEqual([]);
      expect(res.error).toContain("Unknown filter(s): bad_param");
    });
  });

  describe("tool wrapper execution", () => {
    it("createListModelsTool executes seamlessly with input schema", async () => {
      insertProduct(db, {
        id: "cooler-1",
        name: "Noctua NH-D15",
        registry_key: "noctua-nh-d15",
        price: 109,
        category: "cooler",
        specs: { brand: "Noctua", height_mm: 165 }
      });

      const listTool = createListModelsTool(scope, repo);
      expect(listTool.description).toBeDefined();

      const parsed = listModelsInputSchema.parse({ category: "cooler" });
      const result = await (listTool as unknown as { execute(inp: unknown): Promise<unknown> }).execute(parsed);

      expect((result as { models: unknown[] }).models).toHaveLength(1);
    });
  });
});
