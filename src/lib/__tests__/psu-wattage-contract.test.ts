import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { parsePsuSpecs } from "../spec-parsers";
import { resolveComponent } from "../registry";
import { validateBuild, makeResolved } from "../rules-engine";
import { BetterSqliteDriver } from "../catalog/sql-driver";
import { SqlCatalogRepository } from "../catalog/sql-repository";
import type { Product } from "@/types/db";

describe("PSU Wattage Contract", () => {
  it("parses RX750 title into canonical wattage and preserves derived provenance", () => {
    const title = "Ant Esports RX750 750W 80 Plus Bronze Power Supply";
    const parsed = parsePsuSpecs(title);

    expect(parsed).toBeDefined();
    expect(parsed?.wattage).toBe(750);
    expect(parsed?.wattage_w).toBe(750);

    const resolved = resolveComponent(
      { name: title, category: "psu" },
      { skipDbLookup: true }
    );
    expect(resolved).toBeDefined();
    expect(resolved?.source).toBe("derived");
    expect(resolved?.confidence).toBe("medium");
    expect(resolved?.spec.wattage).toBe(750);
  });

  it("validates build with derived RX750 PSU without triggering missing-wattage research", () => {
    const rx750Resolved = resolveComponent(
      { name: "Ant Esports RX750 750W 80 Plus Bronze Power Supply", category: "psu" },
      { skipDbLookup: true }
    )!;

    const cpu = makeResolved("cpu-7600", "cpu", {
      brand: "AMD",
      model: "Ryzen 5 7600",
      aliases: ["Ryzen 5 7600"],
      socket: "AM5",
      tdp_w: 65,
      igpu: true
    });

    const result = validateBuild(
      { cpu: "cpu-7600", psu: rx750Resolved.key },
      {
        resolve: (key) => (key === "cpu-7600" ? cpu : key === rx750Resolved.key ? rx750Resolved : undefined)
      }
    );

    // Headroom check passes: (65 + 0 + 50) * 1.2 = 138W <= 750W
    const wattageIssue = result.issues.find((i) => i.rule === "wattage");
    expect(wattageIssue).toBeUndefined();
    expect(result.skipped_checks).not.toContain("wattage");
  });

  it("accepts legacy records with only wattage_w and preserves provenance", () => {
    const legacyPsu = makeResolved("psu-legacy-650", "psu", {
      brand: "Corsair",
      model: "Legacy 650",
      aliases: ["Legacy 650"],
      wattage_w: 650
    });

    const cpu = makeResolved("cpu-7600", "cpu", {
      brand: "AMD",
      model: "Ryzen 5 7600",
      aliases: ["Ryzen 5 7600"],
      socket: "AM5",
      tdp_w: 65,
      igpu: true
    });

    const result = validateBuild(
      { cpu: "cpu-7600", psu: legacyPsu.key },
      {
        resolve: (key) => (key === "cpu-7600" ? cpu : key === legacyPsu.key ? legacyPsu : undefined)
      }
    );

    const wattageIssue = result.issues.find((i) => i.rule === "wattage");
    expect(wattageIssue).toBeUndefined();
  });

  it("surfaces a conflict when wattage and wattage_w disagree rather than silently passing", () => {
    const conflictingPsu = makeResolved("psu-conflict", "psu", {
      brand: "Corsair",
      model: "Conflict PSU",
      aliases: ["Conflict PSU"],
      wattage: 750,
      wattage_w: 550
    });

    const cpu = makeResolved("cpu-7600", "cpu", {
      brand: "AMD",
      model: "Ryzen 5 7600",
      aliases: ["Ryzen 5 7600"],
      socket: "AM5",
      tdp_w: 65,
      igpu: true
    });

    const result = validateBuild(
      { cpu: "cpu-7600", psu: conflictingPsu.key },
      {
        resolve: (key) => (key === "cpu-7600" ? cpu : key === conflictingPsu.key ? conflictingPsu : undefined)
      }
    );

    const conflictIssue = result.issues.find((i) => i.rule === "wattage" && i.severity === "needs_verification");
    expect(conflictIssue).toBeDefined();
    expect(conflictIssue?.detail).toContain("Conflicting wattage specifications");
  });

  it("requests research when wattage is genuinely missing", () => {
    const missingPsu = makeResolved("psu-unknown", "psu", {
      brand: "Generic",
      model: "Mystery PSU",
      aliases: ["Mystery PSU"]
    });

    const cpu = makeResolved("cpu-7600", "cpu", {
      brand: "AMD",
      model: "Ryzen 5 7600",
      aliases: ["Ryzen 5 7600"],
      socket: "AM5",
      tdp_w: 65,
      igpu: true
    });

    const result = validateBuild(
      { cpu: "cpu-7600", psu: missingPsu.key },
      {
        resolve: (key) => (key === "cpu-7600" ? cpu : key === missingPsu.key ? missingPsu : undefined)
      }
    );

    const researchIssue = result.issues.find(
      (i) => i.rule === "spec_resolution" && i.detail.includes("\"wattage\"")
    );
    expect(researchIssue).toBeDefined();
  });

  it("agrees between search filtering and validation for canonical and legacy PSU records", async () => {
    const db = new Database(":memory:");
    const driver = new BetterSqliteDriver(db);
    db.exec(`
      CREATE TABLE products (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        normalized_name TEXT,
        category TEXT NOT NULL,
        subcategory TEXT,
        price REAL,
        currency TEXT NOT NULL,
        country_code TEXT NOT NULL,
        retailer TEXT NOT NULL,
        url TEXT NOT NULL,
        image_url TEXT,
        in_stock INTEGER NOT NULL,
        registry_key TEXT,
        specs TEXT,
        first_seen TEXT,
        last_scraped TEXT
      )
    `);

    const products: Array<Partial<Product>> = [
      {
        id: "1",
        name: "PSU Canonical 750",
        category: "psu",
        price: 6000,
        currency: "INR",
        country_code: "IN",
        retailer: "Store",
        url: "http://example.com/1",
        in_stock: 1,
        registry_key: "psu-canonical-750"
      },
      {
        id: "2",
        name: "PSU Legacy 650",
        category: "psu",
        price: 5000,
        currency: "INR",
        country_code: "IN",
        retailer: "Store",
        url: "http://example.com/2",
        in_stock: 1,
        registry_key: "psu-legacy-650"
      },
      {
        id: "3",
        name: "PSU Low 450",
        category: "psu",
        price: 3500,
        currency: "INR",
        country_code: "IN",
        retailer: "Store",
        url: "http://example.com/3",
        in_stock: 1,
        registry_key: "psu-low-450"
      }
    ];

    products.push({ ...products[0], id: "4", name: "Conflicting PSU", registry_key: "psu-conflict" });
    for (const p of products) {
      db.prepare(
        `INSERT INTO products (id, name, category, price, currency, country_code, retailer, url, in_stock, registry_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(p.id, p.name, p.category, p.price, p.currency, p.country_code, p.retailer, p.url, p.in_stock, p.registry_key);
    }

    const mockSpecs = new Map([
      ["psu-canonical-750", { brand: "Corsair", model: "RM750", aliases: [], wattage: 750 }],
      ["psu-legacy-650", { brand: "Corsair", model: "CV650", aliases: [], wattage_w: 650 }],
      ["psu-low-450", { brand: "Corsair", model: "CV450", aliases: [], wattage: 450 }],
      ["psu-conflict", { brand: "Corsair", model: "Conflict", aliases: [], wattage: 750, wattage_w: 550 }]
    ]);

    const repo = new SqlCatalogRepository(driver, (prod) => {
      const spec = prod.registry_key ? mockSpecs.get(prod.registry_key) : undefined;
      return spec
        ? {
            key: prod.registry_key!,
            category: "psu",
            spec,
            source: "registry",
            confidence: "high"
          }
        : undefined;
    });

    const searchRes = await repo.searchProducts(
      { category: "psu", min_wattage: 650 },
      { countryCode: "IN", currency: "INR" }
    );

    expect(searchRes.results.map((r) => r.registry_key)).toEqual(["psu-canonical-750", "psu-legacy-650"]);
    db.close();
  });
});
