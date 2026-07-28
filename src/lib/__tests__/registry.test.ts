import { describe, expect, it } from "vitest";
import { listRegistrySpecs, resolveComponent } from "../registry";
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
