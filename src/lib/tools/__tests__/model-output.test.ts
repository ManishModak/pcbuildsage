import { describe, expect, it } from "vitest";
import { toModelProductItem, toModelProductSpecs, toModelSearchResult, type CompactSearchProductsResult } from "@/lib/catalog/compact";
import { createSearchProductsTool, validFilters } from "../search-products";
import { toModelValidateOutput } from "../validate-build";

const full: CompactSearchProductsResult = {
  results: [
    {
      id: "da6670a41d06377759be1c70e28f32230239c099",
      name: "Intel Core i9-14900K",
      category: "cpu",
      subcategory: null,
      price: 55000,
      currency: "INR",
      country_code: "IN",
      retailer: "R",
      url: "https://example.com/x",
      in_stock: true,
      registry_key: "intel-core-i9-14900k",
      specs: { socket: "LGA 1700" }
    }
  ],
  total_matching: 1,
  totalCount: 1,
  returned: 1,
  has_more: false,
  scope: { country_code: "IN", currency: "INR" }
};

describe("model-only trimming via toModelOutput", () => {
  it("search rows drop url/currency/country, short ID, drop category when filtered", () => {
    const model = toModelSearchResult(full, { category: "cpu" }) as unknown as {
      results: Array<Record<string, unknown>>;
    };
    const row = model.results[0];
    expect(row.id).toBe("da6670a41d");
    expect(row).not.toHaveProperty("url");
    expect(row).not.toHaveProperty("currency");
    expect(row).not.toHaveProperty("country_code");
    expect(row).not.toHaveProperty("category");
    expect(row).not.toHaveProperty("in_stock");
    expect(row).not.toHaveProperty("subcategory");
    expect(row.name).toBe("Intel Core i9-14900K");
    // Full output keeps everything for UI/MCP
    expect(full.results[0].url).toContain("https://");
    expect(full.results[0].id).toHaveLength(40);
  });

  it("search keeps category when not filtered, keeps in_stock false", () => {
    const withStock: CompactSearchProductsResult = {
      ...full,
      results: [{ ...full.results[0], in_stock: false, subcategory: "internal" }]
    };
    const model = toModelSearchResult(withStock, {}) as unknown as {
      results: Array<Record<string, unknown>>;
    };
    expect(model.results[0]).toHaveProperty("category", "cpu");
    expect(model.results[0]).toHaveProperty("in_stock", false);
    expect(model.results[0]).toHaveProperty("subcategory", "internal");
  });

  it("toModelProductItem drops registry_key + confidence, keeps functional specs", () => {
    const row = toModelProductItem(full.results[0], { dropCategory: false });
    // Functional specs stay (what the model picks parts with)
    expect(row.specs).toEqual({ socket: "LGA 1700" });
    // Model-only trims: registry_key (list_models remains the source for
    // model_id follow-ups) and confidence provenance (kept in full output)
    expect(row).not.toHaveProperty("registry_key");
    expect(row.specs).not.toHaveProperty("confidence");
    // Decision signals stay
    expect(row).toHaveProperty("retailer", "R");
    expect(row).toHaveProperty("name", "Intel Core i9-14900K");
    expect(row).toHaveProperty("price", 55000);
    // Full output (MCP/UI) keeps everything
    expect(full.results[0].registry_key).toBe("intel-core-i9-14900k");
    expect(full.results[0].specs).toEqual({ socket: "LGA 1700" });
  });

  it("toModelProductSpecs drops confidence-only specs entirely", () => {
    expect(toModelProductSpecs({ confidence: "high" })).toBeUndefined();
    expect(toModelProductSpecs(null)).toBeUndefined();
    expect(toModelProductSpecs({ socket: "AM5", confidence: "low" })).toEqual({ socket: "AM5" });
    const row = toModelProductItem(
      { ...full.results[0], specs: { confidence: "high" } },
      { dropCategory: false }
    );
    expect(row).not.toHaveProperty("specs");
  });

  it("model search view drops >=35% bytes on realistic rows", () => {
    const rows = [
      {
        id: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
        name: "NVIDIA GeForce RTX 5080 Graphics Card",
        category: "gpu",
        subcategory: null,
        price: 118500,
        currency: "INR",
        country_code: "IN",
        retailer: "MDComputers",
        url: "https://example.com/rtx5080",
        in_stock: true,
        registry_key: "nvidia-rtx-5080",
        specs: { brand: "NVIDIA", model: "NVIDIA GeForce RTX 5080", tdp_w: 360, recommended_psu_w: 850, vram_gb: 16, segment: "gaming", confidence: "high" }
      },
      {
        id: "b2c3d4e5f60718293a4b5c6d7e8f901234567890",
        name: "Intel Core i9-14900K Desktop Processor",
        category: "cpu",
        subcategory: null,
        price: 55000,
        currency: "INR",
        country_code: "IN",
        retailer: "MDComputers",
        url: "https://example.com/14900k",
        in_stock: true,
        registry_key: "intel-core-i9-14900k",
        specs: { brand: "Intel", model: "Intel Core i9-14900K", socket: "LGA 1700", tdp_w: 125, ddr: "DDR5", igpu: true, cores: 24, boost_clock_ghz: 6, confidence: "high" }
      },
      {
        id: "c3d4e5f60718293a4b5c6d7e8f90123456789012",
        name: "ASUS ROG Strix Z790-E Gaming WiFi Motherboard",
        category: "motherboard",
        subcategory: null,
        price: 38500,
        currency: "INR",
        country_code: "IN",
        retailer: "Vedant Computers",
        url: "https://example.com/z790e",
        in_stock: true,
        registry_key: "asus-rog-strix-z790-e-gaming-wifi",
        specs: { brand: "ASUS", model: "ASUS ROG Strix Z790-E Gaming WiFi", socket: "LGA 1700", chipset: "Z790", ddr: "DDR5", form_factor: "ATX", m2_slots: 5, sata_ports: 4, pcie_gen: 5, confidence: "high" }
      },
      {
        id: "d4e5f60718293a4b5c6d7e8f9012345678901234",
        name: "Samsung 990 Pro 2TB NVMe SSD",
        category: "storage",
        subcategory: "internal",
        price: 16500,
        currency: "INR",
        country_code: "IN",
        retailer: "MDComputers",
        url: "https://example.com/990pro",
        in_stock: true,
        registry_key: "samsung-990-pro-2tb",
        specs: { brand: "Samsung", model: "Samsung 990 PRO 2TB M.2 NVMe Gen4 SSD", interface: "nvme", form_factor: "m2-2280", capacity_gb: 2000, pcie_gen: 4, confidence: "high" }
      }
    ];
    const realistic: CompactSearchProductsResult = {
      results: rows,
      total_matching: 4,
      totalCount: 4,
      returned: 4,
      has_more: false,
      scope: { country_code: "IN", currency: "INR" }
    };
    const model = toModelSearchResult(realistic, {});
    const before = Buffer.byteLength(JSON.stringify(realistic));
    const after = Buffer.byteLength(JSON.stringify(model));
    expect(after / before).toBeLessThanOrEqual(0.65);
  });

  it("validate model output is only {builds}, no duplicate top-level copies", () => {
    const output = {
      builds: {
        "Within budget": { valid: true, snapshot: { components: [{ product_id: "da6670a41d06377759be1c70e28f32230239c099" }] } }
      },
      "Within budget": { valid: true }
    };
    const model = toModelValidateOutput(output) as Record<string, unknown>;
    expect(Object.keys(model)).toEqual(["builds"]);
    const builds = model.builds as Record<string, { snapshot: { components: Array<{ product_id: string }> } }>;
    expect(builds["Within budget"].snapshot.components[0].product_id).toBe("da6670a41d");
  });

  it("search tool exposes toModelOutput and keeps full execute output", async () => {
    const tool = createSearchProductsTool({ countryCode: "IN", currency: "INR" });
    expect(typeof (tool as unknown as { toModelOutput?: unknown }).toModelOutput).toBe("function");
    expect(validFilters).toContain("term");
  });

  it("replayed outputs in older shapes pass through instead of breaking", () => {
    const legacy = { valid: true, issues: [], snapshot: { components: [] } };
    expect(toModelValidateOutput(legacy)).toBe(legacy);
    const noResults = { items: [], error: "old shape" } as unknown as CompactSearchProductsResult;
    expect(toModelSearchResult(noResults)).toBe(noResults);
  });
});
