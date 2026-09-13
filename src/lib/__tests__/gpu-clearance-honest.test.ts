import { describe, expect, it } from "vitest";
import { makeResolved, validateBuild } from "../rules-engine";
import { resolveComponent } from "../registry";
import fs from "node:fs";
import path from "node:path";

describe("GPU Clearance Honesty (Issue 01 & 02)", () => {
  const pcCase = makeResolved("case-4000d", "case", {
    brand: "Corsair",
    model: "4000D Airflow",
    aliases: ["4000D"],
    max_gpu_length_mm: 360,
    max_cooler_height_mm: 170,
    form_factors: ["ATX", "Micro-ATX"]
  });

  const cpu = makeResolved("cpu-7600", "cpu", {
    brand: "AMD",
    model: "Ryzen 5 7600",
    aliases: ["Ryzen 5 7600"],
    socket: "AM5",
    ddr: "DDR5",
    tdp_w: 65,
    igpu: true
  });

  const mobo = makeResolved("mobo-b650", "motherboard", {
    brand: "MSI",
    model: "PRO B650-S",
    aliases: ["PRO B650-S"],
    socket: "AM5",
    ddr: "DDR5",
    form_factor: "ATX",
    m2_slots: 2,
    sata_ports: 4
  });

  const psu = makeResolved("psu-750", "psu", {
    brand: "Corsair",
    model: "RM750e",
    aliases: ["RM750e"],
    wattage: 750
  });

  const ram = makeResolved("ram-32gb", "ram", {
    brand: "Corsair",
    model: "Vengeance 32GB (2x16GB) DDR5",
    aliases: ["Vengeance 32GB DDR5"],
    ddr: "DDR5"
  });

  it("ensures all 86 GPU family entries in registry have no generic length_mm or slot_width", () => {
    const registryPath = path.join(process.cwd(), "data", "registry", "gpus.json");
    const data = JSON.parse(fs.readFileSync(registryPath, "utf-8"));

    const exactCards = new Set(["sapphire-pure-rx-7700-xt"]);
    for (const [key, entry] of Object.entries(data)) {
      if (key.startsWith("$") || exactCards.has(key)) continue;
      const gpu = entry as Record<string, unknown>;
      expect(gpu.length_mm, `Family ${key} should not have generic length_mm`).toBeUndefined();
      expect(gpu.slot_width, `Family ${key} should not have generic slot_width`).toBeUndefined();
    }
  });

  it("verifies exact card sapphire-pure-rx-7700-xt has 320mm length and 2.5 slot width in registry", () => {
    const resolved = resolveComponent({ key: "sapphire-pure-rx-7700-xt", category: "gpu" }, { skipDbLookup: true });
    expect(resolved).toBeDefined();
    expect(resolved?.spec.length_mm).toBe(320);
    expect(resolved?.spec.slot_width).toBe(2.5);
    expect(resolved?.spec.brand).toBe("Sapphire");
    expect(resolved?.spec.model).toBe("Sapphire PURE AMD Radeon RX 7700 XT 12GB");
  });

  it("marks clearance as unverified when generic GPU family has no length", () => {
    // Generic RX 7700 XT from registry (length_mm removed)
    const genericGpu = resolveComponent({ key: "amd-rx-7700-xt", category: "gpu" }, { skipDbLookup: true })!;
    expect(genericGpu.spec.length_mm).toBeUndefined();

    const result = validateBuild(
      {
        cpu: cpu.key,
        gpu: genericGpu.key,
        motherboard: mobo.key,
        ram: ram.key,
        psu: psu.key,
        case: pcCase.key
      },
      {
        resolve: (part) => {
          const map: Record<string, typeof cpu> = {
            [cpu.key]: cpu,
            [genericGpu.key]: genericGpu,
            [mobo.key]: mobo,
            [ram.key]: ram,
            [psu.key]: psu,
            [pcCase.key]: pcCase
          };
          return map[typeof part === "string" ? part : part.key!];
        }
      }
    );

    // Must NOT block the build
    expect(result.valid).toBe(true);

    // Must have unverified GPU clearance check
    const clearanceCheck = result.checks.find((c) => c.rule === "clearance" && c.components.includes(genericGpu.key));
    expect(clearanceCheck).toBeDefined();
    expect(clearanceCheck?.status).toBe("unverified");
    expect(clearanceCheck?.message).toBe(
      "GPU fit couldn’t be verified. Please check the card’s length against the case’s GPU clearance before buying."
    );

    // Must have non-blocking issue with severity needs_verification
    const issue = result.issues.find((i) => i.rule === "clearance" && i.components.includes(genericGpu.key));
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe("needs_verification");

    // Summary must count unverified
    expect(result.summary.unverified).toBeGreaterThan(0);
    expect(result.summary.failed).toBe(0);
    expect(result.summary.text).toContain("unverified");
  });

  it("passes GPU clearance when exact card length fits case clearance", () => {
    // Sapphire Pure is 320mm, case clearance is 360mm
    const exactGpu = resolveComponent({ key: "sapphire-pure-rx-7700-xt", category: "gpu" }, { skipDbLookup: true })!;
    expect(exactGpu.spec.length_mm).toBe(320);

    const result = validateBuild(
      {
        cpu: cpu.key,
        gpu: exactGpu.key,
        motherboard: mobo.key,
        ram: ram.key,
        psu: psu.key,
        case: pcCase.key
      },
      {
        resolve: (part) => {
          const map: Record<string, typeof cpu> = {
            [cpu.key]: cpu,
            [exactGpu.key]: exactGpu,
            [mobo.key]: mobo,
            [ram.key]: ram,
            [psu.key]: psu,
            [pcCase.key]: pcCase
          };
          return map[typeof part === "string" ? part : part.key!];
        }
      }
    );

    expect(result.valid).toBe(true);
    const clearanceCheck = result.checks.find((c) => c.rule === "clearance" && c.components.includes(exactGpu.key));
    expect(clearanceCheck).toBeDefined();
    expect(clearanceCheck?.status).toBe("passed");
    expect(clearanceCheck?.message).toBe("GPU length fits: 320mm card / 360mm case clearance.");
  });

  it("blocks GPU clearance when exact card exceeds case clearance", () => {
    // Sapphire Pure is 320mm, small case clearance is 300mm
    const exactGpu = resolveComponent({ key: "sapphire-pure-rx-7700-xt", category: "gpu" }, { skipDbLookup: true })!;
    const smallCase = makeResolved("case-small", "case", {
      ...pcCase.spec,
      max_gpu_length_mm: 300
    });

    const result = validateBuild(
      {
        cpu: cpu.key,
        gpu: exactGpu.key,
        motherboard: mobo.key,
        ram: ram.key,
        psu: psu.key,
        case: smallCase.key
      },
      {
        resolve: (part) => {
          const map: Record<string, typeof cpu> = {
            [cpu.key]: cpu,
            [exactGpu.key]: exactGpu,
            [mobo.key]: mobo,
            [ram.key]: ram,
            [psu.key]: psu,
            [smallCase.key]: smallCase
          };
          return map[typeof part === "string" ? part : part.key!];
        }
      }
    );

    expect(result.valid).toBe(false);
    const clearanceCheck = result.checks.find((c) => c.rule === "clearance" && c.components.includes(exactGpu.key));
    expect(clearanceCheck).toBeDefined();
    expect(clearanceCheck?.status).toBe("failed");
    expect(clearanceCheck?.message).toBe("GPU is 20mm too long for this case.");

    expect(result.issues).toContainEqual(
      expect.objectContaining({
        rule: "clearance",
        severity: "blocking",
        detail: "GPU is 20mm too long for this case."
      })
    );

    expect(result.summary.failed).toBe(1);
    expect(result.summary.text).toContain("1 check(s) failed");
  });

  it("marks clearance as unverified when case max_gpu_length_mm is missing", () => {
    const exactGpu = resolveComponent({ key: "sapphire-pure-rx-7700-xt", category: "gpu" }, { skipDbLookup: true })!;
    const mysteryCase = makeResolved("case-mystery", "case", {
      ...pcCase.spec,
      max_gpu_length_mm: undefined
    });

    const result = validateBuild(
      {
        cpu: cpu.key,
        gpu: exactGpu.key,
        case: mysteryCase.key
      },
      {
        resolve: (part) => {
          const map: Record<string, typeof cpu> = {
            [cpu.key]: cpu,
            [exactGpu.key]: exactGpu,
            [mysteryCase.key]: mysteryCase
          };
          return map[typeof part === "string" ? part : part.key!];
        }
      }
    );

    expect(result.valid).toBe(true);
    const clearanceCheck = result.checks.find((c) => c.rule === "clearance" && c.components.includes(exactGpu.key));
    expect(clearanceCheck?.status).toBe("unverified");
    expect(clearanceCheck?.message).toBe(
      "GPU fit couldn’t be verified. Please check the card’s length against the case’s GPU clearance before buying."
    );
  });
});
