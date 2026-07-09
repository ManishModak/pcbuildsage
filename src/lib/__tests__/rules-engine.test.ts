import { describe, expect, it } from "vitest";
import { makeResolved, validateBuild, type BuildPart } from "../rules-engine";
import { resolveComponent, type ComponentCategory, type ResolvedSpec } from "../registry";

const base = {
  cpu: makeResolved("cpu-am5", "cpu", { brand: "AMD", model: "CPU", aliases: ["CPU"], socket: "AM5", ddr: "DDR5", tdp_w: 65 }),
  gpu: makeResolved("gpu-250w", "gpu", { brand: "NVIDIA", model: "GPU", aliases: ["GPU"], tdp_w: 250, length_mm: 300, vram_gb: 16 }),
  motherboard: makeResolved("mobo-am5", "motherboard", { brand: "MSI", model: "Board", aliases: ["Board"], socket: "AM5", ddr: "DDR5", form_factor: "ATX", m2_slots: 2, sata_ports: 4 }),
  ram: makeResolved("ram-ddr5", "ram", { brand: "Corsair", model: "RAM", aliases: ["RAM"], ddr: "DDR5" }),
  storage: makeResolved("ssd-nvme", "storage", { brand: "Samsung", model: "SSD", aliases: ["SSD"], interface: "nvme", form_factor: "m2-2280", capacity_gb: 1000 }),
  psu: makeResolved("psu-750", "psu", { brand: "Corsair", model: "PSU", aliases: ["PSU"], wattage: 750 }),
  case: makeResolved("case-atx", "case", { brand: "Corsair", model: "Case", aliases: ["Case"], max_gpu_length_mm: 350, max_cooler_height_mm: 170, form_factors: ["ATX", "Micro-ATX"] }),
  cooler: makeResolved("cooler-am5", "cooler", { brand: "Noctua", model: "Cooler", aliases: ["Cooler"], height_mm: 160, sockets: ["AM5"], tdp_rating_w: 150 })
} satisfies Record<ComponentCategory, ResolvedSpec>;

type SpecSet = Omit<Record<ComponentCategory, ResolvedSpec>, "storage"> & { storage: ResolvedSpec | ResolvedSpec[] };

function run(overrides: Partial<SpecSet> = {}) {
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

describe("validateBuild", () => {
  it("passes a compatible build across all six rules", () => {
    expect(run().issues).toEqual([]);
    expect(run().valid).toBe(true);
  });

  it("passes wattage at the exact 1.2 headroom boundary", () => {
    const result = run({ psu: makeResolved("psu-438", "psu", { brand: "Corsair", model: "PSU", aliases: ["PSU"], wattage: 438 }) });
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("passes socket, DDR, clearance, cooler, and storage edge boundaries", () => {
    const result = run({
      gpu: makeResolved("gpu-edge", "gpu", { ...base.gpu.spec, length_mm: 350 }),
      cooler: makeResolved("cooler-edge", "cooler", { ...base.cooler.spec, height_mm: 170, tdp_rating_w: 65 }),
      storage: [
        base.storage,
        makeResolved("ssd-nvme-2", "storage", { ...base.storage.spec, model: "SSD2" }),
        makeResolved("ssd-sata-1", "storage", { ...base.storage.spec, model: "SATA1", interface: "sata" }),
        makeResolved("ssd-sata-2", "storage", { ...base.storage.spec, model: "SATA2", interface: "sata" }),
        makeResolved("ssd-sata-3", "storage", { ...base.storage.spec, model: "SATA3", interface: "sata" }),
        makeResolved("ssd-sata-4", "storage", { ...base.storage.spec, model: "SATA4", interface: "sata" })
      ]
    });
    expect(result.issues).toEqual([]);
  });

  it("blocks mismatched CPU and motherboard sockets", () => {
    const result = run({ motherboard: makeResolved("mobo-lga", "motherboard", { ...base.motherboard.spec, socket: "LGA 1700" }) });
    expect(result.issues).toContainEqual(expect.objectContaining({ severity: "blocking", rule: "socket" }));
  });

  it("requests research when socket fields are missing", () => {
    const result = run({ cpu: makeResolved("cpu-no-socket", "cpu", { ...base.cpu.spec, socket: undefined }) });
    expect(result.issues).toContainEqual(expect.objectContaining({ severity: "needs_research", rule: "spec_resolution" }));
  });

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

  it("blocks CPU-only builds when the CPU has no integrated GPU", () => {
    const cpu = makeResolved("cpu-no-igpu", "cpu", { ...base.cpu.spec, igpu: false });
    const result = validateBuild({ cpu: cpu.key }, { resolve: (part) => (part === cpu.key ? cpu : undefined) });
    expect(result.issues).toContainEqual(expect.objectContaining({ severity: "blocking", rule: "display_output", detail: expect.stringContaining("no display output") }));
  });

  it("requests research for CPU-only builds when integrated GPU status is unknown", () => {
    const cpu = makeResolved("cpu-unknown-igpu", "cpu", { ...base.cpu.spec, igpu: undefined });
    const result = validateBuild({ cpu: cpu.key }, { resolve: (part) => (part === cpu.key ? cpu : undefined) });
    expect(result.issues).toContainEqual(expect.objectContaining({ severity: "needs_research", detail: expect.stringContaining("\"igpu\"") }));
  });

  it("blocks arrays passed to single-component slots", () => {
    const result = validateBuild({ cpu: ["cpu-a", "cpu-b"] });
    expect(result.issues).toContainEqual(expect.objectContaining({ severity: "blocking", rule: "spec_resolution", detail: expect.stringContaining("single-component slot cpu") }));
  });

  it("blocks GPU, cooler, and motherboard physical clearance failures", () => {
    expect(run({ gpu: makeResolved("gpu-long", "gpu", { ...base.gpu.spec, length_mm: 400 }) }).issues).toContainEqual(expect.objectContaining({ rule: "clearance", severity: "blocking" }));
    expect(run({ cooler: makeResolved("cooler-tall", "cooler", { ...base.cooler.spec, height_mm: 190 }) }).issues).toContainEqual(expect.objectContaining({ rule: "clearance", severity: "blocking" }));
    expect(run({ case: makeResolved("case-itx", "case", { ...base.case.spec, form_factors: ["Mini-ITX"] }) }).issues).toContainEqual(expect.objectContaining({ rule: "clearance", severity: "blocking" }));
  });

  it("requests research when clearance fields are missing", () => {
    const result = run({ case: makeResolved("case-no-clearance", "case", { ...base.case.spec, max_gpu_length_mm: undefined }) });
    expect(result.issues).toContainEqual(expect.objectContaining({ severity: "needs_research", rule: "spec_resolution" }));
  });

  it("blocks inadequate cooler TDP and missing socket brackets", () => {
    expect(run({ cooler: makeResolved("cooler-weak", "cooler", { ...base.cooler.spec, tdp_rating_w: 50 }) }).issues).toContainEqual(expect.objectContaining({ rule: "cooler", severity: "blocking" }));
    expect(run({ cooler: makeResolved("cooler-lga", "cooler", { ...base.cooler.spec, sockets: ["LGA 1700"] }) }).issues).toContainEqual(expect.objectContaining({ rule: "cooler", severity: "blocking" }));
  });

  it("requests research when cooler fields are missing", () => {
    const result = run({ cooler: makeResolved("cooler-no-rating", "cooler", { ...base.cooler.spec, tdp_rating_w: undefined }) });
    expect(result.issues).toContainEqual(expect.objectContaining({ severity: "needs_research", rule: "spec_resolution" }));
  });

  it("blocks NVMe drives beyond M.2 slot count and SATA drives beyond ports", () => {
    const drives = [
      base.storage,
      makeResolved("ssd-nvme-2", "storage", { ...base.storage.spec, model: "SSD2" }),
      makeResolved("ssd-nvme-3", "storage", { ...base.storage.spec, model: "SSD3" })
    ];
    expect(run({ storage: drives }).issues).toContainEqual(expect.objectContaining({ rule: "storage", severity: "blocking" }));
    const sata = [
      makeResolved("sata-1", "storage", { ...base.storage.spec, interface: "sata" }),
      makeResolved("sata-2", "storage", { ...base.storage.spec, interface: "sata" })
    ];
    expect(run({ motherboard: makeResolved("mobo-one-sata", "motherboard", { ...base.motherboard.spec, sata_ports: 1 }), storage: sata }).issues).toContainEqual(expect.objectContaining({ rule: "storage", severity: "blocking" }));
  });

  it("requests research when storage slot or port fields are missing", () => {
    expect(run({ motherboard: makeResolved("mobo-no-m2", "motherboard", { ...base.motherboard.spec, m2_slots: undefined }) }).issues).toContainEqual(expect.objectContaining({ severity: "needs_research" }));
    expect(run({ motherboard: makeResolved("mobo-no-sata", "motherboard", { ...base.motherboard.spec, sata_ports: undefined }), storage: makeResolved("sata", "storage", { ...base.storage.spec, interface: "sata" }) }).issues).toContainEqual(expect.objectContaining({ severity: "needs_research" }));
  });

  it("does not require M.2 slot specs for SATA-only builds", () => {
    const result = run({
      motherboard: makeResolved("mobo-sata-only", "motherboard", { ...base.motherboard.spec, m2_slots: undefined }),
      storage: makeResolved("sata", "storage", { ...base.storage.spec, interface: "sata" })
    });
    expect(result.issues).not.toContainEqual(expect.objectContaining({ severity: "needs_research", detail: expect.stringContaining("\"m2_slots\"") }));
  });

  it("passes SATA-count validation with sata_ports from the registry", () => {
    const motherboard = resolveComponent("msi-mag-b650-tomahawk-wifi");
    if (!motherboard) throw new Error("registry motherboard fixture missing");
    const drives = Array.from({ length: 6 }, (_, index) => makeResolved(`sata-${index}`, "storage", { ...base.storage.spec, model: `SATA ${index}`, interface: "sata" }));
    const result = validateBuild(
      { motherboard: motherboard.key, storage: drives.map((drive) => drive.key) },
      { resolve: (part, category) => category === "motherboard" ? motherboard : drives.find((drive) => drive.key === part) }
    );
    expect(result.issues).not.toContainEqual(expect.objectContaining({ rule: "storage" }));
    expect(result.valid).toBe(true);
  });

  it("requests research when a drive interface is missing", () => {
    const result = run({ storage: makeResolved("ssd-unknown-interface", "storage", { ...base.storage.spec, interface: undefined }) });
    expect(result.issues).toContainEqual(expect.objectContaining({ severity: "needs_research", detail: expect.stringContaining("\"interface\"") }));
  });

  it("dedupes duplicate missing-spec issues for the same component", () => {
    const result = run({ cpu: makeResolved("cpu-no-socket", "cpu", { ...base.cpu.spec, socket: undefined }) });
    const socketIssues = result.issues.filter((issue) => issue.severity === "needs_research" && issue.detail.includes("\"socket\""));
    expect(socketIssues).toHaveLength(1);
  });

  it("matches sockets and form factors across formatting variants", () => {
    const result = run({
      cpu: makeResolved("cpu-lga1700", "cpu", { ...base.cpu.spec, socket: "LGA1700" }),
      motherboard: makeResolved("mobo-lga-1700", "motherboard", { ...base.motherboard.spec, socket: "LGA 1700", form_factor: "Mini ITX" }),
      case: makeResolved("case-mini-itx", "case", { ...base.case.spec, form_factors: ["Mini-ITX"] }),
      cooler: makeResolved("cooler-lga-1700", "cooler", { ...base.cooler.spec, sockets: ["LGA-1700"] })
    });
    expect(result.issues).not.toContainEqual(expect.objectContaining({ severity: "blocking", rule: "socket" }));
    expect(result.issues).not.toContainEqual(expect.objectContaining({ severity: "blocking", rule: "clearance" }));
    expect(result.issues).not.toContainEqual(expect.objectContaining({ severity: "blocking", rule: "cooler" }));
  });

  it("requests research for unknown components and incomplete specs", () => {
    const unknown = validateBuild({ cpu: "missing", motherboard: "mobo-am5" }, { resolve: (part, category) => (part === "mobo-am5" && category === "motherboard" ? base.motherboard : undefined) });
    expect(unknown.issues).toContainEqual(expect.objectContaining({ severity: "needs_research" }));
  });

  it("downgrades passing rules with low-confidence researched specs to needs_verification", () => {
    const result = run({ cpu: makeResolved("cpu-researched", "cpu", base.cpu.spec, "low", "research") });
    expect(result.valid).toBe(true);
    expect(result.issues).toContainEqual(expect.objectContaining({ severity: "needs_verification" }));
  });

  it("does not report false display_output or wattage issues when GPU is specified but unresolved", () => {
    const cpu = makeResolved("cpu-no-igpu", "cpu", { ...base.cpu.spec, igpu: false, tdp_w: 125 });
    const psu = makeResolved("psu-500", "psu", { ...base.psu.spec, wattage: 500 });
    const result = validateBuild(
      { cpu: cpu.key, gpu: "unresolved-gpu", psu: psu.key },
      { resolve: (part) => (part === cpu.key ? cpu : part === psu.key ? psu : undefined) }
    );
    expect(result.issues).toContainEqual(expect.objectContaining({ severity: "needs_research" }));
    expect(result.issues).not.toContainEqual(expect.objectContaining({ severity: "blocking", rule: "display_output" }));
    expect(result.issues).not.toContainEqual(expect.objectContaining({ severity: "blocking", rule: "wattage" }));
  });
});
