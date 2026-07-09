import { resolveComponent, type ComponentCategory, type Confidence, type RegistrySpec, type ResolvedSpec } from "./registry";

export type BuildPart = string | { key?: string; name?: string; category?: ComponentCategory };
export type BuildParts = Partial<Record<ComponentCategory, BuildPart | BuildPart[]>>;

export type RuleName = "socket" | "ddr" | "wattage" | "clearance" | "cooler" | "storage" | "display_output" | "spec_resolution";
export type IssueSeverity = "blocking" | "needs_research" | "needs_verification";
export type BuildIssue = {
  severity: IssueSeverity;
  rule: RuleName;
  components: string[];
  detail: string;
};
export type ValidationResult = {
  valid: boolean;
  issues: BuildIssue[];
  resolved: Partial<Record<ComponentCategory, ResolvedSpec | ResolvedSpec[]>>;
};

type Resolver = (part: BuildPart, category: ComponentCategory) => ResolvedSpec | undefined;

export function validateBuild(parts: BuildParts, options: { resolve?: Resolver } = {}): ValidationResult {
  const resolve = options.resolve ?? ((part, category) => resolveComponent(toLookup(part, category)));
  const issues: BuildIssue[] = [];
  const resolved: ValidationResult["resolved"] = {};

  const one = (category: ComponentCategory) => {
    const part = parts[category];
    if (!part) return undefined;
    if (Array.isArray(part)) {
      issues.push(blocking("spec_resolution", part.map(label), `Multiple values provided for single-component slot ${category}.`));
      return undefined;
    }
    const spec = resolve(part, category);
    if (!spec) {
      issues.push(needsResearch([label(part)], `No ${category} specs found in registry or research cache.`));
      return undefined;
    }
    resolved[category] = spec;
    return spec;
  };
  const many = (category: ComponentCategory) => {
    const raw = parts[category];
    const items = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const specs = items.flatMap((part) => {
      const spec = resolve(part, category);
      if (!spec) {
        issues.push(needsResearch([label(part)], `No ${category} specs found in registry or research cache.`));
        return [];
      }
      return [spec];
    });
    if (specs.length) resolved[category] = specs;
    return specs;
  };

  const cpu = one("cpu");
  const motherboard = one("motherboard");
  const gpu = one("gpu");
  const psu = one("psu");
  const pcCase = one("case");
  const cooler = one("cooler");
  const ram = one("ram");
  const storage = many("storage");

  checkSocket(cpu, motherboard, issues);
  checkDdr(cpu, motherboard, ram, issues);
  const hasGpu = parts.gpu !== undefined && parts.gpu !== null;
  checkWattage(cpu, gpu, psu, hasGpu, issues);
  checkDisplayOutput(cpu, hasGpu, issues);
  checkClearance(gpu, pcCase, cooler, motherboard, issues);
  checkCooler(cpu, cooler, issues);
  checkStorage(motherboard, storage, issues);

  const dedupedIssues = dedupeIssues(issues);
  return { valid: !dedupedIssues.some((issue) => issue.severity === "blocking" || issue.severity === "needs_research"), issues: dedupedIssues, resolved };
}

function checkSocket(cpu: ResolvedSpec | undefined, motherboard: ResolvedSpec | undefined, issues: BuildIssue[]) {
  if (!cpu || !motherboard) return;
  const cpuSocket = stringSpec(cpu, "socket", issues);
  const boardSocket = stringSpec(motherboard, "socket", issues);
  if (!cpuSocket || !boardSocket) return;
  if (canonicalize(cpuSocket) !== canonicalize(boardSocket)) {
    issues.push(blocking("socket", [cpu.key, motherboard.key], `CPU socket ${cpuSocket} does not match motherboard socket ${boardSocket}.`));
  } else {
    confidenceGate("socket", [cpu, motherboard], issues, `Socket match uses low-confidence researched specs for ${lowNames([cpu, motherboard])}.`);
  }
}

function checkDdr(cpu: ResolvedSpec | undefined, motherboard: ResolvedSpec | undefined, ram: ResolvedSpec | undefined, issues: BuildIssue[]) {
  if (!motherboard) return;
  const boardDdr = stringSpec(motherboard, "ddr", issues);
  const cpuDdr = cpu ? stringSpec(cpu, "ddr", issues) : undefined;
  if (!boardDdr || (cpu && !cpuDdr)) return;
  if (cpu && cpuDdr && canonicalize(cpuDdr) !== canonicalize(boardDdr)) {
    issues.push(blocking("ddr", [cpu.key, motherboard.key], `CPU-supported memory ${cpuDdr} does not match motherboard ${boardDdr}.`));
    return;
  }
  if (!ram) {
    confidenceGate("ddr", [cpu, motherboard].filter(Boolean) as ResolvedSpec[], issues, `DDR match uses low-confidence researched specs for ${lowNames([cpu, motherboard])}.`);
    return;
  }
  const ramDdr = stringSpec(ram, "ddr", issues);
  if (!ramDdr) return;
  if (canonicalize(boardDdr) !== canonicalize(ramDdr)) {
    issues.push(blocking("ddr", [motherboard.key, ram.key], `RAM ${ramDdr} does not match motherboard ${boardDdr}.`));
    return;
  }
  if (cpu && cpuDdr && canonicalize(cpuDdr) !== canonicalize(ramDdr)) {
    issues.push(blocking("ddr", [cpu.key, ram.key], `RAM ${ramDdr} does not match CPU-supported memory ${cpuDdr}.`));
    return;
  }
  confidenceGate("ddr", [cpu, motherboard, ram].filter(Boolean) as ResolvedSpec[], issues, `DDR match uses low-confidence researched specs for ${lowNames([cpu, motherboard, ram])}.`);
}

function checkWattage(cpu: ResolvedSpec | undefined, gpu: ResolvedSpec | undefined, psu: ResolvedSpec | undefined, hasGpu: boolean, issues: BuildIssue[]) {
  if (!cpu || !psu) return;
  const cpuTdp = numberSpec(cpu, "tdp_w", issues);
  const gpuTdp = hasGpu ? (gpu ? numberSpec(gpu, "tdp_w", issues) : undefined) : 0;
  const wattage = numberSpec(psu, "wattage", issues);
  if (cpuTdp === undefined || gpuTdp === undefined || wattage === undefined) return;
  const required = Math.ceil((cpuTdp + gpuTdp + 50) * 1.2);
  const components = [cpu, gpu, psu].filter((component): component is ResolvedSpec => Boolean(component));
  if (required > wattage) {
    issues.push(blocking("wattage", components.map((component) => component.key), `Estimated ${required}W requirement exceeds PSU ${wattage}W.`));
  } else {
    confidenceGate("wattage", components, issues, `Wattage pass uses low-confidence researched specs for ${lowNames(components)}.`);
  }
}

function checkDisplayOutput(cpu: ResolvedSpec | undefined, hasGpu: boolean, issues: BuildIssue[]) {
  if (!cpu || hasGpu) return;
  if (cpu.spec.igpu === false) {
    issues.push(blocking("display_output", [cpu.key], "CPU-only build has no display output because the CPU has no integrated GPU."));
    return;
  }
  if (cpu.spec.igpu === undefined) {
    issues.push(needsResearch([cpu.key], `${cpu.key} is missing required spec "igpu" for CPU-only display output validation.`));
  }
}

function checkClearance(gpu: ResolvedSpec | undefined, pcCase: ResolvedSpec | undefined, cooler: ResolvedSpec | undefined, motherboard: ResolvedSpec | undefined, issues: BuildIssue[]) {
  if (gpu && pcCase) {
    const gpuLength = numberSpec(gpu, "length_mm", issues);
    const maxGpu = numberSpec(pcCase, "max_gpu_length_mm", issues);
    if (gpuLength !== undefined && maxGpu !== undefined) {
      if (gpuLength > maxGpu) issues.push(blocking("clearance", [gpu.key, pcCase.key], `GPU length ${gpuLength}mm exceeds case clearance ${maxGpu}mm.`));
      else confidenceGate("clearance", [gpu, pcCase], issues, `GPU clearance pass uses low-confidence researched specs for ${lowNames([gpu, pcCase])}.`);
    }
  }
  if (cooler && pcCase) {
    const height = numberSpec(cooler, "height_mm", issues);
    const maxHeight = numberSpec(pcCase, "max_cooler_height_mm", issues);
    if (height !== undefined && maxHeight !== undefined) {
      if (height > maxHeight) issues.push(blocking("clearance", [cooler.key, pcCase.key], `Cooler height ${height}mm exceeds case clearance ${maxHeight}mm.`));
      else confidenceGate("clearance", [cooler, pcCase], issues, `Cooler clearance pass uses low-confidence researched specs for ${lowNames([cooler, pcCase])}.`);
    }
  }
  if (motherboard && pcCase) {
    const formFactor = stringSpec(motherboard, "form_factor", issues);
    const supported = arraySpec(pcCase, "form_factors", issues);
    if (formFactor && supported) {
      if (!supported.map(canonicalize).includes(canonicalize(formFactor))) issues.push(blocking("clearance", [motherboard.key, pcCase.key], `Motherboard ${formFactor} is not supported by the case.`));
      else confidenceGate("clearance", [motherboard, pcCase], issues, `Form-factor pass uses low-confidence researched specs for ${lowNames([motherboard, pcCase])}.`);
    }
  }
}

function checkCooler(cpu: ResolvedSpec | undefined, cooler: ResolvedSpec | undefined, issues: BuildIssue[]) {
  if (!cpu || !cooler) return;
  const cpuTdp = numberSpec(cpu, "tdp_w", issues);
  const rating = numberSpec(cooler, "tdp_rating_w", issues);
  const socket = stringSpec(cpu, "socket", issues);
  const sockets = arraySpec(cooler, "sockets", issues);
  if (cpuTdp === undefined || rating === undefined || !socket || !sockets) return;
  if (rating < cpuTdp) {
    issues.push(blocking("cooler", [cpu.key, cooler.key], `Cooler ${rating}W rating is below CPU ${cpuTdp}W TDP.`));
    return;
  }
  if (!sockets.map(canonicalize).includes(canonicalize(socket))) {
    issues.push(blocking("cooler", [cpu.key, cooler.key], `Cooler does not list a ${socket} mounting bracket.`));
    return;
  }
  confidenceGate("cooler", [cpu, cooler], issues, `Cooler pass uses low-confidence researched specs for ${lowNames([cpu, cooler])}.`);
}

function checkStorage(motherboard: ResolvedSpec | undefined, drives: ResolvedSpec[], issues: BuildIssue[]) {
  if (!motherboard || drives.length === 0) return;
  const interfaces = drives.map((drive) => ({ drive, value: stringSpec(drive, "interface", issues) }));
  const nvmeCount = interfaces.filter(({ value }) => canonicalize(value) === "nvme").length;
  const sataCount = interfaces.filter(({ value }) => canonicalize(value) === "sata").length;
  const m2Slots = nvmeCount > 0 ? numberSpec(motherboard, "m2_slots", issues) : undefined;
  const sataPorts = sataCount > 0 ? numberSpec(motherboard, "sata_ports", issues) : undefined;
  if (nvmeCount > 0 && m2Slots === undefined) return;
  if (sataCount > 0 && sataPorts === undefined) return;
  if (nvmeCount > (m2Slots ?? 0)) {
    issues.push(blocking("storage", [motherboard.key, ...drives.map((drive) => drive.key)], `${nvmeCount} NVMe drives require ${nvmeCount} M.2 slots; motherboard has ${m2Slots}.`));
    return;
  }
  if (sataCount > 0 && sataPorts !== undefined) {
    if (sataCount > sataPorts) {
      issues.push(blocking("storage", [motherboard.key, ...drives.map((drive) => drive.key)], `${sataCount} SATA drives require ${sataCount} SATA ports; motherboard has ${sataPorts}.`));
      return;
    }
  }
  confidenceGate("storage", [motherboard, ...drives], issues, `Storage pass uses low-confidence researched specs for ${lowNames([motherboard, ...drives])}.`);
}

function stringSpec(component: ResolvedSpec, key: string, issues: BuildIssue[]) {
  const value = component.spec[key];
  if (typeof value === "string" && value.length > 0) return value;
  issues.push(needsResearch([component.key], `${component.key} is missing required spec "${key}".`));
  return undefined;
}

function numberSpec(component: ResolvedSpec, key: string, issues: BuildIssue[]) {
  const value = component.spec[key];
  if (typeof value === "number") return value;
  issues.push(needsResearch([component.key], `${component.key} is missing required spec "${key}".`));
  return undefined;
}

function arraySpec(component: ResolvedSpec, key: string, issues: BuildIssue[]) {
  const value = component.spec[key];
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
  issues.push(needsResearch([component.key], `${component.key} is missing required spec "${key}".`));
  return undefined;
}

function confidenceGate(rule: RuleName, components: ResolvedSpec[], issues: BuildIssue[], detail: string) {
  if (components.some((component) => component.confidence === "low")) {
    issues.push({ severity: "needs_verification", rule, components: components.map((component) => component.key), detail });
  }
}

function lowNames(components: Array<ResolvedSpec | undefined>) {
  return components.filter((component): component is ResolvedSpec => component?.confidence === "low").map((component) => component.key).join(", ");
}

function blocking(rule: RuleName, components: string[], detail: string): BuildIssue {
  return { severity: "blocking", rule, components, detail };
}

function needsResearch(components: string[], detail: string): BuildIssue {
  return { severity: "needs_research", rule: "spec_resolution", components, detail };
}

function canonicalize(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase().replace(/[\s-]+/g, "") : "";
}

function dedupeIssues(issues: BuildIssue[]): BuildIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = JSON.stringify([issue.severity, issue.rule, issue.components, issue.detail]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function toLookup(part: BuildPart, category: ComponentCategory) {
  return typeof part === "string" ? { key: part, name: part, category } : { ...part, category };
}

function label(part: BuildPart): string {
  return typeof part === "string" ? part : part.key ?? part.name ?? "unknown component";
}

export function makeResolved(key: string, category: ComponentCategory, spec: RegistrySpec, confidence: Confidence = "high", source: "registry" | "research" = "registry"): ResolvedSpec {
  return { key, category, spec, confidence, source };
}
