import { describe, expect, it } from "vitest";
import { makeResolved, validateBuild } from "../rules-engine";
import { base, run } from "./rules-helpers";

describe("rule: wattage", () => {
  it("passes wattage at the exact 1.2 headroom boundary", () => {
    const result = run({ psu: makeResolved("psu-438", "psu", { ...base.psu.spec, wattage: 438 }) });
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
  });
  it("blocks inadequate PSU wattage", () => {
    const result = run({ psu: makeResolved("psu-400", "psu", { ...base.psu.spec, wattage: 400 }) });
    expect(result.issues).toContainEqual(expect.objectContaining({ severity: "blocking", rule: "wattage" }));
  });
  it("checks wattage for CPU-only builds", () => {
    const cpu = makeResolved("cpu-125w-igpu", "cpu", { ...base.cpu.spec, tdp_w: 125, igpu: true });
    const psu = makeResolved("psu-100", "psu", { ...base.psu.spec, wattage: 100 });
    const result = validateBuild({ cpu: cpu.key, psu: psu.key }, { resolve: (part) => (part === cpu.key ? cpu : part === psu.key ? psu : undefined) });
    expect(result.issues).toContainEqual(expect.objectContaining({ severity: "blocking", rule: "wattage" }));
  });
  it("requests research when wattage inputs are missing", () => {
    const result = run({ gpu: makeResolved("gpu-no-tdp", "gpu", { ...base.gpu.spec, tdp_w: undefined }) });
    expect(result.issues).toContainEqual(expect.objectContaining({ severity: "needs_research", rule: "spec_resolution" }));
  });
      it("fails wattage check when estimated draw exceeds PSU wattage", () => {
        const cpu = makeResolved("cpu-high-draw", "cpu", {
          brand: "AMD",
          model: "Ryzen 9 7950X",
          tdp_w: 170,
          socket: "AM5",
          ddr: "DDR5",
          igpu: true,
          aliases: ["7950X"]
        });
        const gpu = makeResolved("gpu-rtx-5080", "gpu", {
          brand: "NVIDIA",
          model: "GeForce RTX 5080",
          tdp_w: 360,
          recommended_psu_w: 850,
          vram_gb: 16,
          aliases: ["RTX 5080"]
        });
        const psu = makeResolved("psu-550w", "psu", {
          brand: "Corsair",
          model: "CX550",
          wattage: 550,
          form_factor: "ATX",
          aliases: ["CX550"]
        });

        const result = run({ cpu, gpu, psu });
        const wattageCheck = result.checks.find((c) => c.rule === "wattage");
        expect(wattageCheck?.status).toBe("failed");
        expect(result.valid).toBe(false);
        // (170 + 360 + 50) * 1.2 = 580 * 1.2 = 696W > 550W
        expect(wattageCheck?.message).toContain("Estimated 696W requirement exceeds PSU 550W");
      });
      describe("GPU maker's recommended PSU", () => {
        const cpu = makeResolved("cpu-mid", "cpu", {
          brand: "AMD", model: "Ryzen 5 7600", tdp_w: 65, socket: "AM5", ddr: "DDR5", igpu: true, aliases: ["7600"]
        });
        const gpu = makeResolved("gpu-rtx-5080", "gpu", {
          brand: "NVIDIA", model: "GeForce RTX 5080", tdp_w: 360, recommended_psu_w: 850, vram_gb: 16, aliases: ["RTX 5080"]
        });
        const psuOf = (w: number) => makeResolved(`psu-${w}w`, "psu", { brand: "Corsair", model: `PSU ${w}`, wattage: w, form_factor: "ATX", aliases: [`PSU ${w}`] });

        // Estimate: (65 + 360 + 50) * 1.2 = 570W.
        it("passes with an advisory when the PSU covers the estimate but misses the recommendation", () => {
          const result = run({ cpu, gpu, psu: psuOf(750) });
          const wattageCheck = result.checks.find((c) => c.rule === "wattage");
          expect(wattageCheck?.status).toBe("passed");
          expect(result.valid).toBe(true);
          const advisory = result.issues.find((i) => i.rule === "wattage");
          expect(advisory?.severity).toBe("advisory");
          expect(advisory?.detail).toContain("850W recommendation");
        });

        it("blocks when the PSU is below 80% of the recommendation even if the estimate passes", () => {
          // 650W < 0.8 * 850W = 680W.
          const result = run({ cpu, gpu, psu: psuOf(650) });
          const wattageCheck = result.checks.find((c) => c.rule === "wattage");
          expect(wattageCheck?.status).toBe("failed");
          expect(wattageCheck?.message).toContain("well below the GPU manufacturer recommendation (850W)");
          expect(result.valid).toBe(false);
        });

        it("Ryzen 5 5600 + RTX 4060 + 450W passes with an advisory (550W recommended, 276W estimated)", () => {
          const r5600 = makeResolved("r5600", "cpu", { brand: "AMD", model: "Ryzen 5 5600", tdp_w: 65, socket: "AM4", ddr: "DDR4", igpu: false, aliases: ["5600"] });
          const rtx4060 = makeResolved("rtx4060", "gpu", { brand: "NVIDIA", model: "GeForce RTX 4060", tdp_w: 115, recommended_psu_w: 550, vram_gb: 8, aliases: ["RTX 4060"] });
          const psu = psuOf(450);
          const byKey = new Map([r5600, rtx4060, psu].map((p) => [p.key, p]));
          const result = validateBuild({ cpu: r5600.key, gpu: rtx4060.key, psu: psu.key }, { resolve: (part) => byKey.get(part as string) });
          expect(result.checks.find((c) => c.rule === "wattage")?.status).toBe("passed");
          expect(result.valid).toBe(true);
          expect(result.issues).toContainEqual(expect.objectContaining({ severity: "advisory", rule: "wattage" }));
        });
      });
      it("passes cleanly without advisory when PSU satisfies both estimated draw and manufacturer recommended PSU", () => {
        const cpu = makeResolved("cpu-mid", "cpu", {
          brand: "AMD",
          model: "Ryzen 5 7600",
          tdp_w: 65,
          socket: "AM5",
          ddr: "DDR5",
          igpu: true,
          aliases: ["7600"]
        });
        const gpu = makeResolved("gpu-rtx-5080", "gpu", {
          brand: "NVIDIA",
          model: "GeForce RTX 5080",
          tdp_w: 360,
          recommended_psu_w: 850,
          vram_gb: 16,
          aliases: ["RTX 5080"]
        });
        const psu = makeResolved("psu-850w", "psu", {
          brand: "Corsair",
          model: "RM850x",
          wattage: 850,
          form_factor: "ATX",
          aliases: ["RM850x"]
        });

        const result = run({ cpu, gpu, psu });
        const wattageCheck = result.checks.find((c) => c.rule === "wattage");
        expect(wattageCheck?.status).toBe("passed");
        expect(wattageCheck?.message).toContain("meets manufacturer recommendation (850W)");
        expect(result.valid).toBe(true);

        const advisory = result.issues.find((i) => i.severity === "advisory" && i.rule === "wattage");
        expect(advisory).toBeUndefined();
      });
});
