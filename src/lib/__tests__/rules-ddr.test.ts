import { describe, expect, it } from "vitest";
import { isSingleModuleRam, makeResolved, validateBuild } from "../rules-engine";
import { base, run } from "./rules-helpers";

describe("rule: ddr", () => {
  it("blocks DDR mismatches against motherboard or CPU", () => {
    const boardMismatch = run({ motherboard: makeResolved("mobo-ddr4", "motherboard", { ...base.motherboard.spec, ddr: "DDR4" }) });
    expect(boardMismatch.issues).toContainEqual(expect.objectContaining({ severity: "blocking", rule: "ddr" }));
    const cpuMismatch = run({ cpu: makeResolved("cpu-ddr4", "cpu", { ...base.cpu.spec, ddr: "DDR4" }) });
    expect(cpuMismatch.issues).toContainEqual(expect.objectContaining({ severity: "blocking", rule: "ddr" }));
  });
  it("blocks CPU and motherboard DDR mismatches when RAM is not selected", () => {
    const cpu = makeResolved("cpu-ddr5", "cpu", base.cpu.spec);
    const motherboard = makeResolved("mobo-ddr4", "motherboard", { ...base.motherboard.spec, ddr: "DDR4" });
    const result = validateBuild(
      { cpu: cpu.key, motherboard: motherboard.key },
      { resolve: (part) => part === cpu.key ? cpu : part === motherboard.key ? motherboard : undefined }
    );

    expect(result.issues).toContainEqual(expect.objectContaining({ severity: "blocking", rule: "ddr", components: [cpu.key, motherboard.key] }));
  });
  it("requests only CPU DDR research for CPU and motherboard comparison without RAM", () => {
    const cpu = makeResolved("cpu-no-ddr", "cpu", { ...base.cpu.spec, ddr: undefined });
    const motherboard = makeResolved("mobo-ddr5", "motherboard", base.motherboard.spec);
    const result = validateBuild(
      { cpu: cpu.key, motherboard: motherboard.key },
      { resolve: (part) => part === cpu.key ? cpu : part === motherboard.key ? motherboard : undefined }
    );

    expect(result.issues).toContainEqual(expect.objectContaining({ severity: "needs_research", detail: expect.stringContaining("\"ddr\"") }));
    expect(result.issues).not.toContainEqual(expect.objectContaining({ components: ["ram-ddr5"] }));
  });
  it("requests research when DDR fields are missing", () => {
    const result = run({ ram: makeResolved("ram-no-ddr", "ram", { ...base.ram.spec, ddr: undefined }) });
    expect(result.issues).toContainEqual(expect.objectContaining({ severity: "needs_research", rule: "spec_resolution" }));
  });
  it("emits a non-blocking advisory when single-channel RAM is detected", () => {
    const singleRam = makeResolved("ram-single-16gb", "ram", {
      brand: "TeamGroup",
      model: "TeamGroup T-Force Vulcan Z 16GB (16GBx1) DDR4 CL16 3200MHz RAM",
      aliases: ["TeamGroup 16GB (16GBx1) DDR4"],
      ddr: "DDR5"
    });
    const result = run({ ram: singleRam });
    expect(result.valid).toBe(true);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        severity: "advisory",
        rule: "ddr",
        detail: expect.stringContaining("Single-channel RAM detected")
      })
    );
  });
  it("does not emit single-channel advisory when a 2-stick RAM kit is used", () => {
    const dualRam = makeResolved("ram-dual-16gb", "ram", {
      brand: "Crucial",
      model: "Crucial 16GB (2x8GB) DDR5 5600MHz CL46 UDIMM Kit",
      aliases: ["Crucial 16GB (2x8GB) DDR5"],
      ddr: "DDR5"
    });
    const result = run({ ram: dualRam });
    expect(result.valid).toBe(true);
    expect(result.issues).not.toContainEqual(
      expect.objectContaining({
        severity: "advisory"
      })
    );
  });
    it("never produces a false DDR pass when CPU and RAM are unresolved", () => {
      const motherboard = makeResolved("mobo-b450", "motherboard", { ...base.motherboard.spec, ddr: "DDR4" });
      const result = validateBuild(
        { cpu: "unregistered-cpu", motherboard: motherboard.key, ram: "unregistered-ram" },
        { resolve: (part) => (part === motherboard.key ? motherboard : undefined) }
      );

      const ddrPassed = result.checks.some((c) => c.rule === "ddr" && c.status === "passed");
      expect(ddrPassed).toBe(false);

      // It should record unverified, never a passed check with undefined
      const ddrCheck = result.checks.find((c) => c.rule === "ddr");
      expect(ddrCheck).toBeDefined();
      expect(ddrCheck?.status).toBe("unverified");
      expect(ddrCheck?.message).not.toContain("undefined");
      expect(result.valid).toBe(true); // Non-blocking
    });
    it("records passed DDR when RAM and motherboard match even if CPU DDR is unverified", () => {
      const motherboard = makeResolved("mobo-b450", "motherboard", { ...base.motherboard.spec, ddr: "DDR4" });
      const ram = makeResolved("ram-ddr4", "ram", { ...base.ram.spec, ddr: "DDR4" });
      const result = validateBuild(
        { cpu: "unregistered-cpu", motherboard: motherboard.key, ram: ram.key },
        { resolve: (part) => (part === motherboard.key ? motherboard : part === ram.key ? ram : undefined) }
      );

      const passedDdr = result.checks.find((c) => c.rule === "ddr" && c.status === "passed");
      expect(passedDdr).toBeDefined();
      expect(passedDdr?.message).toBe("RAM (DDR4) matches motherboard (DDR4).");

      const unverifiedDdr = result.checks.find((c) => c.rule === "ddr" && c.status === "unverified");
      expect(unverifiedDdr).toBeDefined();
      expect(unverifiedDdr?.message).toContain("CPU memory support could not be verified");
    });
      it("passes an LGA 1700 CPU with DDR4 motherboard and DDR4 RAM when CPU supports both DDR4 and DDR5", () => {
        const cpu = makeResolved("intel-core-i5-12400f", "cpu", {
          brand: "Intel",
          model: "Intel Core i5-12400F",
          socket: "LGA 1700",
          ddr: "DDR5",
          supported_memory: ["DDR4", "DDR5"],
          tdp_w: 65,
          igpu: false,
          aliases: ["i5-12400F"]
        });
        const motherboard = makeResolved("b660-ddr4", "motherboard", {
          brand: "MSI",
          model: "PRO B660M-A DDR4",
          socket: "LGA 1700",
          ddr: "DDR4",
          aliases: ["PRO B660M-A DDR4"]
        });
        const ram = makeResolved("ram-ddr4", "ram", {
          brand: "Crucial",
          model: "Crucial 16GB (2x8GB) DDR4-3200",
          ddr: "DDR4",
          aliases: ["Crucial DDR4 16GB"]
        });

        const result = validateBuild(
          { cpu: cpu.key, motherboard: motherboard.key, ram: ram.key },
          { resolve: (part) => (part === cpu.key ? cpu : part === motherboard.key ? motherboard : part === ram.key ? ram : undefined) }
        );

        const ddrCheck = result.checks.find((c) => c.rule === "ddr");
        expect(ddrCheck?.status).toBe("passed");
        expect(ddrCheck?.message).toBe("RAM (DDR4) matches motherboard and CPU memory support.");
      });
      it("blocks DDR5 RAM on an LGA 1700 DDR4 motherboard even if CPU supports DDR5", () => {
        const cpu = makeResolved("intel-core-i5-12400f", "cpu", {
          brand: "Intel",
          model: "Intel Core i5-12400F",
          socket: "LGA 1700",
          ddr: "DDR5",
          supported_memory: ["DDR4", "DDR5"],
          tdp_w: 65,
          igpu: false,
          aliases: ["i5-12400F"]
        });
        const motherboard = makeResolved("b660-ddr4", "motherboard", {
          brand: "MSI",
          model: "PRO B660M-A DDR4",
          socket: "LGA 1700",
          ddr: "DDR4",
          aliases: ["PRO B660M-A DDR4"]
        });
        const ram = makeResolved("ram-ddr5", "ram", {
          brand: "Crucial",
          model: "Crucial 32GB (2x16GB) DDR5-5600",
          ddr: "DDR5",
          aliases: ["Crucial DDR5 32GB"]
        });

        const result = validateBuild(
          { cpu: cpu.key, motherboard: motherboard.key, ram: ram.key },
          { resolve: (part) => (part === cpu.key ? cpu : part === motherboard.key ? motherboard : part === ram.key ? ram : undefined) }
        );

        const ddrCheck = result.checks.find((c) => c.rule === "ddr");
        expect(ddrCheck?.status).toBe("failed");
        expect(ddrCheck?.message).toBe("RAM DDR5 does not match motherboard DDR4.");
      });
      it("emits a single-channel advisory when ram.spec.modules === 1 even without explicit single-channel keywords in title", () => {
        const ram = makeResolved("custom-ram-single", "ram", {
          brand: "GenericBrand",
          model: "Memory Stick Standard",
          ddr: "DDR5",
          capacity_gb: 16,
          modules: 1,
          aliases: ["Standard Memory"]
        });
        expect(isSingleModuleRam(ram)).toBe(true);

        const result = run({ ram });
        const advisory = result.issues.find((i) => i.severity === "advisory" && i.rule === "ddr");
        expect(advisory).toBeDefined();
        expect(advisory?.detail).toContain("Single-channel RAM detected");
      });
      it("does not emit single-channel advisory when ram.spec.modules === 2 even without explicit dual-channel keywords in title", () => {
        const ram = makeResolved("custom-ram-dual", "ram", {
          brand: "GenericBrand",
          model: "Memory Kit Standard",
          ddr: "DDR5",
          capacity_gb: 32,
          modules: 2,
          aliases: ["Standard Memory"]
        });
        expect(isSingleModuleRam(ram)).toBe(false);

        const result = run({ ram });
        const advisory = result.issues.find((i) => i.severity === "advisory" && i.rule === "ddr");
        expect(advisory).toBeUndefined();
      });
});
