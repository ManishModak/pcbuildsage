/**
 * src/lib/rules/shared.ts
 *
 * Trust gating and typed spec accessors shared by the compatibility rule
 * modules. Every accessor refuses unsourced registry placeholder specs so a
 * rule computes "unverified" instead of a confident wrong answer.
 */
import { hasWattageConflict, type ResolvedSpec } from "../registry";
import type { BuildIssue, BuildPart, RuleName } from "../rules-engine";

export type CheckRecorder = (
  rule: RuleName,
  status: "passed" | "failed" | "unverified",
  components: string[],
  message: string
) => void;

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
export function untrusted(component: ResolvedSpec, issues: BuildIssue[]): boolean {
  if (component.key === "included-stock-cooler") return false;
  if (component.source !== "registry" || component.confidence !== "low") return false;
  issues.push(
    needsResearch(
      [component.key],
      `${component.key} has unsourced placeholder specs in the registry. Research it with consult before any compatibility verdict is given.`
    )
  );
  return true;
}

export function lowNames(components: Array<ResolvedSpec | undefined>) {
  return components.filter((component): component is ResolvedSpec => component?.confidence === "low").map((component) => component.key).join(", ");
}

export function needsResearch(components: string[], detail: string): BuildIssue {
  return { severity: "needs_research", rule: "spec_resolution", components, detail };
}

export function confidenceGate(rule: RuleName, components: ResolvedSpec[], issues: BuildIssue[], detail: string) {
  if (components.some((component) => component.confidence === "low")) {
    issues.push({ severity: "needs_verification", rule, components: components.map((component) => component.key), detail });
  }
}

export function stringSpec(component: ResolvedSpec, key: string, issues: BuildIssue[]) {
  if (untrusted(component, issues)) return undefined;
  const value = component.spec[key];
  if (typeof value === "string" && value.length > 0) return value;
  issues.push(needsResearch([component.key], `${component.key} is missing required spec "${key}".`));
  return undefined;
}

export function numberSpec(component: ResolvedSpec, key: string, issues: BuildIssue[]) {
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

export function arraySpec(component: ResolvedSpec, key: string, issues: BuildIssue[]) {
  if (untrusted(component, issues)) return undefined;
  const value = component.spec[key];
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
  issues.push(needsResearch([component.key], `${component.key} is missing required spec "${key}".`));
  return undefined;
}

export function trustedNumber(component: ResolvedSpec, key: string, issues: BuildIssue[]): number | undefined {
  if (untrusted(component, issues)) return undefined;
  const val = component.spec[key];
  return typeof val === "number" ? val : undefined;
}

export function label(part: BuildPart): string {
  return typeof part === "string" ? part : part.product_id ?? part.key ?? part.name ?? "unknown component";
}

export function isSingleModuleRam(ram: ResolvedSpec): boolean {
  if (typeof ram.spec.modules === "number") {
    if (ram.spec.modules === 1) return true;
    if (ram.spec.modules > 1) return false;
  }
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
