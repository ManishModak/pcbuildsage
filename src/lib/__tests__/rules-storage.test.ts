import { describe, expect, it } from "vitest";
import { makeResolved, validateBuild } from "../rules-engine";
import { listRegistrySpecs } from "../registry";
import { base, run } from "./rules-helpers";

describe("rule: storage", () => {
  it("blocks NVMe drives beyond M.2 slot count and SATA drives beyond ports", () => {
    const drives = [
      base.storage,
      makeResolved("ssd-nvme-2", "storage", { ...base.storage.spec, model: "SSD2" }),
      makeResolved("ssd-nvme-3", "storage", { ...base.storage.spec, model: "SSD3" })
    ];
    expect(run({ storage: drives }).issues).toContainEqual(expect.objectContaining({ rule: "storage", severity: "blocking" }));
    const sata = [
      makeResolved("sata-1", "storage", { ...base.storage.spec, interface: "sata", form_factor: "2.5in" }),
      makeResolved("sata-2", "storage", { ...base.storage.spec, interface: "sata", form_factor: "2.5in" })
    ];
    expect(run({ motherboard: makeResolved("mobo-one-sata", "motherboard", { ...base.motherboard.spec, sata_ports: 1 }), storage: sata }).issues).toContainEqual(expect.objectContaining({ rule: "storage", severity: "blocking" }));
  });
  it("requests research when storage slot or port fields are missing", () => {
    expect(run({ motherboard: makeResolved("mobo-no-m2", "motherboard", { ...base.motherboard.spec, m2_slots: undefined }) }).issues).toContainEqual(expect.objectContaining({ severity: "needs_research" }));
    expect(run({ motherboard: makeResolved("mobo-no-sata", "motherboard", { ...base.motherboard.spec, sata_ports: undefined }), storage: makeResolved("sata", "storage", { ...base.storage.spec, interface: "sata", form_factor: "2.5in" }) }).issues).toContainEqual(expect.objectContaining({ severity: "needs_research" }));
  });
  it("does not require M.2 slot specs for SATA-only builds", () => {
    const result = run({
      motherboard: makeResolved("mobo-sata-only", "motherboard", { ...base.motherboard.spec, m2_slots: undefined }),
      storage: makeResolved("sata", "storage", { ...base.storage.spec, interface: "sata", form_factor: "2.5in" })
    });
    expect(result.issues).not.toContainEqual(expect.objectContaining({ severity: "needs_research", detail: expect.stringContaining("\"m2_slots\"") }));
  });
  it("passes SATA-count validation with sata_ports from a sourced registry entry", () => {
    const motherboard = makeResolved("mobo-sourced", "motherboard", { ...base.motherboard.spec, sata_ports: 6 });
    const drives = Array.from({ length: 6 }, (_, index) => makeResolved(`sata-${index}`, "storage", { ...base.storage.spec, model: `SATA ${index}`, interface: "sata", form_factor: "2.5in" }));
    const result = validateBuild(
      { motherboard: motherboard.key, storage: drives.map((drive) => drive.key) },
      { resolve: (part, category) => category === "motherboard" ? motherboard : drives.find((drive) => drive.key === part) }
    );
    expect(result.issues).not.toContainEqual(expect.objectContaining({ rule: "storage" }));
    expect(result.valid).toBe(true);
  });
  it("refuses to compute a verdict from an unsourced registry entry", () => {
    // The seed registry cites nothing, so every entry in it resolves low-confidence.
    // Computing on a placeholder would return a confident wrong answer, so the rules
    // engine must demand research instead of passing the build.
    const cooler = listRegistrySpecs("cooler").find((entry) => entry.key === "thermaltake-magfloe-240");
    if (!cooler) throw new Error("registry cooler fixture missing");
    expect(cooler.source).toBe("registry");
    expect(cooler.confidence).toBe("low");

    const cpu = base.cpu;
    const result = validateBuild(
      { cpu: cpu.key, cooler: cooler.key },
      { resolve: (part, category) => category === "cpu" ? cpu : cooler }
    );
    expect(result.valid).toBe(true);
    const coolerCheck = result.checks.find((c) => c.rule === "cooler");
    expect(coolerCheck?.status).toBe("unverified");
    expect(result.issues).toContainEqual(
      expect.objectContaining({ severity: "needs_research", detail: expect.stringContaining("unsourced placeholder specs") })
    );
  });
  it("requests research when a drive interface is missing", () => {
    const result = run({ storage: makeResolved("ssd-unknown-interface", "storage", { ...base.storage.spec, interface: undefined }) });
    expect(result.issues).toContainEqual(expect.objectContaining({ severity: "needs_research", detail: expect.stringContaining("\"interface\"") }));
  });
      it("does not pass storage for unsupported or external USB interface on empty board", () => {
        const mobo = makeResolved("mobo-zero", "motherboard", {
          brand: "Generic",
          model: "Zero Port Board",
          socket: "AM5",
          ddr: "DDR5",
          form_factor: "ATX",
          m2_slots: 0,
          sata_ports: 0,
          aliases: ["Zero Port Board"]
        });
        const usbDrive = makeResolved("usb-external", "storage", {
          brand: "WD",
          model: "WD My Passport 2TB Portable External Hard Drive",
          interface: "usb",
          capacity_gb: 2000,
          aliases: ["WD My Passport"]
        });

        const result = run({ motherboard: mobo, storage: usbDrive });
        const check = result.checks.find((c) => c.rule === "storage");
        expect(check?.status).toBe("unverified");
        expect(check?.message).toContain("cannot be verified for internal motherboard connection");
        expect(result.issues).toContainEqual(expect.objectContaining({ rule: "storage", severity: "needs_verification" }));
      });
      it("blocks M.2 SATA drive on a motherboard with zero M.2 slots even if SATA ports are available", () => {
        const mobo = makeResolved("mobo-sata-only", "motherboard", {
          brand: "MSI",
          model: "SATA Only Board",
          socket: "AM5",
          ddr: "DDR5",
          form_factor: "ATX",
          m2_slots: 0,
          sata_ports: 4,
          aliases: ["SATA Only Board"]
        });
        const m2Sata = makeResolved("m2-sata-drive", "storage", {
          brand: "WD",
          model: "WD Blue SA510 500GB M.2 SATA SSD",
          interface: "sata",
          form_factor: "m2-2280",
          capacity_gb: 500,
          aliases: ["WD Blue SA510 M.2"]
        });

        const result = run({ motherboard: mobo, storage: m2Sata });
        const check = result.checks.find((c) => c.rule === "storage");
        expect(check?.status).toBe("failed");
        expect(check?.message).toContain("1 M.2 drives require 1 M.2 slots; motherboard has 0");
        expect(result.valid).toBe(false);
      });
      it("marks M.2 SATA drive unverified on a motherboard with M.2 slots when slot SATA protocol support is unknown", () => {
        const mobo = makeResolved("mobo-with-m2", "motherboard", {
          brand: "MSI",
          model: "Standard Board",
          socket: "AM5",
          ddr: "DDR5",
          form_factor: "ATX",
          m2_slots: 2,
          sata_ports: 4,
          aliases: ["Standard Board"]
        });
        const m2Sata = makeResolved("m2-sata-drive", "storage", {
          brand: "WD",
          model: "WD Blue SA510 500GB M.2 SATA SSD",
          interface: "sata",
          form_factor: "m2-2280",
          capacity_gb: 500,
          aliases: ["WD Blue SA510 M.2"]
        });

        const result = run({ motherboard: mobo, storage: m2Sata });
        const check = result.checks.find((c) => c.rule === "storage");
        expect(check?.status).toBe("unverified");
        expect(check?.message).toContain("M.2 SATA protocol support on these slots is unverified");
        expect(result.valid).toBe(true);
      });
      it("marks NVMe drive with unknown form factor as unverified topology rather than assuming M.2", () => {
        const mobo = makeResolved("mobo-with-m2", "motherboard", {
          brand: "MSI",
          model: "Standard Board",
          socket: "AM5",
          ddr: "DDR5",
          form_factor: "ATX",
          m2_slots: 2,
          sata_ports: 4,
          aliases: ["Standard Board"]
        });
        const unknownNvme = makeResolved("nvme-unknown-ff", "storage", {
          brand: "Intel",
          model: "Intel Optane AIC SSD",
          interface: "nvme",
          capacity_gb: 960,
          aliases: ["Intel Optane"]
        });

        const result = run({ motherboard: mobo, storage: unknownNvme });
        const check = result.checks.find((c) => c.rule === "storage");
        expect(check?.status).toBe("unverified");
        expect(check?.message).toContain("NVMe drive form factor is not specified as M.2");
      });
      it("passes valid cabled SATA and M.2 NVMe drives within motherboard limits", () => {
        const mobo = makeResolved("mobo-standard", "motherboard", {
          brand: "MSI",
          model: "Standard Board",
          socket: "AM5",
          ddr: "DDR5",
          form_factor: "ATX",
          m2_slots: 2,
          sata_ports: 4,
          aliases: ["Standard Board"]
        });
        const nvmeDrive = makeResolved("nvme-m2", "storage", {
          brand: "Samsung",
          model: "990 PRO 2TB",
          interface: "nvme",
          form_factor: "m2-2280",
          capacity_gb: 2000,
          aliases: ["990 PRO"]
        });
        const cabledSata = makeResolved("sata-25", "storage", {
          brand: "Crucial",
          model: "MX500 1TB",
          interface: "sata",
          form_factor: "2.5in",
          capacity_gb: 1000,
          aliases: ["MX500"]
        });

        const result = run({ motherboard: mobo, storage: [nvmeDrive, cabledSata] });
        const check = result.checks.find((c) => c.rule === "storage");
        expect(check?.status).toBe("passed");
        expect(check?.message).toContain("Motherboard supports installed storage drives (1 NVMe, 1 SATA)");
        expect(result.valid).toBe(true);
      });
  it("reports M.2 SATA alongside NVMe and cabled SATA in the pass message", () => {
    const mobo = makeResolved("mobo-mixed", "motherboard", {
      brand: "MSI",
      model: "Standard Board",
      socket: "AM5",
      ddr: "DDR5",
      form_factor: "ATX",
      m2_slots: 2,
      m2_sata_supported: true,
      sata_ports: 2,
      aliases: ["Standard Board"]
    });
    const m2Sata = makeResolved("sata-m2", "storage", {
      brand: "Samsung",
      model: "860 EVO M.2",
      interface: "sata",
      form_factor: "m2-2280",
      capacity_gb: 500,
      aliases: ["860 EVO"]
    });
    const cabledSata = makeResolved("sata-25", "storage", {
      brand: "Crucial",
      model: "MX500 1TB",
      interface: "sata",
      form_factor: "2.5in",
      capacity_gb: 1000,
      aliases: ["MX500"]
    });

    const result = run({ motherboard: mobo, storage: [base.storage, m2Sata, cabledSata] });
    const check = result.checks.find((c) => c.rule === "storage");
    expect(check?.status).toBe("passed");
    expect(check?.message).toBe("Motherboard supports installed storage drives (1 NVMe, 1 M.2 SATA, 1 SATA).");
    expect(result.valid).toBe(true);
  });
});
