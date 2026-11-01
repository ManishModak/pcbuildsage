import { describe, it, expect } from "vitest";
import {
  aggregateRuns,
  buildChipIndex,
  chipName,
  parseRuns,
  SCENES,
  type BenchmarkRun,
  type Category
} from "../import-blender-benchmarks";

describe("chipName", () => {
  it("reduces Blender device names and registry models to the same chip name", () => {
    expect(chipName("NVIDIA GeForce RTX 5060 Ti")).toBe(chipName("NVIDIA GeForce RTX 5060 Ti 16GB"));
    expect(chipName("Intel(R) Arc(TM) B580 Graphics")).toBe(chipName("Intel Arc B580"));
    expect(chipName("AMD Ryzen 7 9800X3D 8-Core Processor")).toBe(chipName("AMD Ryzen 7 9800X3D"));
    expect(chipName("13th Gen Intel(R) Core(TM) i5-13400F")).toBe(chipName("Intel Core i5-13400F"));
    expect(chipName("AMD Ryzen 7 8700G w/ Radeon 780M Graphics")).toBe(chipName("AMD Ryzen 7 8700G"));
  });

  it("keeps laptop parts distinct from their desktop namesakes", () => {
    expect(chipName("NVIDIA GeForce RTX 4060 Laptop GPU")).not.toBe(chipName("NVIDIA GeForce RTX 4060"));
    expect(chipName("AMD Radeon RX 7600M XT")).not.toBe(chipName("AMD Radeon RX 7600 XT"));
  });
});

describe("buildChipIndex", () => {
  const registry = {
    $schema: "../schemas/registry.schema.json",
    "nvidia-rtx-5060-ti-8gb": { model: "NVIDIA GeForce RTX 5060 Ti 8GB" },
    "nvidia-rtx-5060-ti-16gb": { model: "NVIDIA GeForce RTX 5060 Ti 16GB" },
    "nvidia-rtx-3050-8gb": { model: "NVIDIA GeForce RTX 3050 8GB" },
    "nvidia-rtx-3050-6gb": { model: "NVIDIA GeForce RTX 3050 6GB" },
    "msi-rtx-5060-ti-shadow-8gb": { model: "MSI GeForce RTX 5060 Ti 8G SHADOW", chip: "nvidia-rtx-5060-ti-8gb" }
  };

  it("groups VRAM-only variants of one chip and drops names shared by different chips", () => {
    const index = buildChipIndex(registry);
    expect(index.get("rtx 5060 ti")).toEqual(["nvidia-rtx-5060-ti-8gb", "nvidia-rtx-5060-ti-16gb"]);
    expect(index.has("rtx 3050")).toBe(false);
    expect([...index.values()].flat()).not.toContain("msi-rtx-5060-ti-shadow-8gb");
  });
});

describe("parseRuns", () => {
  const row = (overrides: Record<string, unknown>) => ({
    blender_version: { label: "5.2.0" },
    scene: { label: "monster" },
    stats: { samples_per_minute: 1500 },
    device_info: { device_type: "OPTIX", compute_devices: [{ name: "NVIDIA GeForce RTX 4060" }] },
    system_info: { num_cpu_sockets: 1 },
    ...overrides
  });

  it("keeps one release, vendor-matched GPU backends and single-socket CPUs", () => {
    const line = JSON.stringify({
      data: [
        row({}),
        row({ blender_version: { label: "5.1.1" } }),
        row({ device_info: { device_type: "CUDA", compute_devices: [{ name: "NVIDIA GeForce RTX 4060" }] } }),
        row({ device_info: { device_type: "OPTIX", compute_devices: [{ name: "A" }, { name: "B" }] } }),
        row({ device_info: { device_type: "CPU", compute_devices: [{ name: "AMD Ryzen 5 7600 6-Core Processor" }] } }),
        row({
          device_info: { device_type: "CPU", compute_devices: [{ name: "AMD EPYC 9654" }] },
          system_info: { num_cpu_sockets: 2 }
        }),
        "not a row"
      ]
    });
    expect(parseRuns(line, "5.2")).toEqual([
      { category: "gpu", device: "NVIDIA GeForce RTX 4060", scene: "monster", samplesPerMinute: 1500 },
      { category: "cpu", device: "AMD Ryzen 5 7600 6-Core Processor", scene: "monster", samplesPerMinute: 1500 }
    ]);
    expect(parseRuns("{not json", "5.2")).toEqual([]);
  });
});

describe("aggregateRuns", () => {
  const chipIndex: Record<Category, Map<string, string[]>> = {
    gpu: new Map([
      ["rtx 4060", ["nvidia-rtx-4060"]],
      ["rtx 5070", ["nvidia-rtx-5070"]],
      ["rtx 5060 ti", ["nvidia-rtx-5060-ti-8gb", "nvidia-rtx-5060-ti-16gb"]],
      ["rtx 5050", ["nvidia-rtx-5050"]]
    ]),
    cpu: new Map([["ryzen 5 7600", ["amd-ryzen-5-7600"]]])
  };
  const runsFor = (category: Category, device: string, perScene: Record<string, number[]>): BenchmarkRun[] =>
    Object.entries(perScene).flatMap(([scene, values]) =>
      values.map((samplesPerMinute) => ({ category, device, scene, samplesPerMinute }))
    );
  const everyScene = (values: number[]) => Object.fromEntries(SCENES.map((scene) => [scene, values]));

  it("scores the geometric mean of per-scene medians against the baseline", () => {
    const runs = [
      // Median 105 per scene: the 5000 outlier doesn't move it.
      ...runsFor("gpu", "NVIDIA GeForce RTX 4060", everyScene([90, 100, 110, 5000])),
      // Twice the baseline in one scene, equal in the others: 100 * 2^(1/3) = 126.
      ...runsFor("gpu", "NVIDIA GeForce RTX 5070", { monster: [210, 210, 210], junkshop: [105, 105, 105], classroom: [105, 105, 105] }),
      ...runsFor("cpu", "AMD Ryzen 5 7600 6-Core Processor", everyScene([80, 80, 80]))
    ];
    const result = aggregateRuns(runs, chipIndex, 3);
    expect(result.scores.gpu["nvidia-rtx-4060"]).toBe(100);
    expect(result.scores.gpu["nvidia-rtx-5070"]).toBe(126);
    expect(result.scores.cpu["amd-ryzen-5-7600"]).toBe(100);
    expect(result.runs["nvidia-rtx-4060"]).toBe(4);
    expect(result.runs["nvidia-rtx-5070"]).toBe(3);
  });

  it("leaves parts unscored below the run minimum, shares VRAM variants and reports unmapped names", () => {
    const runs = [
      ...runsFor("gpu", "NVIDIA GeForce RTX 4060", everyScene([100, 100, 100])),
      ...runsFor("gpu", "NVIDIA GeForce RTX 5060 Ti", everyScene([130, 130, 130])),
      ...runsFor("gpu", "NVIDIA GeForce RTX 5050", { monster: [80, 80, 80], junkshop: [80, 80, 80], classroom: [80, 80] }),
      ...runsFor("gpu", "NVIDIA GeForce RTX 4060 Laptop GPU", everyScene([90])),
      ...runsFor("cpu", "AMD Ryzen 5 7600", everyScene([80, 80, 80]))
    ];
    const result = aggregateRuns(runs, chipIndex, 3);
    expect(result.scores.gpu["nvidia-rtx-5060-ti-8gb"]).toBe(130);
    expect(result.scores.gpu["nvidia-rtx-5060-ti-16gb"]).toBe(130);
    expect(result.shared).toEqual([["nvidia-rtx-5060-ti-8gb", "nvidia-rtx-5060-ti-16gb"]]);
    expect(result.scores.gpu["nvidia-rtx-5050"]).toBeUndefined();
    expect(result.unmapped).toEqual([{ category: "gpu", device: "NVIDIA GeForce RTX 4060 Laptop GPU", runs: 3 }]);
  });

  it("refuses to build a dataset without its baseline", () => {
    const runs = runsFor("cpu", "AMD Ryzen 5 7600", everyScene([80, 80, 80]));
    expect(() => aggregateRuns(runs, chipIndex, 3)).toThrow(/nvidia-rtx-4060/);
  });
});
