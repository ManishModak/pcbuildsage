import { describe, expect, it } from "vitest";
import { makeResolved, validateBuild } from "../rules-engine";
import { base, run } from "./rules-helpers";

describe("rule: cooler", () => {
  it("blocks inadequate cooler TDP and missing socket brackets", () => {
    expect(run({ cooler: makeResolved("cooler-weak", "cooler", { ...base.cooler.spec, tdp_rating_w: 50 }) }).issues).toContainEqual(expect.objectContaining({ rule: "cooler", severity: "blocking" }));
    expect(run({ cooler: makeResolved("cooler-lga", "cooler", { ...base.cooler.spec, sockets: ["LGA 1700"] }) }).issues).toContainEqual(expect.objectContaining({ rule: "cooler", severity: "blocking" }));
  });
  it("requests research when cooler fields are missing", () => {
    const result = run({ cooler: makeResolved("cooler-no-rating", "cooler", { ...base.cooler.spec, tdp_rating_w: undefined }) });
    expect(result.issues).toContainEqual(expect.objectContaining({ severity: "needs_research", rule: "spec_resolution" }));
  });
  it("passes stock cooler when CPU includes cooler and no aftermarket cooler is selected", () => {
    const cpu = makeResolved("cpu-7600", "cpu", {
      brand: "AMD",
      model: "Ryzen 5 7600",
      aliases: ["Ryzen 5 7600"],
      socket: "AM5",
      tdp_w: 65,
      cooler_included: "included",
      cooler_name: "AMD Wraith Stealth"
    });
    const mobo = base.motherboard;
    const result = validateBuild(
      { cpu: cpu.key, motherboard: mobo.key },
      { resolve: (part) => (part === cpu.key ? cpu : part === mobo.key ? mobo : undefined) }
    );
    const coolerCheck = result.checks.find((c) => c.rule === "cooler");
    expect(coolerCheck).toBeDefined();
    expect(coolerCheck?.status).toBe("passed");
    expect(coolerCheck?.message).toBe(`Stock cooler is suitable for ${cpu.key} (65W TDP).`);
    expect(result.skipped_checks.some((s) => s.rule === "cooler")).toBe(false);
  });
  it("blocks stock cooler when CPU TDP exceeds stock cooler rating", () => {
    const cpu = makeResolved("cpu-hot", "cpu", {
      brand: "AMD",
      model: "Ryzen 7 7700X",
      aliases: ["Ryzen 7 7700X"],
      socket: "AM5",
      tdp_w: 105,
      cooler_included: "included",
      cooler_name: "AMD Wraith Stealth" // 65W rated cooler on 105W CPU
    });
    const mobo = base.motherboard;
    const result = validateBuild(
      { cpu: cpu.key, motherboard: mobo.key },
      { resolve: (part) => (part === cpu.key ? cpu : part === mobo.key ? mobo : undefined) }
    );
    const coolerCheck = result.checks.find((c) => c.rule === "cooler");
    expect(coolerCheck?.status).toBe("failed");
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        rule: "cooler",
        severity: "blocking"
      })
    );
  });
  it("[r2] bundled AMD Wraith Stealth fails socket check when paired with an Intel LGA1700 CPU", () => {
    const intelCpu = makeResolved("cpu-intel-12400", "cpu", {
      brand: "Intel",
      model: "Core i5-12400",
      aliases: ["i5-12400"],
      socket: "LGA 1700",
      tdp_w: 65,
      cooler_included: "included",
      cooler_name: "AMD Wraith Stealth" // Mismatched cooler
    });
    const mobo = makeResolved("mobo-intel", "motherboard", {
      brand: "MSI",
      model: "B760",
      aliases: ["B760"],
      socket: "LGA 1700",
      ddr: "DDR5"
    });
    const result = validateBuild(
      { cpu: intelCpu.key, motherboard: mobo.key },
      { resolve: (part) => (part === intelCpu.key ? intelCpu : part === mobo.key ? mobo : undefined) }
    );
    expect(result.valid).toBe(false);
    const coolerCheck = result.checks.find((c) => c.rule === "cooler");
    expect(coolerCheck?.status).toBe("failed");
    expect(coolerCheck?.message).toContain("LGA 1700");
  });
  it("[r2] bundled stock cooler undergoes normal clearance validation and blocks tight cases", () => {
    const cpu = makeResolved("cpu-7600", "cpu", {
      brand: "AMD",
      model: "Ryzen 5 7600",
      aliases: ["Ryzen 5 7600"],
      socket: "AM5",
      tdp_w: 65,
      cooler_included: "included",
      cooler_name: "AMD Wraith Stealth" // Height is 54mm
    });
    const tightCase = makeResolved("case-ultra-slim", "case", {
      brand: "Slim",
      model: "UltraSlim",
      aliases: ["UltraSlim"],
      max_cooler_height_mm: 40 // Too small for 54mm Wraith Stealth
    });

    const result = validateBuild(
      { cpu: cpu.key, case: tightCase.key },
      { resolve: (part) => (part === cpu.key ? cpu : part === tightCase.key ? tightCase : undefined) }
    );
    expect(result.valid).toBe(false);
    const clearanceCheck = result.checks.find((c) => c.rule === "clearance" && c.components.includes(tightCase.key));
    expect(clearanceCheck?.status).toBe("failed");
    expect(clearanceCheck?.message).toContain("Cooler height 54mm exceeds case clearance 40mm");
  });
  it("[r2] unresolvable included cooler leaves specs unknown without inventing numbers", () => {
    const cpu = makeResolved("cpu-custom", "cpu", {
      brand: "Unknown",
      model: "Mystery CPU",
      aliases: ["Mystery CPU"],
      socket: "AM5",
      tdp_w: 65,
      cooler_included: "included"
      // cooler_name omitted -> unresolvable
    });

    const result = validateBuild(
      { cpu: cpu.key },
      { resolve: (part) => (part === cpu.key ? cpu : undefined) }
    );
    expect(result.valid).toBe(true);
    const coolerCheck = result.checks.find((c) => c.rule === "cooler");
    expect(coolerCheck?.status).toBe("unverified");
    const researchIssues = result.issues.filter(
      (i) => i.severity === "needs_research" && i.components.includes("included-stock-cooler")
    );
    expect(researchIssues).toHaveLength(0);
  });
});
