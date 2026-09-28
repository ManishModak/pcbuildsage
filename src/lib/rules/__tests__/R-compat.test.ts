/**
 * Track R compatibility tests: builds marked compatible must actually be
 * compatible. Each test below fails without its fix. All tests exercise the
 * real modules (registry, spec-parsers, rules-engine), not reimplementations.
 */
import { describe, expect, it } from "vitest";
import { makeResolved, validateBuild, type BuildPart } from "../../rules-engine";
import { resolveComponent, titleConflictsWithSpec, type ComponentCategory, type ResolvedSpec } from "../../registry";
import { parseMotherboardSpecs, parseRamSpecs } from "../../spec-parsers";
import { inferCpuIdentity } from "../cpu-support";

function resolveWith(specs: Partial<Record<ComponentCategory, ResolvedSpec | ResolvedSpec[]>>) {
  return (part: BuildPart, category: ComponentCategory) => {
    const key = typeof part === "string" ? part : part.key;
    const value = specs[category];
    const list = Array.isArray(value) ? value : value ? [value] : [];
    return list.find((item) => item.key === key);
  };
}

const cpu = (key: string, model: string, extra: Record<string, unknown> = {}) =>
  makeResolved(key, "cpu", {
    brand: model.split(" ")[0] ?? "",
    model,
    aliases: [model],
    socket: "AM4",
    ddr: "DDR4",
    tdp_w: 65,
    igpu: true,
    ...extra
  });

const board = (key: string, model: string, extra: Record<string, unknown> = {}) =>
  makeResolved(key, "motherboard", {
    brand: model.split(" ")[0] ?? "",
    model,
    aliases: [model],
    socket: "AM4",
    chipset: "B450",
    ddr: "DDR4",
    form_factor: "Micro-ATX",
    m2_slots: 1,
    sata_ports: 4,
    ...extra
  });

describe("R1: variant words in titles are not ignored by alias matching", () => {
  it("resolves an MSI DDR4 board title to the DDR4 record, not the DDR5 record", () => {
    const resolved = resolveComponent(
      { name: "MSI PRO B760M-A WIFI DDR4", category: "motherboard" },
      { skipDbLookup: true }
    );
    expect(resolved?.key).toBe("msi-pro-b760m-a-wifi-ddr4");
    expect(resolved?.spec.ddr).toBe("DDR4");
  });

  it("rejects a DDR5 record for a DDR4 title", () => {
    expect(
      titleConflictsWithSpec(
        "MSI PRO B760M-A WIFI DDR4",
        { brand: "MSI", model: "MSI PRO B760M-A WiFi", aliases: [], ddr: "DDR5" },
        "motherboard"
      )
    ).toMatch(/DDR4.*DDR5/i);
    expect(
      titleConflictsWithSpec(
        "MSI PRO B760M-A WIFI DDR4",
        { brand: "MSI", model: "MSI PRO B760M-A WIFI DDR4", aliases: [], ddr: "DDR4" },
        "motherboard"
      )
    ).toBeUndefined();
  });

  it("rejects an ATX record for an ITX (-I suffix) title", () => {
    expect(
      titleConflictsWithSpec(
        "ASUS ROG Strix B650E-I Gaming WiFi",
        { brand: "ASUS", model: "ROG Strix B650E-A", aliases: [], form_factor: "ATX" },
        "motherboard"
      )
    ).toMatch(/Mini-ITX/i);
  });

  it("rejects desktop RAM records for laptop/SO-DIMM titles", () => {
    expect(
      titleConflictsWithSpec(
        "Crucial 16GB DDR4 3200 SODIMM Laptop Memory",
        { brand: "Crucial", model: "Crucial 16GB DDR4", aliases: [], ddr: "DDR4" },
        "ram"
      )
    ).toMatch(/SO-DIMM/i);
  });

  it("blocks DDR5 RAM on the DDR4 board the alias used to misresolve to", () => {
    const ddr4Board = board("msi-pro-b760m-a-wifi-ddr4", "MSI PRO B760M-A WIFI DDR4", {
      socket: "LGA 1700",
      chipset: "B760",
      ddr: "DDR4"
    });
    const ddr5Ram = makeResolved("ram-ddr5", "ram", {
      brand: "Corsair",
      model: "Corsair 32GB (2x16GB) DDR5-5600",
      aliases: ["Corsair DDR5"],
      ddr: "DDR5"
    });
    const result = validateBuild(
      { motherboard: ddr4Board.key, ram: ddr5Ram.key },
      { resolve: resolveWith({ motherboard: ddr4Board, ram: ddr5Ram }) }
    );
    expect(result.checks.find((c) => c.rule === "ddr")?.status).toBe("failed");
    expect(result.valid).toBe(false);
  });
});

describe("R2: title-parsed boards do not invent specs", () => {
  it("leaves M.2 slots, SATA ports, LGA1700 DDR and bare form factor unknown", () => {
    const parsed = parseMotherboardSpecs("ASUS TUF Gaming B760-Plus WiFi LGA1700 Motherboard");
    expect(parsed?.socket).toBe("LGA 1700");
    expect(parsed?.chipset).toBe("B760");
    expect(parsed).not.toHaveProperty("m2_slots");
    expect(parsed).not.toHaveProperty("sata_ports");
    expect(parsed).not.toHaveProperty("ddr");
    expect(parsed).not.toHaveProperty("form_factor");
  });

  it("still reads a stated DDR4 token and Micro-ATX from the title", () => {
    const parsed = parseMotherboardSpecs("MSI PRO B760M-A WIFI DDR4 Micro-ATX Motherboard");
    expect(parsed?.ddr).toBe("DDR4");
    expect(parsed?.form_factor).toBe("Micro-ATX");
  });

  it("detects ASUS -I suffix boards as Mini-ITX", () => {
    expect(parseMotherboardSpecs("ASUS ROG Strix B650E-I Gaming WiFi")?.form_factor).toBe("Mini-ITX");
  });

  it("treats title-derived slot counts as unverified in validation", () => {
    const derived = resolveComponent(
      { name: "TestVendor B450M-HDV R9.9 Test Board", category: "motherboard" },
      { skipDbLookup: true }
    )!;
    expect(derived.source).toBe("derived");
    expect(derived.spec.m2_slots).toBeUndefined();
    const drive = makeResolved("ssd-nvme", "storage", {
      brand: "Samsung",
      model: "SSD",
      aliases: ["SSD"],
      interface: "nvme",
      form_factor: "m2-2280",
      capacity_gb: 1000
    });
    const ram = makeResolved("ram-ddr4", "ram", {
      brand: "Crucial",
      model: "RAM",
      aliases: ["RAM"],
      ddr: "DDR4"
    });
    const result = validateBuild(
      { motherboard: derived.key, ram: ram.key, storage: [drive.key] },
      {
        resolve: ((part: BuildPart, category: ComponentCategory) => {
          const key = typeof part === "string" ? part : part.key;
          if (category === "motherboard" && key === derived.key) return derived;
          if (category === "ram" && key === ram.key) return ram;
          if (category === "storage" && key === drive.key) return drive;
          return undefined;
        }) as (part: BuildPart, category: ComponentCategory) => ResolvedSpec | undefined
      }
    );
    expect(result.checks.find((c) => c.rule === "storage")?.status).toBe("unverified");
  });
});

describe("R3: PSU sizing uses realistic power and enforces GPU recommendations", () => {
  const psu750 = makeResolved("psu-750", "psu", {
    brand: "Corsair",
    model: "RM750e",
    aliases: ["RM750e"],
    wattage: 750,
    form_factor: "ATX"
  });

  it("fails 14900K + RTX 4090 on a 750W PSU", () => {
    // Registry values: 14900K max_power_w 253 (Intel ARK Maximum Turbo Power),
    // RTX 4090 tdp 450 + recommended_psu 850.
    const cpu14900k = makeResolved("intel-core-i9-14900k", "cpu", {
      brand: "Intel",
      model: "Intel Core i9-14900K",
      aliases: ["14900K"],
      socket: "LGA 1700",
      tdp_w: 125,
      max_power_w: 253,
      igpu: true
    });
    const rtx4090 = makeResolved("nvidia-rtx-4090", "gpu", {
      brand: "NVIDIA",
      model: "NVIDIA GeForce RTX 4090",
      aliases: ["RTX 4090"],
      tdp_w: 450,
      recommended_psu_w: 850,
      vram_gb: 24
    });
    const result = validateBuild(
      { cpu: cpu14900k.key, gpu: rtx4090.key, psu: psu750.key },
      { resolve: resolveWith({ cpu: cpu14900k, gpu: rtx4090, psu: psu750 }) }
    );
    const wattage = result.checks.find((c) => c.rule === "wattage");
    expect(wattage?.status).toBe("failed");
    // (253 + 450 + 50) * 1.2 = 903.6 -> 904W estimated.
    expect(wattage?.message).toContain("904W");
    expect(result.valid).toBe(false);
  });

  it("sizes from max_power_w instead of base TDP", () => {
    const hungry = makeResolved("cpu-hungry", "cpu", {
      brand: "AMD",
      model: "Ryzen 9 7950X",
      aliases: ["7950X"],
      socket: "AM5",
      tdp_w: 170,
      max_power_w: 230,
      igpu: true
    });
    const gpu = makeResolved("gpu-200w", "gpu", {
      brand: "NVIDIA",
      model: "GPU",
      aliases: ["GPU"],
      tdp_w: 200,
      vram_gb: 12
    });
    // Base TDP math: (170 + 200 + 50) * 1.2 = 504W (passes 550W).
    // Realistic math: (230 + 200 + 50) * 1.2 = 576W (fails 550W).
    const psu550 = makeResolved("psu-550", "psu", {
      brand: "Corsair",
      model: "CX550",
      aliases: ["CX550"],
      wattage: 550,
      form_factor: "ATX"
    });
    const result = validateBuild(
      { cpu: hungry.key, gpu: gpu.key, psu: psu550.key },
      { resolve: resolveWith({ cpu: hungry, gpu, psu: psu550 }) }
    );
    expect(result.checks.find((c) => c.rule === "wattage")?.status).toBe("failed");
  });
});

describe("R4: chipset x CPU generation support and BIOS", () => {
  it("flags B450 + Ryzen 5000 as needing a BIOS update", () => {
    const result = validateBuild(
      { cpu: "ryzen-5600", motherboard: "b450-board" },
      {
        resolve: resolveWith({
          cpu: cpu("ryzen-5600", "AMD Ryzen 5 5600"),
          motherboard: board("b450-board", "MSI B450 TOMAHAWK MAX")
        })
      }
    );
    const check = result.checks.find((c) => c.rule === "cpu_support");
    expect(check?.status).toBe("unverified");
    expect(check?.message).toMatch(/BIOS update/i);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ severity: "needs_verification", rule: "cpu_support" })
    );
    expect(result.valid).toBe(true);
  });

  it("flags 600-series + 13th/14th gen as needing a BIOS update", () => {
    const cpu13700k = makeResolved("i7-13700k", "cpu", {
      brand: "Intel",
      model: "Intel Core i7-13700K",
      aliases: ["13700K"],
      socket: "LGA 1700",
      tdp_w: 125,
      igpu: true
    });
    const z690 = board("z690-board", "MSI PRO Z690-A", {
      socket: "LGA 1700",
      chipset: "Z690",
      ddr: "DDR5",
      form_factor: "ATX"
    });
    const result = validateBuild(
      { cpu: cpu13700k.key, motherboard: z690.key },
      { resolve: resolveWith({ cpu: cpu13700k, motherboard: z690 }) }
    );
    expect(result.checks.find((c) => c.rule === "cpu_support")?.status).toBe("unverified");
  });

  it("blocks Ryzen 5 5500 on A320 as unsupported", () => {
    const result = validateBuild(
      { cpu: "ryzen-5500", motherboard: "a320-board" },
      {
        resolve: resolveWith({
          cpu: cpu("ryzen-5500", "AMD Ryzen 5 5500"),
          motherboard: board("a320-board", "Gigabyte A320M-S2H", { chipset: "A320" })
        })
      }
    );
    const check = result.checks.find((c) => c.rule === "cpu_support");
    expect(check?.status).toBe("failed");
    expect(result.valid).toBe(false);
  });

  it("passes contemporary pairings (B550 + Ryzen 5000, Z790 + 13th gen)", () => {
    const cpu5600 = cpu("ryzen-5600", "AMD Ryzen 5 5600");
    const b550 = board("b550-board", "MSI B550 TOMAHAWK", { chipset: "B550" });
    const first = validateBuild(
      { cpu: cpu5600.key, motherboard: b550.key },
      { resolve: resolveWith({ cpu: cpu5600, motherboard: b550 }) }
    );
    expect(first.checks.find((c) => c.rule === "cpu_support")?.status).toBe("passed");

    const cpu13700k = makeResolved("i7-13700k", "cpu", {
      brand: "Intel",
      model: "Intel Core i7-13700K",
      aliases: ["13700K"],
      socket: "LGA 1700",
      tdp_w: 125,
      igpu: true
    });
    const z790 = board("z790-board", "MSI PRO Z790-A", {
      socket: "LGA 1700",
      chipset: "Z790",
      ddr: "DDR5",
      form_factor: "ATX"
    });
    const second = validateBuild(
      { cpu: cpu13700k.key, motherboard: z790.key },
      { resolve: resolveWith({ cpu: cpu13700k, motherboard: z790 }) }
    );
    expect(second.checks.find((c) => c.rule === "cpu_support")?.status).toBe("passed");
  });

  it("reads generations off model names", () => {
    expect(inferCpuIdentity(cpu("a", "AMD Ryzen 5 5600"))).toMatchObject({ platform: "AM4" });
    expect(inferCpuIdentity(cpu("b", "AMD Ryzen 9 7950X"))).toMatchObject({ platform: "AM5" });
    expect(
      inferCpuIdentity(
        makeResolved("c", "cpu", { brand: "Intel", model: "Intel Core i9-14900K", aliases: [] })
      )
    ).toMatchObject({ platform: "LGA1700", series: "14th gen" });
  });
});

describe("R5/R6: laptop memory and stick counts", () => {
  it("blocks SO-DIMM laptop RAM on a desktop board", () => {
    const laptopRam = makeResolved("ram-sodimm", "ram", {
      brand: "Crucial",
      model: "Crucial 16GB DDR4 3200 SODIMM Laptop Memory",
      aliases: ["Crucial laptop RAM"],
      ddr: "DDR4"
    });
    const desktopBoard = board("b450-board", "MSI B450 TOMAHAWK MAX", { form_factor: "ATX" });
    const result = validateBuild(
      { motherboard: desktopBoard.key, ram: laptopRam.key },
      { resolve: resolveWith({ motherboard: desktopBoard, ram: laptopRam }) }
    );
    const check = result.checks.find((c) => c.rule === "ddr");
    expect(check?.status).toBe("failed");
    expect(check?.message).toMatch(/SO-DIMM/i);
    expect(result.valid).toBe(false);
  });

  it("parses SO-DIMM form factor from titles", () => {
    expect(parseRamSpecs("Crucial 16GB DDR4 3200 SODIMM Laptop Memory")?.form_factor).toBe("sodimm");
    expect(parseRamSpecs("Corsair 32GB DDR5 Desktop Memory")).toBeDefined();
  });

  it("blocks a 4-stick kit on a 2-slot board", () => {
    const kit4 = makeResolved("ram-4x8", "ram", {
      brand: "Corsair",
      model: "Corsair 32GB (4x8GB) DDR5",
      aliases: ["kit"],
      ddr: "DDR5",
      modules: 4,
      capacity_gb: 32
    });
    const itxBoard = board("itx-board", "ASUS ROG Strix B650E-I", {
      socket: "AM5",
      chipset: "B650",
      ddr: "DDR5",
      form_factor: "Mini-ITX",
      ram_slots: 2
    });
    const result = validateBuild(
      { motherboard: itxBoard.key, ram: kit4.key },
      { resolve: resolveWith({ motherboard: itxBoard, ram: kit4 }) }
    );
    const check = result.checks.find((c) => c.rule === "ddr");
    expect(check?.status).toBe("failed");
    expect(check?.message).toMatch(/4.*modules.*2.*slot/i);
    expect(result.valid).toBe(false);
  });

  it("passes a 2-stick kit on a 4-slot board", () => {
    const kit2 = makeResolved("ram-2x16", "ram", {
      brand: "Corsair",
      model: "Corsair 32GB (2x16GB) DDR5",
      aliases: ["kit"],
      ddr: "DDR5",
      modules: 2,
      capacity_gb: 32
    });
    const atxBoard = board("ddr5-board", "MSI PRO B760M-A WIFI", {
      socket: "LGA 1700",
      chipset: "B760",
      ddr: "DDR5",
      ram_slots: 4
    });
    const result = validateBuild(
      { motherboard: atxBoard.key, ram: kit2.key },
      { resolve: resolveWith({ motherboard: atxBoard, ram: kit2 }) }
    );
    expect(result.checks.find((c) => c.rule === "ddr" && c.status === "failed")).toBeUndefined();
  });
});

describe("R7: cooler mounting carry-over", () => {
  const am5Cpu = makeResolved("ryzen-7600", "cpu", {
    brand: "AMD",
    model: "AMD Ryzen 5 7600",
    aliases: ["7600"],
    socket: "AM5",
    tdp_w: 65,
    igpu: true
  });
  const am4OnlyCooler = makeResolved("cooler-am4", "cooler", {
    brand: "Noctua",
    model: "Old AM4 Cooler",
    aliases: ["Old"],
    cooler_type: "air",
    height_mm: 150,
    sockets: ["AM4"],
    tdp_rating_w: 150
  });

  it("accepts an AM4-listed cooler on an AM5 CPU", () => {
    const result = validateBuild(
      { cpu: am5Cpu.key, cooler: am4OnlyCooler.key },
      { resolve: resolveWith({ cpu: am5Cpu, cooler: am4OnlyCooler }) }
    );
    expect(result.checks.find((c) => c.rule === "cooler")?.status).toBe("passed");
  });

  it("accepts an LGA1700-listed cooler on an LGA1851 CPU", () => {
    const ultra = makeResolved("ultra-265k", "cpu", {
      brand: "Intel",
      model: "Intel Core Ultra 7 265K",
      aliases: ["265K"],
      socket: "LGA 1851",
      tdp_w: 125,
      igpu: true
    });
    const lga1700Cooler = makeResolved("cooler-1700", "cooler", {
      brand: "Noctua",
      model: "Old LGA1700 Cooler",
      aliases: ["Old"],
      cooler_type: "air",
      height_mm: 150,
      sockets: ["LGA 1700"],
      tdp_rating_w: 200
    });
    const result = validateBuild(
      { cpu: ultra.key, cooler: lga1700Cooler.key },
      { resolve: resolveWith({ cpu: ultra, cooler: lga1700Cooler }) }
    );
    expect(result.checks.find((c) => c.rule === "cooler")?.status).toBe("passed");
  });

  it("still blocks a cooler with no compatible mount (AM5 CPU, LGA1700-only cooler)", () => {
    const lgaOnly = makeResolved("cooler-1700", "cooler", {
      brand: "Noctua",
      model: "LGA1700 Cooler",
      aliases: ["Old"],
      cooler_type: "air",
      height_mm: 150,
      sockets: ["LGA 1700"],
      tdp_rating_w: 200
    });
    const result = validateBuild(
      { cpu: am5Cpu.key, cooler: lgaOnly.key },
      { resolve: resolveWith({ cpu: am5Cpu, cooler: lgaOnly }) }
    );
    expect(result.checks.find((c) => c.rule === "cooler")?.status).toBe("failed");
  });
});
