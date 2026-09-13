import { hasWattageConflict, resolveComponent, type ComponentCategory, type Confidence, type RegistrySpec, type ResolvedSpec } from "./registry";

export type RuleCheckStatus = "passed" | "failed" | "unverified";
export type CheckStatus = RuleCheckStatus;
export type RuleName = "socket" | "ddr" | "wattage" | "clearance" | "cooler" | "storage" | "display_output" | "spec_resolution";
export type RuleCheckResult = {
  rule: RuleName;
  status: RuleCheckStatus;
  components: string[];
  message: string;
};
export type ValidationSummary = {
  passed: number;
  failed: number;
  unverified: number;
  text: string;
};

export type BuildPart = string | { product_id?: string; key?: string; name?: string; category?: ComponentCategory };
export type BuildParts = Partial<Record<ComponentCategory, BuildPart | BuildPart[]>>;

export type IssueSeverity = "blocking" | "needs_research" | "needs_verification" | "advisory";
export type BuildIssue = {
  severity: IssueSeverity;
  rule: RuleName;
  components: string[];
  detail: string;
};
export type SkippedCheck = { rule: RuleName; missing: ComponentCategory[] };
export type ValidationResult = {
  valid: boolean;
  issues: BuildIssue[];
  resolved: Partial<Record<ComponentCategory, ResolvedSpec | ResolvedSpec[]>>;
  /** Rules that never ran because the build has no part in that slot. Absent
   *  categories are a scraping choice, not a build error - but the model must
   *  disclose which guarantees it is therefore NOT making. */
  skipped_checks: SkippedCheck[];
  checks: RuleCheckResult[];
  summary: ValidationSummary;
};

/** Which parts each rule needs before it can say anything at all. */
const RULE_INPUTS: Array<{ rule: RuleName; needs: ComponentCategory[] }> = [
  { rule: "socket", needs: ["cpu", "motherboard"] },
  { rule: "ddr", needs: ["motherboard", "ram"] },
  { rule: "wattage", needs: ["cpu", "psu"] },
  { rule: "cooler", needs: ["cpu", "cooler"] },
  { rule: "clearance", needs: ["case"] },
  { rule: "storage", needs: ["motherboard", "storage"] },
  { rule: "display_output", needs: ["cpu"] }
];

type Resolver = (part: BuildPart, category: ComponentCategory) => ResolvedSpec | undefined;
type CheckRecorder = (rule: RuleName, status: RuleCheckStatus, components: string[], message: string) => void;

export function recordCheck(
  checks: RuleCheckResult[],
  rule: RuleName,
  status: RuleCheckStatus,
  components: string[],
  message: string
): void {
  checks.push({ rule, status, components, message });
}

export function resolveIncludedCooler(
  cpu: ResolvedSpec | undefined,
  part: BuildPart | undefined,
  resolve: Resolver
): ResolvedSpec {
  const cpuCoolerName = typeof cpu?.spec?.cooler_name === "string" ? cpu.spec.cooler_name : undefined;
  const partCoolerName =
    typeof part === "object" && part && typeof part.name === "string" && !isMarkedIncluded(part)
      ? part.name
      : undefined;
  const candidateName: string | undefined = cpuCoolerName ?? partCoolerName;

  if (candidateName) {
    const resolvedCustom = resolve({ name: candidateName, category: "cooler" }, "cooler");
    if (resolvedCustom) return resolvedCustom;

    const resolvedRegistry = resolveComponent({ name: candidateName, category: "cooler" }, { skipDbLookup: true });
    if (resolvedRegistry) return resolvedRegistry;
  }

  const modelName: string =
    typeof part === "string"
      ? part
      : (typeof part?.name === "string"
          ? part.name
          : (typeof cpu?.spec?.cooler_name === "string" ? cpu.spec.cooler_name : "Stock Cooler"));
  return {
    key: "included-stock-cooler",
    category: "cooler",
    spec: {
      brand: "Stock",
      model: modelName,
      aliases: ["Stock Cooler", "included"]
    },
    confidence: "low",
    source: "registry"
  };
}

export function validateBuild(parts: BuildParts, options: { resolve?: Resolver } = {}): ValidationResult {
  const resolve = options.resolve ?? ((part, category) => resolveComponent(toLookup(part, category)));
  const extraIssues: BuildIssue[] = [];
  const resolved: ValidationResult["resolved"] = {};
  const checks: RuleCheckResult[] = [];

  const recordCheckLocal: CheckRecorder = (rule, status, components, message) => {
    recordCheck(checks, rule, status, components, message);
  };

  const one = (category: ComponentCategory) => {
    const part = parts[category];
    if (!part) return undefined;
    if (Array.isArray(part)) {
      recordCheckLocal("spec_resolution", "failed", part.map(label), `Multiple values provided for single-component slot ${category}.`);
      return undefined;
    }
    let spec = resolve(part, category);
    if (!spec && category === "cooler" && isMarkedIncluded(part)) {
      spec = resolveIncludedCooler(cpu, part, resolve);
    }
    if (!spec) {
      recordCheckLocal("spec_resolution", "unverified", [label(part)], `No ${category} specs found in registry or research cache.`);
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
        recordCheckLocal("spec_resolution", "unverified", [label(part)], `No ${category} specs found in registry or research cache.`);
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
  let cooler = one("cooler");
  const ram = one("ram");
  const storage = many("storage");

  if (!cooler && cpu?.spec.cooler_included === "included" && parts.cooler === undefined) {
    cooler = resolveIncludedCooler(cpu, undefined, resolve);
    if (cooler) {
      resolved.cooler = cooler;
    }
  }

  checkSocket(cpu, motherboard, recordCheckLocal, extraIssues);
  checkDdr(cpu, motherboard, ram, recordCheckLocal, extraIssues);
  const hasGpu = parts.gpu !== undefined && parts.gpu !== null;
  checkWattage(cpu, gpu, psu, hasGpu, recordCheckLocal, extraIssues);
  checkDisplayOutput(cpu, gpu, hasGpu, recordCheckLocal, extraIssues);
  checkClearance(gpu, pcCase, cooler, motherboard, recordCheckLocal, extraIssues);
  checkCooler(cpu, cooler, recordCheckLocal, extraIssues);
  checkStorage(motherboard, storage, recordCheckLocal, extraIssues);

  const isCoolerIncluded =
    cpu?.spec.cooler_included === "included" ||
    (parts.cooler !== undefined && isMarkedIncluded(parts.cooler as BuildPart));

  const skipped_checks = RULE_INPUTS.flatMap(({ rule, needs }) => {
    if (rule === "cooler" && isCoolerIncluded) {
      return [];
    }
    const missing = needs.filter((category) => {
      const part = parts[category];
      return part === undefined || part === null || (Array.isArray(part) && part.length === 0);
    });
    return missing.length ? [{ rule, missing }] : [];
  });

  const passed = checks.filter((c) => c.status === "passed").length;
  const failed = checks.filter((c) => c.status === "failed").length;
  const unverified = checks.filter((c) => c.status === "unverified").length;
  let text: string;
  if (failed > 0) {
    text = `${failed} check(s) failed · ${passed} passed · ${unverified} unverified`;
  } else if (unverified > 0) {
    text = `${passed} checks passed · ${unverified} unverified`;
  } else {
    text = `All ${passed} checks passed`;
  }
  const summary: ValidationSummary = { passed, failed, unverified, text };

  const derivedIssues: BuildIssue[] = checks.flatMap((check): BuildIssue[] => {
    if (check.status === "failed") {
      return [{ severity: "blocking", rule: check.rule, components: check.components, detail: check.message }];
    }
    if (check.status === "unverified") {
      return [{ severity: "needs_verification", rule: check.rule, components: check.components, detail: check.message }];
    }
    return [];
  });

  const dedupedIssues = dedupeIssues([...derivedIssues, ...extraIssues]);
  return {
    valid: failed === 0,
    issues: dedupedIssues,
    resolved,
    skipped_checks,
    checks,
    summary
  };
}

/**
 * True when a spec came from the registry but cannot cite a source.
 *
 * Such an entry is a placeholder (see entryConfidence in registry.ts), and a rule
 * that computes on it produces a confident wrong answer - the worst possible
 * output for a compatibility checker. Refusing to read the spec turns that into a
 * needs_research issue, which is the signal that already drives the consult
 * self-heal loop. A researched spec, even a low-confidence one, cites its sources
 * and is allowed through to confidenceGate; that also stops research -> validate ->
 * research looping forever on a part the web simply has little data about.
 */
function untrusted(component: ResolvedSpec, issues: BuildIssue[]): boolean {
  if (component.source !== "registry" || component.confidence !== "low") return false;
  issues.push(
    needsResearch(
      [component.key],
      `${component.key} has unsourced placeholder specs in the registry. Research it with consult before any compatibility verdict is given.`
    )
  );
  return true;
}

function isUntrusted(component: ResolvedSpec): boolean {
  return component.source === "registry" && component.confidence === "low";
}

function trustedNumber(component: ResolvedSpec, key: string, issues: BuildIssue[]): number | undefined {
  if (untrusted(component, issues)) return undefined;
  const val = component.spec[key];
  return typeof val === "number" ? val : undefined;
}

function checkSocket(cpu: ResolvedSpec | undefined, motherboard: ResolvedSpec | undefined, recordCheck: CheckRecorder, issues: BuildIssue[]) {
  if (!cpu || !motherboard) return;
  const cpuSocket = stringSpec(cpu, "socket", issues);
  const boardSocket = stringSpec(motherboard, "socket", issues);
  if (!cpuSocket || !boardSocket) {
    recordCheck(
      "socket",
      "unverified",
      [cpu.key, motherboard.key],
      "Socket compatibility couldn't be verified due to missing socket specs."
    );
    return;
  }
  if (canonicalize(cpuSocket) !== canonicalize(boardSocket)) {
    const msg = `CPU socket ${cpuSocket} does not match motherboard socket ${boardSocket}.`;
    recordCheck("socket", "failed", [cpu.key, motherboard.key], msg);
  } else {
    recordCheck("socket", "passed", [cpu.key, motherboard.key], `CPU socket ${cpuSocket} matches motherboard socket ${boardSocket}.`);
    confidenceGate("socket", [cpu, motherboard], issues, `Socket match uses low-confidence researched specs for ${lowNames([cpu, motherboard])}.`);
  }
}

function checkDdr(cpu: ResolvedSpec | undefined, motherboard: ResolvedSpec | undefined, ram: ResolvedSpec | undefined, recordCheck: CheckRecorder, issues: BuildIssue[]) {
  if (!motherboard) return;
  const boardDdr = stringSpec(motherboard, "ddr", issues);
  const cpuDdr = cpu ? stringSpec(cpu, "ddr", issues) : undefined;
  if (!boardDdr || (cpu && !cpuDdr)) {
    recordCheck(
      "ddr",
      "unverified",
      [motherboard.key, ...(cpu ? [cpu.key] : [])],
      "DDR compatibility couldn't be verified due to missing specs."
    );
    return;
  }
  if (cpu && cpuDdr && canonicalize(cpuDdr) !== canonicalize(boardDdr)) {
    const msg = `CPU-supported memory ${cpuDdr} does not match motherboard ${boardDdr}.`;
    recordCheck("ddr", "failed", [cpu.key, motherboard.key], msg);
    return;
  }
  if (!ram) {
    recordCheck(
      "ddr",
      "passed",
      [cpu, motherboard].filter(Boolean).map((c) => c!.key),
      `CPU memory support (${cpuDdr}) matches motherboard (${boardDdr}).`
    );
    confidenceGate("ddr", [cpu, motherboard].filter(Boolean) as ResolvedSpec[], issues, `DDR match uses low-confidence researched specs for ${lowNames([cpu, motherboard])}.`);
    return;
  }
  const ramDdr = stringSpec(ram, "ddr", issues);
  if (!ramDdr) {
    recordCheck(
      "ddr",
      "unverified",
      [motherboard.key, ram.key, ...(cpu ? [cpu.key] : [])],
      "RAM DDR specification is missing."
    );
    return;
  }
  if (canonicalize(boardDdr) !== canonicalize(ramDdr)) {
    const msg = `RAM ${ramDdr} does not match motherboard ${boardDdr}.`;
    recordCheck("ddr", "failed", [motherboard.key, ram.key], msg);
    return;
  }
  if (cpu && cpuDdr && canonicalize(cpuDdr) !== canonicalize(ramDdr)) {
    const msg = `RAM ${ramDdr} does not match CPU-supported memory ${cpuDdr}.`;
    recordCheck("ddr", "failed", [cpu.key, ram.key], msg);
    return;
  }
  if (isSingleModuleRam(ram)) {
    issues.push({
      severity: "advisory",
      rule: "ddr",
      components: [ram.key],
      detail: `Single-channel RAM detected (${ram.spec.model || ram.key}). Dual-channel memory (e.g. 2×8GB or 2×16GB) is recommended for optimal bandwidth and gaming frame rates.`
    });
  }
  recordCheck(
    "ddr",
    "passed",
    [cpu, motherboard, ram].filter(Boolean).map((c) => c!.key),
    `RAM (${ramDdr}) matches motherboard and CPU memory support.`
  );
  confidenceGate("ddr", [cpu, motherboard, ram].filter(Boolean) as ResolvedSpec[], issues, `DDR match uses low-confidence researched specs for ${lowNames([cpu, motherboard, ram])}.`);
}

function checkWattage(
  cpu: ResolvedSpec | undefined,
  gpu: ResolvedSpec | undefined,
  psu: ResolvedSpec | undefined,
  hasGpu: boolean,
  recordCheck: CheckRecorder,
  issues: BuildIssue[]
) {
  if (!cpu || !psu) return;
  if (hasWattageConflict(psu.spec)) {
    const w = psu.spec.wattage;
    const wLegacy = psu.spec.wattage_w;
    recordCheck(
      "wattage",
      "unverified",
      [psu.key],
      `Conflicting wattage specifications for ${psu.key}: wattage (${w}W) and wattage_w (${wLegacy}W) disagree.`
    );
    return;
  }
  const cpuTdp = numberSpec(cpu, "tdp_w", issues);
  const gpuTdp = hasGpu ? (gpu ? numberSpec(gpu, "tdp_w", issues) : undefined) : 0;
  const wattage = numberSpec(psu, "wattage", issues);
  const components = [cpu, gpu, psu].filter((component): component is ResolvedSpec => Boolean(component));
  if (cpuTdp === undefined || gpuTdp === undefined || wattage === undefined) {
    recordCheck(
      "wattage",
      "unverified",
      components.map((c) => c.key),
      "Wattage requirement couldn't be verified due to missing power specs."
    );
    return;
  }
  const required = Math.ceil((cpuTdp + gpuTdp + 50) * 1.2);
  if (required > wattage) {
    const msg = `Estimated ${required}W requirement exceeds PSU ${wattage}W.`;
    recordCheck("wattage", "failed", components.map((c) => c.key), msg);
  } else {
    recordCheck("wattage", "passed", components.map((c) => c.key), `PSU wattage (${wattage}W) covers estimated requirement (${required}W).`);
    confidenceGate("wattage", components, issues, `Wattage pass uses low-confidence researched specs for ${lowNames(components)}.`);
  }
}

function checkDisplayOutput(
  cpu: ResolvedSpec | undefined,
  gpu: ResolvedSpec | undefined,
  hasGpu: boolean,
  recordCheck: CheckRecorder,
  issues: BuildIssue[]
) {
  if (!cpu) return;
  if (hasGpu) {
    const components = gpu?.key ? [gpu.key] : [cpu.key];
    recordCheck(
      "display_output",
      "passed",
      components,
      "Discrete GPU provides display output."
    );
    return;
  }
  if (untrusted(cpu, issues)) {
    recordCheck(
      "display_output",
      "unverified",
      [cpu.key],
      "Display output couldn't be verified because CPU specs are unsourced."
    );
    return;
  }
  if (cpu.spec.igpu === false) {
    const msg = "CPU-only build has no display output because the CPU has no integrated GPU.";
    recordCheck("display_output", "failed", [cpu.key], msg);
    return;
  }
  if (cpu.spec.igpu === true) {
    recordCheck(
      "display_output",
      "passed",
      [cpu.key],
      "CPU includes integrated graphics for display output."
    );
    return;
  }
  if (cpu.spec.igpu === undefined) {
    const msg = `Integrated GPU status is unknown for ${cpu.key}.`;
    recordCheck("display_output", "unverified", [cpu.key], msg);
    issues.push(needsResearch([cpu.key], `${cpu.key} is missing required spec "igpu" for CPU-only display output validation.`));
  }
}

function checkClearance(
  gpu: ResolvedSpec | undefined,
  pcCase: ResolvedSpec | undefined,
  cooler: ResolvedSpec | undefined,
  motherboard: ResolvedSpec | undefined,
  recordCheck: CheckRecorder,
  issues: BuildIssue[]
) {
  if (gpu && pcCase) {
    const gpuLength = trustedNumber(gpu, "length_mm", issues);
    const maxGpu = trustedNumber(pcCase, "max_gpu_length_mm", issues);
    if (gpuLength !== undefined && maxGpu !== undefined) {
      if (gpuLength <= maxGpu) {
        recordCheck(
          "clearance",
          "passed",
          [gpu.key, pcCase.key],
          `GPU length fits: ${gpuLength}mm card / ${maxGpu}mm case clearance.`
        );
        confidenceGate("clearance", [gpu, pcCase], issues, `GPU clearance pass uses low-confidence researched specs for ${lowNames([gpu, pcCase])}.`);
      } else {
        const msg = `GPU is ${gpuLength - maxGpu}mm too long for this case.`;
        recordCheck("clearance", "failed", [gpu.key, pcCase.key], msg);
      }
    } else {
      const msg = "GPU fit couldn’t be verified. Please check the card’s length against the case’s GPU clearance before buying.";
      recordCheck("clearance", "unverified", [gpu.key, pcCase.key], msg);
    }
  }

  if (cooler && pcCase) {
    const height = trustedNumber(cooler, "height_mm", issues);
    const maxHeight = trustedNumber(pcCase, "max_cooler_height_mm", issues);
    if (height !== undefined && maxHeight !== undefined) {
      if (height <= maxHeight) {
        recordCheck(
          "clearance",
          "passed",
          [cooler.key, pcCase.key],
          `Cooler height fits: ${height}mm cooler / ${maxHeight}mm case clearance.`
        );
        confidenceGate("clearance", [cooler, pcCase], issues, `Cooler clearance pass uses low-confidence researched specs for ${lowNames([cooler, pcCase])}.`);
      } else {
        const msg = `Cooler height ${height}mm exceeds case clearance ${maxHeight}mm.`;
        recordCheck("clearance", "failed", [cooler.key, pcCase.key], msg);
      }
    } else {
      const msg = "Cooler height fit couldn’t be verified against case clearance.";
      recordCheck("clearance", "unverified", [cooler.key, pcCase.key], msg);
    }
  }

  if (motherboard && pcCase) {
    const formFactor = typeof motherboard.spec.form_factor === "string" ? motherboard.spec.form_factor : undefined;
    const supported = Array.isArray(pcCase.spec.form_factors) ? pcCase.spec.form_factors : undefined;
    const trustedBoard = !isUntrusted(motherboard);
    const trustedCase = !isUntrusted(pcCase);
    if (isUntrusted(motherboard)) untrusted(motherboard, issues);
    if (isUntrusted(pcCase)) untrusted(pcCase, issues);

    if (formFactor && supported && trustedBoard && trustedCase) {
      if (supported.map(canonicalize).includes(canonicalize(formFactor))) {
        recordCheck(
          "clearance",
          "passed",
          [motherboard.key, pcCase.key],
          `Motherboard form factor ${formFactor} fits case.`
        );
        confidenceGate("clearance", [motherboard, pcCase], issues, `Form-factor pass uses low-confidence researched specs for ${lowNames([motherboard, pcCase])}.`);
      } else {
        const msg = `Motherboard ${formFactor} is not supported by the case.`;
        recordCheck("clearance", "failed", [motherboard.key, pcCase.key], msg);
      }
    } else {
      const msg = "Motherboard form factor fit couldn’t be verified against case.";
      recordCheck("clearance", "unverified", [motherboard.key, pcCase.key], msg);
    }
  }
}

function checkCooler(
  cpu: ResolvedSpec | undefined,
  cooler: ResolvedSpec | undefined,
  recordCheck: CheckRecorder,
  issues: BuildIssue[]
) {
  if (!cpu || !cooler) return;

  const cpuTdp = numberSpec(cpu, "tdp_w", issues);
  const rating = numberSpec(cooler, "tdp_rating_w", issues);
  const socket = stringSpec(cpu, "socket", issues);
  const sockets = arraySpec(cooler, "sockets", issues);
  if (cpuTdp === undefined || rating === undefined || !socket || !sockets) {
    recordCheck(
      "cooler",
      "unverified",
      [cpu.key, cooler.key],
      "Cooler compatibility couldn't be verified due to missing specs."
    );
    return;
  }
  if (rating < cpuTdp) {
    const msg = isStockCooler(cooler)
      ? `Stock cooler rating (${rating}W) is below CPU ${cpuTdp}W TDP.`
      : `Cooler ${rating}W rating is below CPU ${cpuTdp}W TDP.`;
    recordCheck("cooler", "failed", [cpu.key, cooler.key], msg);
    return;
  }
  if (!sockets.map(canonicalize).includes(canonicalize(socket))) {
    const msg = `Cooler does not list a ${socket} mounting bracket.`;
    recordCheck("cooler", "failed", [cpu.key, cooler.key], msg);
    return;
  }
  const msg = isStockCooler(cooler)
    ? `Stock cooler is suitable for ${cpu.key} (${cpuTdp}W TDP).`
    : `Cooler rating (${rating}W) and socket (${socket}) match CPU (${cpuTdp}W).`;
  recordCheck("cooler", "passed", [cpu.key, cooler.key], msg);
  confidenceGate("cooler", [cpu, cooler], issues, `Cooler pass uses low-confidence researched specs for ${lowNames([cpu, cooler])}.`);
}

function checkStorage(
  motherboard: ResolvedSpec | undefined,
  drives: ResolvedSpec[],
  recordCheck: CheckRecorder,
  issues: BuildIssue[]
) {
  if (!motherboard || drives.length === 0) return;
  const interfaces = drives.map((drive) => ({ drive, value: stringSpec(drive, "interface", issues) }));
  if (interfaces.some(({ value }) => value === undefined)) {
    recordCheck(
      "storage",
      "unverified",
      [motherboard.key, ...drives.map((d) => d.key)],
      "Storage compatibility couldn't be verified due to missing drive interface specs."
    );
    return;
  }
  const nvmeCount = interfaces.filter(({ value }) => canonicalize(value) === "nvme").length;
  const sataCount = interfaces.filter(({ value }) => canonicalize(value) === "sata").length;
  const m2Slots = nvmeCount > 0 ? numberSpec(motherboard, "m2_slots", issues) : undefined;
  const sataPorts = sataCount > 0 ? numberSpec(motherboard, "sata_ports", issues) : undefined;
  if ((nvmeCount > 0 && m2Slots === undefined) || (sataCount > 0 && sataPorts === undefined)) {
    recordCheck(
      "storage",
      "unverified",
      [motherboard.key, ...drives.map((d) => d.key)],
      "Storage compatibility couldn't be verified due to missing motherboard slot/port specs."
    );
    return;
  }
  if (nvmeCount > (m2Slots ?? 0)) {
    const msg = `${nvmeCount} NVMe drives require ${nvmeCount} M.2 slots; motherboard has ${m2Slots}.`;
    recordCheck("storage", "failed", [motherboard.key, ...drives.map((drive) => drive.key)], msg);
    return;
  }
  if (sataCount > 0 && sataPorts !== undefined) {
    if (sataCount > sataPorts) {
      const msg = `${sataCount} SATA drives require ${sataCount} SATA ports; motherboard has ${sataPorts}.`;
      recordCheck("storage", "failed", [motherboard.key, ...drives.map((drive) => drive.key)], msg);
      return;
    }
  }
  recordCheck(
    "storage",
    "passed",
    [motherboard.key, ...drives.map((d) => d.key)],
    `Motherboard supports installed storage drives (${nvmeCount} NVMe, ${sataCount} SATA).`
  );
  confidenceGate("storage", [motherboard, ...drives], issues, `Storage pass uses low-confidence researched specs for ${lowNames([motherboard, ...drives])}.`);
}

function stringSpec(component: ResolvedSpec, key: string, issues: BuildIssue[]) {
  if (untrusted(component, issues)) return undefined;
  const value = component.spec[key];
  if (typeof value === "string" && value.length > 0) return value;
  issues.push(needsResearch([component.key], `${component.key} is missing required spec "${key}".`));
  return undefined;
}

function numberSpec(component: ResolvedSpec, key: string, issues: BuildIssue[]) {
  if (untrusted(component, issues)) return undefined;
  if (key === "wattage") {
    const w = component.spec.wattage;
    const wLegacy = component.spec.wattage_w;
    if (
      hasWattageConflict(component.spec)
    ) {
      issues.push({
        severity: "needs_verification",
        rule: "wattage",
        components: [component.key],
        detail: `Conflicting wattage specifications for ${component.key}: wattage (${w}W) and wattage_w (${wLegacy}W) disagree.`
      });
      return undefined;
    }
    const resolvedWattage = w ?? wLegacy;
    if (typeof resolvedWattage === "number") return resolvedWattage;
    if (typeof resolvedWattage === "string" && !Number.isNaN(Number(resolvedWattage))) {
      return Number(resolvedWattage);
    }
  }
  const value = component.spec[key];
  if (typeof value === "number") return value;
  issues.push(needsResearch([component.key], `${component.key} is missing required spec "${key}".`));
  return undefined;
}

function arraySpec(component: ResolvedSpec, key: string, issues: BuildIssue[]) {
  if (untrusted(component, issues)) return undefined;
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
  return typeof part === "string" ? part : part.product_id ?? part.key ?? part.name ?? "unknown component";
}

export function makeResolved(key: string, category: ComponentCategory, spec: RegistrySpec, confidence: Confidence = "high", source: "registry" | "research" = "registry"): ResolvedSpec {
  return { key, category, spec, confidence, source };
}

export function isSingleModuleRam(ram: ResolvedSpec): boolean {
  const norm = [ram.key, ram.spec.model, ...(ram.spec.aliases || [])].join(" ");
  if (/\b\d+\s*x\s*\d+\s*gb\b/i.test(norm) && !/\b1\s*x\s*\d+\s*gb\b/i.test(norm)) {
    return false;
  }
  if (/\b(2x8gb|2x16gb|2x32gb|2x4gb|4x8gb|4x16gb|kit of 2|kit of 4|dual channel|dual-channel)\b/i.test(norm)) {
    return false;
  }
  if (/\b(1\s*x\s*\d+\s*gb|\d+\s*gb\s*x\s*1|single stick|single channel)\b/i.test(norm)) {
    return true;
  }
  return false;
}

export function isStockCooler(cooler: ResolvedSpec): boolean {
  if (
    cooler.key === "included-stock-cooler" ||
    cooler.key === "amd-wraith-stealth" ||
    cooler.key === "amd-wraith-prism" ||
    cooler.key === "intel-laminar-rm1" ||
    cooler.key === "stock-cooler" ||
    cooler.key === "included"
  ) {
    return true;
  }
  const norm = [cooler.key, cooler.spec.model, ...(cooler.spec.aliases || [])].join(" ").toLowerCase();
  return (
    norm.includes("wraith stealth") ||
    norm.includes("wraith prism") ||
    norm.includes("laminar rm1") ||
    norm.includes("stock cooler") ||
    norm.includes("intel laminar")
  );
}

function isMarkedIncluded(part: BuildPart): boolean {
  if (!part) return false;
  if (typeof part === "string") {
    const p = part.toLowerCase().trim();
    return p === "included" || p === "stock" || p === "stock cooler" || p === "stock-cooler";
  }
  const k = (part.key ?? "").toLowerCase().trim();
  const n = (part.name ?? "").toLowerCase().trim();
  return (
    k === "included" || k === "stock" || k === "stock cooler" || k === "stock-cooler" ||
    n === "included" || n === "stock" || n === "stock cooler" || n === "stock-cooler"
  );
}
