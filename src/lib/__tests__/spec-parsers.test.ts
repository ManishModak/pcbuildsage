import { describe, expect, it } from "vitest";
import { parseRamSpecs, parseCpuPackage, parseGpuSpecs, parseSpecsFromTitle, parseStorageSpecs } from "../spec-parsers";

describe("parseStorageSpecs", () => {
  it("reads capacity, interface, form factor and PCIe generation from an NVMe title", () => {
    expect(parseStorageSpecs("Acer Predator GM7 1TB M.2 NVMe Gen4 7400MB/s Internal SSD")).toMatchObject({
      capacity_gb: 1000,
      interface: "nvme",
      form_factor: "m2-2280",
      pcie_gen: 4
    });
  });

  it("converts TB to GB and leaves GB alone", () => {
    expect(parseStorageSpecs("Samsung 9100 Pro 4TB M.2 NVMe Gen5 SSD")?.capacity_gb).toBe(4000);
    expect(parseStorageSpecs("Adata XPG SX8100 256GB M.2 NVMe Gen3 SSD")?.capacity_gb).toBe(256);
  });

  it("does not read a throughput figure as a capacity", () => {
    // "7400MB/s" must not become 7400GB.
    expect(parseStorageSpecs("Crucial T500 1TB M.2 NVMe Gen4 7300MB/s Internal SSD")?.capacity_gb).toBe(1000);
  });

  it("never infers NVMe from an M.2 slot, because M.2 SATA drives exist", () => {
    const spec = parseStorageSpecs("Adata Ultimate SU650 512GB M.2 SSD");
    expect(spec?.form_factor).toBe("m2-2280");
    expect(spec?.interface).toBeUndefined();
    expect(spec?.pcie_gen).toBeUndefined();
  });

  it("treats a desktop hard drive as SATA 3.5in", () => {
    expect(parseStorageSpecs("Western Digital Blue 2TB 7200 RPM Desktop HDD")).toMatchObject({
      capacity_gb: 2000,
      interface: "sata",
      form_factor: "3.5in"
    });
  });

  it("classifies a bare SATA SSD as 2.5in", () => {
    expect(parseStorageSpecs("WD Green 250GB SATA SSD")).toMatchObject({ interface: "sata", form_factor: "2.5in", capacity_gb: 250 });
  });

  it("tolerates the NNMe typo present in live catalog titles", () => {
    expect(parseStorageSpecs("Addlink S68 256GB M.2 NNMe SSD")?.interface).toBe("nvme");
  });

  it("omits the interface rather than guessing when the title does not state one", () => {
    // These route to needs_research -> consult instead of being silently assumed SATA.
    const spec = parseStorageSpecs("Kingston A400 SSD, 240GB");
    expect(spec?.capacity_gb).toBe(240);
    expect(spec?.interface).toBeUndefined();
  });

  it("derives nothing from a title that states neither capacity nor interface", () => {
    expect(parseStorageSpecs("Generic Storage Device")).toBeUndefined();
  });

  it("only parses storage titles", () => {
    expect(parseSpecsFromTitle("Acer Predator GM7 1TB M.2 NVMe Gen4 SSD", "storage")).toBeDefined();
    expect(parseSpecsFromTitle("AMD Ryzen 7 9700X 8GB", "cpu")).toBeUndefined();
  });
});

describe("parseCpuPackage", () => {
  it("detects included stock cooler and cooler name from clues", () => {
    expect(parseCpuPackage("AMD Ryzen 5 5600 with Wraith Stealth Cooler")).toEqual({
      cooler_included: "included",
      cooler_name: "AMD Wraith Stealth"
    });
    expect(parseCpuPackage("AMD Ryzen 7 3700X with Wraith Prism cooler")).toEqual({
      cooler_included: "included",
      cooler_name: "AMD Wraith Prism"
    });
    expect(parseCpuPackage("Intel Core i5-12400 Boxed with cooler")).toEqual({
      cooler_included: "included"
    });
    expect(parseCpuPackage("AMD Ryzen 5 7600 Boxed (with fan)")).toEqual({
      cooler_included: "included"
    });
    expect(parseCpuPackage("Intel Core i5 12400 with stock cooler")).toEqual({
      cooler_included: "included"
    });
  });

  it("detects non-included cooler from clues", () => {
    expect(parseCpuPackage("AMD Ryzen 7 7800X3D Without Cooler")).toEqual({ cooler_included: "not_included" });
    expect(parseCpuPackage("AMD Ryzen 7 7800X3D No Cooler")).toEqual({ cooler_included: "not_included" });
    expect(parseCpuPackage("AMD Ryzen 7 7800X3D w/o cooler")).toEqual({ cooler_included: "not_included" });
    expect(parseCpuPackage("AMD Ryzen 7 7800X3D Cooler Not Included")).toEqual({ cooler_included: "not_included" });
    expect(parseCpuPackage("AMD Ryzen 7 7800X3D Tray")).toEqual({ cooler_included: "not_included" });
    expect(parseCpuPackage("Intel Core i7-13700K OEM")).toEqual({ cooler_included: "not_included" });
  });

  it("allows explicit inclusion to override generic oem/tray labels", () => {
    expect(parseCpuPackage("AMD Ryzen 5 5600 OEM with Wraith Stealth")).toEqual({
      cooler_included: "included",
      cooler_name: "AMD Wraith Stealth"
    });
    expect(parseCpuPackage("Intel Core i5-12400 Tray Boxed with cooler")).toEqual({
      cooler_included: "included"
    });
  });

  it("does not override explicit no-cooler wording when cooler name appears", () => {
    expect(parseCpuPackage("AMD Ryzen 5 5600 without cooler Wraith Stealth")).toEqual({
      cooler_included: "not_included"
    });
    expect(parseCpuPackage("AMD Ryzen 7 7800X3D No Cooler Wraith Prism")).toEqual({
      cooler_included: "not_included"
    });
    expect(parseCpuPackage("AMD Ryzen 5 5600 w/o cooler AMD Wraith Stealth")).toEqual({
      cooler_included: "not_included"
    });
  });

  it("keeps conflicting cooler statements unknown", () => {
    expect(parseCpuPackage("AMD Ryzen 5 5600 with Wraith Stealth without cooler")).toEqual({
      cooler_included: "unknown"
    });
    expect(parseCpuPackage("Intel Core i5-12400 Boxed with cooler no cooler")).toEqual({
      cooler_included: "unknown"
    });
  });

  it("returns unknown when no clues are present", () => {
    expect(parseCpuPackage("AMD Ryzen 7 9700X 8GB")).toEqual({ cooler_included: "unknown" });
  });
});

describe("parseGpuSpecs", () => {
  it("detects explicit GPU length in millimeters", () => {
    expect(parseGpuSpecs("Gigabyte RTX 4070 Windforce OC Length: 261mm")?.length_mm).toBe(261);
    expect(parseGpuSpecs("Sapphire Pure AMD Radeon RX 7700 XT 12GB Card Length: 320mm")?.length_mm).toBe(320);
    expect(parseGpuSpecs("ASUS TUF Gaming GeForce RTX 4070 Ti Dimensions: 305 x 138 x 65 mm")?.length_mm).toBe(305);
  });

  it("does not mistake fan sizes for card length", () => {
    expect(parseGpuSpecs("MSI GeForce RTX 4060 Ventus 2X Black 8G OC Dual 100mm Fan")).toBeUndefined();
    expect(parseGpuSpecs("Gigabyte RTX 4070 Gaming OC 120mm PWM Fans")).toBeUndefined();
  });

  it("leaves length undefined when context does not explicitly identify card length", () => {
    expect(parseGpuSpecs("Sapphire Pulse AMD Radeon RX 7700 XT 12GB")).toBeUndefined();
    expect(parseGpuSpecs("ZOTAC Gaming GeForce RTX 4060 8GB 222 mm")).toBeUndefined();
    expect(parseGpuSpecs("Sapphire Pure AMD Radeon RX 7700 XT 12GB (320mm)")).toBeUndefined();
  });
});


describe("explicit RAM module configurations", () => {
  it.each([
    ["Patriot 32GB (32GBx1) DDR5", 1, 32],
    ["Teamgroup 8GBx2 DDR4", 2, 16],
    ["Teamgroup 16GB (8GB×2) DDR4", 2, 16],
    ["Corsair 2 x 16GB DDR5", 2, 32]
  ])("extracts modules and total capacity from %s", (name, modules, capacity) => {
    expect(parseRamSpecs(name)).toMatchObject({ modules, capacity_gb: capacity });
  });
  it("does not invent stick count from total capacity", () => {
    expect(parseRamSpecs("Corsair 32GB DDR5")).not.toHaveProperty("modules");
  });
});
