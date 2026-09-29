/**
 * Review fixes on top of Track R: variant conflicts on canonical registry
 * keys, CPU support softening/tightening, RAM form factor wording and
 * dashless ITX names. Each test fails without its fix.
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { makeResolved, validateBuild, type BuildPart } from "../../rules-engine";
import { loadRegistry, resolveComponent, titleConflictsWithSpec, type ComponentCategory, type ResolvedSpec } from "../../registry";
import { parseMotherboardSpecs, parseRamSpecs } from "../../spec-parsers";
import { checkCpuSupport, inferCpuIdentity } from "../cpu-support";
import type { BuildIssue } from "../../rules-engine";

function resolveWith(specs: Partial<Record<ComponentCategory, ResolvedSpec>>) {
  return (part: BuildPart, category: ComponentCategory) => {
    const key = typeof part === "string" ? part : part.key;
    const value = specs[category];
    return value && value.key === key ? value : undefined;
  };
}

const cpu = (model: string) =>
  makeResolved(model.toLowerCase().replace(/\s+/g, "-"), "cpu", { brand: model.split(" ")[0] ?? "", model, aliases: [model] });
const board = (chipset: string) =>
  makeResolved(`board-${chipset.toLowerCase()}`, "motherboard", { brand: "Board", model: `Board ${chipset}`, aliases: [chipset], chipset });

/** Runs the CPU-support rule alone; returns its check status and issues. */
function support(cpuModel: string, chipset: string) {
  const checks: Array<{ status: string; message: string }> = [];
  const issues: BuildIssue[] = [];
  checkCpuSupport(cpu(cpuModel), board(chipset), (_rule, status, _c, message) => checks.push({ status, message }), issues);
  return { status: checks[0]?.status, message: checks[0]?.message ?? "", issues };
}

describe("canonical registry_key hits are guarded against title conflicts", () => {
  // Real catalog rows whose scrape-time registry_key points at the wrong variant.
  const rows = [
    { key: "msi-pro-b760m-a-wifi", name: "MSI Pro B760M-A WIFI DDR4 Motherboard", ddr: "DDR4", resolvedKey: "msi-pro-b760m-a-wifi-ddr4" },
    { key: "gigabyte-z790-aorus-elite-ax", name: "Gigabyte Z790 S WIFI DDR4 ATX Motherboard Z790-S-WIFI-DDR4", ddr: "DDR4" },
    { key: "asrock-b650m-pro-rs", name: "ASRock B650 Pro RS ATX Motherboard", formFactor: "ATX" }
  ];

  for (const row of rows) {
    it(`does not use ${row.key} for "${row.name}"`, () => {
      const resolved = resolveComponent({ key: row.key, name: row.name, category: "motherboard" }, { skipDbLookup: true });
      expect(resolved?.key).not.toBe(row.key);
      if (row.resolvedKey) expect(resolved?.key).toBe(row.resolvedKey);
      if (row.ddr) expect(resolved?.spec.ddr).toBe(row.ddr);
      if (row.formFactor) expect(resolved?.spec.form_factor).toBe(row.formFactor);
    });
  }

  it("still trusts a canonical key whose title agrees with it", () => {
    const resolved = resolveComponent(
      { key: "msi-pro-b760m-a-wifi", name: "MSI Pro B760M-A WIFI DDR5 Motherboard", category: "motherboard" },
      { skipDbLookup: true }
    );
    expect(resolved?.key).toBe("msi-pro-b760m-a-wifi");
  });

  // The real catalog is gitignored; point PCBS_REAL_CATALOG at a copy to run this.
  const dbPath = process.env.PCBS_REAL_CATALOG ?? path.join(process.cwd(), "data", "products.db");
  const realRows = (() => {
    if (!fs.existsSync(dbPath)) return [];
    try {
      const db = new Database(dbPath, { readonly: true, fileMustExist: true });
      try {
        return db
          .prepare("select name, registry_key, category from products where registry_key is not null and category in ('motherboard','ram')")
          .all() as Array<{ name: string; registry_key: string; category: ComponentCategory }>;
      } finally {
        db.close();
      }
    } catch {
      return [];
    }
  })();

  it.skipIf(realRows.length === 0)("no real catalog board/RAM row resolves to a record its title contradicts", () => {
    const conflicts = realRows.flatMap((row) => {
      const resolved = resolveComponent({ key: row.registry_key, name: row.name, category: row.category }, { db: null });
      const reason = resolved && titleConflictsWithSpec(row.name, resolved.spec, row.category);
      return reason ? [`${row.name} -> ${resolved.key}: ${reason}`] : [];
    });
    expect(conflicts).toEqual([]);
  });
});

// Intel values come from ARK "Maximum Turbo Power"; AMD PPT values are still
// missing except the 7950X (amd.com pages were unreachable when sourcing).
describe("curated CPU max power", () => {
  it("every max_power_w value cites a manufacturer page", () => {
    const cpus = [...loadRegistry().byKey.values()].filter((entry) => entry.category === "cpu" && typeof entry.spec.max_power_w === "number");
    expect(cpus.length).toBeGreaterThan(10);
    for (const entry of cpus) {
      const sources = (entry.spec.sources ?? []) as string[];
      expect(sources.some((url) => /^https:\/\/(www\.)?(intel\.com|amd\.com)\//.test(url)), entry.key).toBe(true);
    }
  });

  it("sizes a 14700K build from Maximum Turbo Power, not base TDP", () => {
    const i7 = resolveComponent("intel-core-i7-14700k", { skipDbLookup: true })!;
    const gpu = makeResolved("gpu-285", "gpu", { brand: "NVIDIA", model: "GPU", aliases: ["GPU"], tdp_w: 285, vram_gb: 12 });
    const psu = makeResolved("psu-650", "psu", { brand: "PSU", model: "PSU 650", aliases: ["PSU 650"], wattage: 650, form_factor: "ATX" });
    // Base TDP: (125 + 285 + 50) * 1.2 = 552W passes 650W; Maximum Turbo Power
    // 253W: (253 + 285 + 50) * 1.2 = 706W does not.
    const result = validateBuild({ cpu: i7.key, gpu: gpu.key, psu: psu.key }, { resolve: resolveWith({ cpu: i7, gpu, psu }) });
    expect(result.checks.find((c) => c.rule === "wattage")?.status).toBe("failed");
  });
});

describe("CPU support review", () => {
  it("resolves Core Ultra K/KF model numbers", () => {
    expect(inferCpuIdentity(cpu("Intel Core Ultra 7 265K"))).toMatchObject({ platform: "LGA1851" });
    expect(inferCpuIdentity(cpu("Intel Core Ultra 5 245KF"))).toMatchObject({ platform: "LGA1851" });
    expect(support("Intel Core Ultra 7 265K", "Z890").status).toBe("passed");
  });

  it("asks to check the support list for Ryzen 5000 on 300-series boards instead of blocking", () => {
    for (const chipset of ["A320", "B350", "X370"]) {
      const result = support("AMD Ryzen 5 5600", chipset);
      expect(result.status, chipset).toBe("unverified");
      expect(result.message).toMatch(/CPU support list/);
    }
    expect(support("AMD Ryzen 5 5500", "A320").status).toBe("unverified");
  });

  it("follows AMD's AM4 matrix: X on 500-series fails, X elsewhere and beta BIOS are unverified", () => {
    const cases: [string, string, string][] = [
      ["AMD Ryzen 5 1600", "X570", "failed"],
      ["AMD Ryzen 5 2400G", "X570", "failed"],
      ["AMD Ryzen 5 2600", "X570", "passed"],
      ["AMD Ryzen 5 3400G", "X570", "passed"],
      ["AMD Ryzen 5 2600", "B550", "failed"],
      ["AMD Ryzen 5 3400G", "A520", "failed"],
      ["AMD Athlon 3000G", "B550", "failed"],
      ["AMD Ryzen 5 1600", "B450", "unverified"],
      ["AMD Athlon 200GE", "B350", "unverified"],
      ["AMD Ryzen 5 3600", "A320", "unverified"],
      ["AMD Ryzen 5 3600", "B350", "unverified"],
      ["AMD Ryzen 5 4600G", "A320", "unverified"],
      ["AMD Ryzen 5 3600", "B450", "passed"],
      ["AMD Ryzen 5 1600", "X470", "passed"],
      ["AMD Athlon 3000G", "A320", "passed"]
    ];
    for (const [model, chipset, status] of cases) {
      expect(support(model, chipset).status, `${model} + ${chipset}`).toBe(status);
    }
    expect(support("AMD Ryzen 5 1600", "X570").message).toMatch(/Pick a Ryzen 2000, 3000G, 3000, 4000 or 5000 CPU instead/);
  });

  it("stays silent on AM4 chipsets missing from AMD's matrix", () => {
    expect(support("AMD Ryzen 5 1600", "B550A").status).toBeUndefined();
  });

  it("turns routine BIOS notes into a passed check with an advisory", () => {
    for (const [model, chipset] of [
      ["AMD Ryzen 5 5600", "B450"],
      ["AMD Ryzen 5 5600", "A520"],
      ["Intel Core i5-14400F", "B760"],
      ["Intel Core i5-13400F", "H610"]
    ]) {
      const result = support(model, chipset);
      expect(result.status, `${model} + ${chipset}`).toBe("passed");
      expect(result.issues).toContainEqual(expect.objectContaining({ severity: "advisory", rule: "cpu_support" }));
      expect(result.issues[0]?.detail).toMatch(/Boards made since 2023 usually ship with a compatible BIOS/);
    }
  });
});

describe("RAM form factor wording", () => {
  it("does not treat dual-use or not-for-laptop wording as SO-DIMM", () => {
    expect(parseRamSpecs("Corsair Vengeance LPX 16GB DDR4 3200 for Desktop and Laptop")?.form_factor).not.toBe("sodimm");
    expect(parseRamSpecs("Kingston FURY Beast 16GB DDR5 (not for laptop)")?.form_factor).not.toBe("sodimm");
    expect(parseRamSpecs("Crucial 16GB DDR4 Laptop RAM")?.form_factor).toBe("sodimm");
    expect(parseRamSpecs("Crucial 8GB DDR4 3200 SO-DIMM")?.form_factor).toBe("sodimm");
  });

  it("does not reject a desktop record for a dual-use title", () => {
    const desktop = { brand: "Corsair", model: "Corsair Vengeance LPX 16GB DDR4", aliases: [], ddr: "DDR4" };
    expect(titleConflictsWithSpec("Corsair Vengeance LPX 16GB DDR4 for Desktop and Laptop", desktop, "ram")).toBeUndefined();
    expect(titleConflictsWithSpec("Crucial 16GB DDR4 Laptop RAM", desktop, "ram")).toBeDefined();
  });

  it("does not record ddr passed after the slot count fails", () => {
    const kit4 = makeResolved("ram-4x8", "ram", { brand: "C", model: "32GB (4x8GB) DDR5", aliases: ["kit"], ddr: "DDR5", modules: 4 });
    const itx = makeResolved("itx", "motherboard", { brand: "A", model: "ITX", aliases: ["ITX"], ddr: "DDR5", ram_slots: 2 });
    const result = validateBuild({ motherboard: itx.key, ram: kit4.key }, { resolve: resolveWith({ motherboard: itx, ram: kit4 }) });
    const ddr = result.checks.filter((c) => c.rule === "ddr").map((c) => c.status);
    expect(ddr).toContain("failed");
    expect(ddr).not.toContain("passed");
  });
});

describe("dashless ITX board names", () => {
  it("reads GIGABYTE-style B650I / H810I names as Mini-ITX", () => {
    expect(parseMotherboardSpecs("GIGABYTE B650I AORUS ULTRA")?.form_factor).toBe("Mini-ITX");
    expect(parseMotherboardSpecs("GIGABYTE H810I WIFI")?.form_factor).toBe("Mini-ITX");
    expect(titleConflictsWithSpec("MSI MPG B550I GAMING EDGE WIFI", { brand: "", model: "x", aliases: [], form_factor: "ATX" }, "motherboard")).toBeDefined();
  });

  it("leaves normal chipset names alone", () => {
    for (const name of ["MSI B650M GAMING PLUS WIFI", "ASUS PRIME X670E-PRO WIFI", "GIGABYTE Z790 AORUS ELITE AX", "ASUS TUF GAMING B760-PLUS WIFI", "MSI PRO H610M-E DDR4"]) {
      expect(parseMotherboardSpecs(name)?.form_factor, name).not.toBe("Mini-ITX");
    }
  });
});
