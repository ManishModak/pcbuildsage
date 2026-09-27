import { makeResolved, validateBuild, type BuildPart } from "../rules-engine";
import type { ComponentCategory, ResolvedSpec } from "../registry";

export const base = {
  cpu: makeResolved("cpu-am5", "cpu", { brand: "AMD", model: "CPU", aliases: ["CPU"], socket: "AM5", ddr: "DDR5", tdp_w: 65 }),
  gpu: makeResolved("gpu-250w", "gpu", { brand: "NVIDIA", model: "GPU", aliases: ["GPU"], tdp_w: 250, length_mm: 300, vram_gb: 16 }),
  motherboard: makeResolved("mobo-am5", "motherboard", { brand: "MSI", model: "Board", aliases: ["Board"], socket: "AM5", ddr: "DDR5", form_factor: "ATX", m2_slots: 2, sata_ports: 4 }),
  ram: makeResolved("ram-ddr5", "ram", { brand: "Corsair", model: "RAM", aliases: ["RAM"], ddr: "DDR5" }),
  storage: makeResolved("ssd-nvme", "storage", { brand: "Samsung", model: "SSD", aliases: ["SSD"], interface: "nvme", form_factor: "m2-2280", capacity_gb: 1000 }),
  psu: makeResolved("psu-750", "psu", { brand: "Corsair", model: "PSU", aliases: ["PSU"], wattage: 750, form_factor: "ATX" }),
  case: makeResolved("case-atx", "case", { brand: "Corsair", model: "Case", aliases: ["Case"], max_gpu_length_mm: 350, max_cooler_height_mm: 170, form_factors: ["ATX", "Micro-ATX"], supported_psu_form_factors: ["ATX"] }),
  cooler: makeResolved("cooler-am5", "cooler", { brand: "Noctua", model: "Cooler", aliases: ["Cooler"], cooler_type: "air", height_mm: 160, sockets: ["AM5"], tdp_rating_w: 150 })
} satisfies Record<ComponentCategory, ResolvedSpec>;

export type SpecSet = Omit<Record<ComponentCategory, ResolvedSpec>, "storage"> & { storage: ResolvedSpec | ResolvedSpec[] };

export function run(overrides: Partial<SpecSet> = {}) {
  const specs = { ...base, ...overrides };
  const resolve = (part: BuildPart, category: ComponentCategory) => {
    const key = typeof part === "string" ? part : part.key;
    const value = specs[category];
    const list = Array.isArray(value) ? value : [value];
    return list.find((item) => item.key === key);
  };
  return validateBuild(
    {
      cpu: specs.cpu.key,
      gpu: specs.gpu.key,
      motherboard: specs.motherboard.key,
      ram: specs.ram.key,
      storage: Array.isArray(specs.storage) ? specs.storage.map((item) => item.key) : specs.storage.key,
      psu: specs.psu.key,
      case: specs.case.key,
      cooler: specs.cooler.key
    },
    { resolve }
  );
}
