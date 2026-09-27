import { describe, expect, it } from "vitest";
import { listRegistrySpecs, resolveComponent, withTitleGpuLength, type ResolvedSpec } from "../registry";
import type Database from "better-sqlite3";

describe("resolveComponent research lookup", () => {
  it("scopes research lookup by category before choosing the newest row", () => {
    const rows = [
      { key: "lookup-mask-key", category: "gpu", specs: JSON.stringify({ brand: "Wrong", model: "GPU", aliases: [] }), sources: "[]", confidence: "medium", researched_at: "2026-02-01T00:00:00.000Z" },
      { key: "older-correct-component", category: "cpu", specs: JSON.stringify({ brand: "Right", model: "CPU", aliases: [], socket: "AM5" }), sources: "[]", confidence: "medium", researched_at: "2026-01-01T00:00:00.000Z" }
    ];
    const db = {
      prepare: (sql: string) => ({
        get: (key: string, slug: string, category?: string) => rows
          .filter((row) => row.key === key || row.key === slug)
          .filter((row) => !sql.includes("category = ?") || row.category === category)
          .sort((a, b) => b.researched_at.localeCompare(a.researched_at))[0]
      })
    };

    const resolved = resolveComponent({ key: "lookup-mask-key", name: "Older Correct Component", category: "cpu" }, { db: db as unknown as Database.Database });
    expect(resolved).toMatchObject({ key: "older-correct-component", category: "cpu", spec: expect.objectContaining({ socket: "AM5" }) });
  });
});

/** A db with no research rows at all, so the fallback chain runs to the end. */
const emptyDb = { prepare: () => ({ get: () => undefined }) } as unknown as Database.Database;

describe("resolveComponent trust model", () => {
  it("trusts a registry entry if and only if it cites sources", () => {
    // The invariant the whole trust model rests on. Stated as a property over the
    // real registry rather than one entry, so it keeps holding as entries get
    // researched and promoted: an entry with citations is trustworthy, one without
    // is a placeholder. Trusting placeholders is what let the RTX 5090 be read as
    // an 8GB / 200W card and still pass PSU sizing.
    for (const entry of listRegistrySpecs()) {
      const sourced = Array.isArray(entry.spec.sources) && entry.spec.sources.length > 0;
      const declared = entry.spec.confidence;
      const expected = declared ?? (sourced ? "high" : "low");
      expect(entry.confidence, `${entry.key} (sources: ${sourced})`).toBe(expected);
      if (!sourced && !declared) expect(entry.confidence, `${entry.key} has no sources`).toBe("low");
    }
  });

  it("prefers a sourced research row over an unsourced registry placeholder", () => {
    const db = {
      prepare: () => ({
        get: () => ({
          key: "nvidia-rtx-4050",
          category: "gpu",
          specs: JSON.stringify({ brand: "NVIDIA", model: "RTX 4050", aliases: [], tdp_w: 115, vram_gb: 6 }),
          sources: JSON.stringify(["https://www.nvidia.com/"]),
          confidence: "medium",
          researched_at: "2026-03-01T00:00:00.000Z"
        })
      })
    } as unknown as Database.Database;

    const resolved = resolveComponent({ key: "nvidia-rtx-4050", category: "gpu" }, { db });
    expect(resolved).toMatchObject({ source: "research", confidence: "medium" });
    expect(resolved?.spec.tdp_w).toBe(115);
  });

  it("derives storage specs from the product title when nothing else resolves", () => {
    const resolved = resolveComponent(
      { name: "Acer Predator GM7 1TB M.2 NVMe Gen4 7400MB/s Internal SSD", category: "storage" },
      { db: emptyDb }
    );
    expect(resolved).toMatchObject({ source: "derived", confidence: "medium", category: "storage" });
    expect(resolved?.spec).toMatchObject({ interface: "nvme", capacity_gb: 1000, pcie_gen: 4 });
  });

  it("returns nothing for an unknown component in a category with no title parser", () => {
    expect(resolveComponent({ name: "Totally Unknown Widget 9000", category: "cpu" }, { db: emptyDb })).toBeUndefined();
  });
});

describe("GPU variant identity", () => {
  it("corrects an 8GB offer linked to the 16GB registry variant and flags the conflict", () => {
    const result = resolveComponent({ category: "gpu", key: "amd-rx-9060-xt-16gb", name: "ASRock RX 9060 XT Steel Legend 8GB OC GDDR6 Graphics Card" }, { skipDbLookup: true });
    expect(result?.key).toBe("amd-rx-9060-xt-8gb");
    expect(result?.spec.vram_gb).toBe(8);
    expect(result?.spec.spec_conflict).toContain("conflicts");
  });

  it("matches model and capacity despite intervening retailer words", () => {
    const result = resolveComponent({ category: "gpu", name: "ASUS RTX 5060 Ti Dual OC 16GB GDDR7" }, { skipDbLookup: true });
    expect(result?.key).toBe("nvidia-rtx-5060-ti-16gb");
    expect(result?.spec.vram_gb).toBe(16);
  });

  it("does not reuse wrong-variant power or dimensions when no matching variant exists", () => {
    const result = resolveComponent({ category: "gpu", key: "amd-rx-9060-xt-16gb", name: "ASRock RX 9060 XT 24GB" }, { skipDbLookup: true });
    expect(result?.spec.vram_gb).toBe(24);
    expect(result?.spec.tdp_w).toBeUndefined();
    expect(result?.spec.length_mm).toBeUndefined();
    expect(result?.spec.spec_conflict).toBeDefined();
  });
});

describe("registry deduplication and legacy keys", () => {
  it("does not return duplicate entries in listRegistrySpecs", () => {
    const allSpecs = listRegistrySpecs();
    const keys = allSpecs.map((s) => s.key);
    const uniqueKeys = new Set(keys);
    expect(keys.length).toBe(uniqueKeys.size);

    const psuSpecs = listRegistrySpecs("psu");
    const psuKeys = psuSpecs.map((s) => s.key);
    expect(psuKeys.length).toBe(new Set(psuKeys).size);

    const ramSpecs = listRegistrySpecs("ram");
    const ramKeys = ramSpecs.map((s) => s.key);
    expect(ramKeys.length).toBe(new Set(ramKeys).size);
  });

  it("resolves legacy keys via resolveComponent without adding duplicate registry listings", () => {
    const psu = resolveComponent({ key: "be-quiet-dark-power-pro-12-850w", category: "psu" }, { skipDbLookup: true });
    expect(psu?.key).toBe("be-quiet-dark-power-12-850w");

    const ram = resolveComponent({ key: "g-skill-ripjaws-v-16gb-ddr4-3200", category: "ram" }, { skipDbLookup: true });
    expect(ram?.key).toBe("g-skill-ripjaws-v-16gb-2x8gb-ddr4-3200");
  });
});


describe("registry RAM capacity normalization (moved from rules Item 3)", () => {
      it("normalizes registry RAM capacity strings to capacity_gb across listRegistrySpecs", () => {
        const ramSpecs = listRegistrySpecs("ram");
        const ram16 = ramSpecs.find((r) => r.spec.capacity === "16GB");
        expect(ram16).toBeDefined();
        expect(ram16?.spec.capacity_gb).toBe(16);

        const ram8 = ramSpecs.find((r) => r.spec.capacity === "8GB");
        expect(ram8).toBeDefined();
        expect(ram8?.spec.capacity_gb).toBe(8);
      });
});

describe("GPU variants and exact dimensions (moved from rules Item 5)", () => {
      it("resolves 16G token to 16GB GPU variant", () => {
        const resolved = resolveComponent("Gigabyte RTX 4060 Ti Gaming OC 16G");
        expect(resolved).toBeDefined();
        expect(resolved?.key).toBe("nvidia-rtx-4060-ti-16gb");
        expect(resolved?.spec.vram_gb).toBe(16);
      });
      it("does not silently resolve ambiguous capacity to 8GB", () => {
        const resolved = resolveComponent("Gigabyte RTX 4060 Ti 8GB 16GB");
        expect(resolved?.key).not.toBe("nvidia-rtx-4060-ti-8gb");
      });
      it("identifies RX 7900 GRE as distinct family", () => {
        const resolved = resolveComponent("PowerColor Radeon RX 7900 GRE 16GB");
        expect(resolved).toBeDefined();
        expect(resolved?.key).toBe("amd-rx-7900-gre");
      });
      it("merges explicitly stated dimensions from listing title into resolved generic GPU spec", () => {
        const resolvedWithLen = resolveComponent("Gigabyte RTX 4070 SUPER Gaming OC 12G (card length: 304mm)");
        expect(resolvedWithLen?.spec.length_mm).toBe(304);
        expect(resolvedWithLen?.spec.length_mm_source).toBe("listing-title");

        const resolvedWithoutLen = resolveComponent("Gigabyte RTX 4070 SUPER Gaming OC 12G");
        expect(resolvedWithoutLen?.spec.length_mm).toBeUndefined();
      });
      it("flags conflicting title dimensions without erasing trusted GPU facts", () => {
        const hit: ResolvedSpec = {
          key: "sapphire-pure-rx-7700-xt",
          category: "gpu",
          spec: { brand: "Sapphire", model: "Sapphire PURE AMD Radeon RX 7700 XT 12GB", aliases: [], length_mm: 320, vram_gb: 12 },
          source: "registry",
          confidence: "high"
        };
        const conflicted = withTitleGpuLength(hit, "Sapphire PURE RX 7700 XT (card length: 300mm)");
        expect(conflicted.spec.length_mm).toBe(320);
        expect(conflicted.spec.vram_gb).toBe(12);
        expect(conflicted.spec.spec_conflict).toContain("300mm");
        expect(conflicted.spec.spec_conflict).toContain("320mm");

        const agreed = withTitleGpuLength(hit, "Sapphire PURE RX 7700 XT (card length: 320mm)");
        expect(agreed.spec.spec_conflict).toBeUndefined();
        expect(agreed.spec.length_mm).toBe(320);
      });
      it("resolves legacy keys without duplicate listings", () => {
        const specs = listRegistrySpecs();
        const keys = specs.map((s) => s.key);
        expect(new Set(keys).size).toBe(keys.length);
        expect(keys).toContain("be-quiet-dark-power-12-850w");
        expect(keys).not.toContain("be-quiet-dark-power-pro-12-850w");
      });
});

describe("product identity and evidence (moved from rules Item 9)", () => {
      it("resolves Dark Power 12 850W via canonical and legacy keys without misleading Pro name matching", () => {
        const canonical = resolveComponent("be-quiet-dark-power-12-850w");
        expect(canonical).toBeDefined();
        expect(canonical?.spec.model).toBe("be quiet! Dark Power 12 850W");

        // Legacy key reference resolves to canonical spec
        const legacy = resolveComponent("be-quiet-dark-power-pro-12-850w");
        expect(legacy).toBeDefined();
        expect(legacy?.spec.model).toBe("be quiet! Dark Power 12 850W");

        // "Dark Power Pro 12" name query must not falsely resolve to non-Pro 850W model
        const proSearch = resolveComponent("be quiet! Dark Power Pro 12");
        expect(proSearch?.key).not.toBe("be-quiet-dark-power-12-850w");
      });
      it("ensures Ant Esports VS records do not assert unsupported 80+ efficiency", () => {
        const vs500 = resolveComponent("ant-esports-vs500l");
        expect(vs500?.spec.wattage).toBe(500);
        expect(vs500?.spec.efficiency).toBeUndefined();

        const vs650 = resolveComponent("ant-esports-vs650l");
        expect(vs650?.spec.wattage).toBe(650);
        expect(vs650?.spec.efficiency).toBeUndefined();
      });
      it("resolves consolidated Ripjaws DDR4 2x8GB canonical and legacy keys while keeping 1x16GB distinct", () => {
        const canonical2x8 = resolveComponent("g-skill-ripjaws-v-16gb-2x8gb-ddr4-3200");
        expect(canonical2x8).toBeDefined();
        expect(canonical2x8?.spec.modules).toBe(2);

        // Legacy key resolves to canonical 2x8GB
        const legacy2x8 = resolveComponent("g-skill-ripjaws-v-16gb-ddr4-3200");
        expect(legacy2x8).toBeDefined();
        expect(legacy2x8?.spec.modules).toBe(2);

        // 1x16GB remains distinct with modules: 1
        const single16 = resolveComponent("g-skill-ripjaws-v-16gb-1x16gb-ddr4-3200");
        expect(single16).toBeDefined();
        expect(single16?.spec.modules).toBe(1);
      });
});
