import { describe, expect, it } from "vitest";
import { parseSpecsFromTitle, parseStorageSpecs } from "../spec-parsers";

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
