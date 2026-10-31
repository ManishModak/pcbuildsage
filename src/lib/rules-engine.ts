import { hasWattageConflict, resolveComponent, type ComponentCategory, type Confidence, type RegistrySpec, type ResolvedSpec } from "./registry";
import { canonicalizeSocket } from "./spec-canonical";
import { checkClearance, checkCooler } from "./rules/clearance";
import { checkCpuSupport } from "./rules/cpu-support";
import { checkDdr } from "./rules/ddr";
import { checkStorage } from "./rules/storage";
import {
  confidenceGate,
  label,
  lowNames,
  needsResearch,
  numberSpec,
  stringSpec,
  untrusted,
  type CheckRecorder,
} from "./rules/shared";

export type { CheckRecorder };
export { isSingleModuleRam, isStockCooler } from "./rules/shared";

export type RuleCheckStatus = "passed" | "failed" | "unverified";
export type CheckStatus = RuleCheckStatus;
export type RuleName = "socket" | "cpu_support" | "ddr" | "wattage" | "clearance" | "cooler" | "storage" | "display_output" | "spec_resolution";
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
  { rule: "cpu_support", needs: ["cpu", "motherboard"] },
  { rule: "ddr", needs: ["motherboard", "ram"] },
  { rule: "wattage", needs: ["cpu", "psu"] },
  { rule: "cooler", needs: ["cpu", "cooler"] },
  { rule: "clearance", needs: ["case"] },
  { rule: "storage", needs: ["motherboard", "storage"] },
  { rule: "display_output", needs: ["cpu"] }
];

export type Resolver = (part: BuildPart, category: ComponentCategory) => ResolvedSpec | undefined;
export type UnresolvedMessageGetter = (part: BuildPart, category: ComponentCategory) => string | undefined;

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
      aliases: ["Stock Cooler", "included"],
      cooler_type: "air"
    },
    confidence: "low",
    source: "registry"
  };
}

export function validateBuild(
  parts: BuildParts,
  options: { resolve?: Resolver; getUnresolvedMessage?: UnresolvedMessageGetter } = {}
): ValidationResult {
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
      const customMsg = options.getUnresolvedMessage?.(part, category);
      recordCheckLocal(
        "spec_resolution",
        "unverified",
        [label(part)],
        customMsg ?? `No ${category} specs found in registry or research cache.`
      );
      return undefined;
    }
    if (typeof spec.spec.spec_conflict === "string") {
      recordCheckLocal("spec_resolution", "unverified", [spec.key], spec.spec.spec_conflict);
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
        const customMsg = options.getUnresolvedMessage?.(part, category);
        recordCheckLocal(
          "spec_resolution",
          "unverified",
          [label(part)],
          customMsg ?? `No ${category} specs found in registry or research cache.`
        );
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

  checkSocket(cpu, motherboard, recordCheckLocal, extraIssues, parts);
  checkCpuSupport(cpu, motherboard, recordCheckLocal, extraIssues);
  checkDdr(cpu, motherboard, ram, recordCheckLocal, extraIssues, parts);
  const hasGpu = parts.gpu !== undefined && parts.gpu !== null;
  checkWattage(cpu, gpu, psu, hasGpu, recordCheckLocal, extraIssues);
  checkDisplayOutput(cpu, gpu, hasGpu, recordCheckLocal, extraIssues);
  checkClearance(gpu, pcCase, cooler, motherboard, psu, recordCheckLocal, extraIssues);
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

function checkSocket(
  cpu: ResolvedSpec | undefined,
  motherboard: ResolvedSpec | undefined,
  recordCheck: CheckRecorder,
  issues: BuildIssue[],
  parts?: BuildParts
) {
  if (!motherboard) return;
  const boardSocket = stringSpec(motherboard, "socket", issues);
  if (!boardSocket) {
    recordCheck(
      "socket",
      "unverified",
      [motherboard.key, ...(cpu ? [cpu.key] : [])],
      "Socket compatibility couldn't be verified due to missing socket specs."
    );
    return;
  }
  if (!cpu) {
    if (parts?.cpu) {
      recordCheck(
        "socket",
        "unverified",
        [label(parts.cpu as BuildPart), motherboard.key],
        "CPU compatibility could not be verified from the available data. Check the motherboard’s CPU support list."
      );
    }
    return;
  }
  const cpuSocket = stringSpec(cpu, "socket", issues);
  if (!cpuSocket) {
    recordCheck(
      "socket",
      "unverified",
      [cpu.key, motherboard.key],
      "CPU compatibility could not be verified from the available data. Check the motherboard’s CPU support list."
    );
    return;
  }
  if (canonicalizeSocket(cpuSocket) !== canonicalizeSocket(boardSocket)) {
    const msg = `CPU socket ${cpuSocket} does not match motherboard socket ${boardSocket}.`;
    recordCheck("socket", "failed", [cpu.key, motherboard.key], msg);
  } else {
    recordCheck("socket", "passed", [cpu.key, motherboard.key], `CPU socket ${cpuSocket} matches motherboard socket ${boardSocket}.`);
    confidenceGate("socket", [cpu, motherboard], issues, `Socket match uses low-confidence researched specs for ${lowNames([cpu, motherboard])}.`);
  }
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
  const cpuPower = cpuPowerW(cpu, issues);
  const gpuTdp = hasGpu ? (gpu ? numberSpec(gpu, "tdp_w", issues) : undefined) : 0;
  const wattage = numberSpec(psu, "wattage", issues);
  const components = [cpu, gpu, psu].filter((component): component is ResolvedSpec => Boolean(component));
  if (cpuPower === undefined || gpuTdp === undefined || wattage === undefined) {
    recordCheck(
      "wattage",
      "unverified",
      components.map((c) => c.key),
      "Wattage requirement couldn't be verified due to missing power specs."
    );
    return;
  }
  const required = Math.ceil((cpuPower + gpuTdp + 50) * 1.2);
  if (required > wattage) {
    const msg = `Estimated ${required}W requirement exceeds PSU ${wattage}W.`;
    recordCheck("wattage", "failed", components.map((c) => c.key), msg);
    return;
  }
  const recPsu = gpu && typeof gpu.spec.recommended_psu_w === "number" && Number.isFinite(gpu.spec.recommended_psu_w) && gpu.spec.recommended_psu_w > 0
    ? gpu.spec.recommended_psu_w
    : undefined;
  // A GPU maker's recommended PSU assumes a worst-case system and an unknown
  // PSU, so it overshoots typical budget builds (RTX 4060: 550W recommended vs
  // ~276W estimated with a Ryzen 5 5600). Only a PSU far below it (under 80%)
  // blocks; one that covers the estimate but misses the recommendation gets an
  // advisory naming the recommendation, not a false block.
  const gpuName = gpu ? gpu.spec.model || gpu.key : "the GPU";
  if (recPsu !== undefined && wattage < recPsu * 0.8) {
    const msg = `PSU wattage (${wattage}W) is well below the GPU manufacturer recommendation (${recPsu}W) for ${gpuName}.`;
    recordCheck("wattage", "failed", components.map((c) => c.key), msg);
    return;
  }
  const belowRec = recPsu !== undefined && wattage < recPsu;
  if (belowRec) {
    issues.push({
      severity: "advisory",
      rule: "wattage",
      components: components.map((c) => c.key),
      detail: `PSU wattage (${wattage}W) covers the estimated ${required}W but is below the GPU maker's ${recPsu}W recommendation for ${gpuName}. It should run this build; a ${recPsu}W unit adds headroom for power spikes.`
    });
  }
  const message = recPsu !== undefined && !belowRec
    ? `PSU wattage (${wattage}W) covers estimated requirement (${required}W) and meets manufacturer recommendation (${recPsu}W).`
    : `PSU wattage (${wattage}W) covers estimated requirement (${required}W).`;
  recordCheck("wattage", "passed", components.map((c) => c.key), message);
  confidenceGate("wattage", components, issues, `Wattage pass uses low-confidence researched specs for ${lowNames(components)}.`);
}

/**
 * Realistic sustained CPU power for PSU sizing: base TDP understates unlocked
 * desktop chips under load (14900K: 125W base, 253W Maximum Turbo Power per
 * Intel ARK). Curated max_power_w (Intel Maximum Turbo Power / AMD socket PPT)
 * wins when present; otherwise base TDP.
 */
function cpuPowerW(cpu: ResolvedSpec, issues: BuildIssue[]): number | undefined {
  const base = numberSpec(cpu, "tdp_w", issues);
  if (base === undefined) return undefined;
  const max = cpu.spec.max_power_w;
  if (typeof max === "number" && Number.isFinite(max) && max > 0) return Math.max(max, base);
  return base;
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

export function makeResolved(key: string, category: ComponentCategory, spec: RegistrySpec, confidence: Confidence = "high", source: "registry" | "research" = "registry"): ResolvedSpec {
  return { key, category, spec, confidence, source };
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
