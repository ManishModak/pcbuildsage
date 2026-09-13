import type { ValidationResult } from "@/types/client";

export type StripBadge = {
  kind: "ok" | "blocking" | "warn" | "unverified";
  label: string;
  title: string;
};

export function ruleLabel(rule: string): string {
  const map: Record<string, string> = {
    socket: "Socket",
    ddr: "Memory",
    wattage: "Wattage",
    clearance: "Clearance",
    cooler: "Cooler",
    storage: "Storage",
    display_output: "Display Out",
    spec_resolution: "Specs"
  };
  return map[rule] ?? rule;
}

export function computeValidationStats(
  validation: ValidationResult
): { passed: number; unverified: number; failed: number } {
  const blocking = validation.issues.filter((issue) => issue.severity === "blocking");
  const research = validation.issues.filter((issue) => issue.severity === "needs_research");
  const verify = validation.issues.filter((issue) => issue.severity === "needs_verification");

  if (validation.summary) {
    return {
      passed: validation.summary.passed,
      unverified: validation.summary.unverified,
      failed: validation.summary.failed
    };
  }

  if (Array.isArray(validation.checks) && validation.checks.length > 0) {
    const passed = validation.checks.filter((c) => c.status === "passed").length;
    const unverified = validation.checks.filter((c) => c.status === "unverified").length;
    const failed = validation.checks.filter((c) => c.status === "failed").length;
    return { passed, unverified, failed };
  }

  const TOTAL_RULES = ["socket", "ddr", "wattage", "clearance", "cooler", "storage", "display_output"] as const;
  const skippedRules = new Set((validation.skipped_checks ?? []).map((s) => s.rule));
  const blockingRules = new Set(blocking.map((i) => i.rule));
  const unverifiedRules = new Set([...verify, ...research].map((i) => i.rule));
  const evaluatedRules = TOTAL_RULES.filter((r) => !skippedRules.has(r));
  const passedRules = evaluatedRules.filter((r) => !blockingRules.has(r) && !unverifiedRules.has(r));

  return {
    passed: passedRules.length,
    unverified: unverifiedRules.size,
    failed: blockingRules.size
  };
}

/** Build the validation strip from a ValidationResult. */
export function validationStrip(validation: ValidationResult | null): StripBadge[] {
  if (!validation) {
    return [
      {
        kind: "unverified",
        label: "Unverified",
        title: "Build compatibility has not been verified."
      }
    ];
  }
  if (!Array.isArray(validation.issues)) return [];
  const badges: StripBadge[] = [];
  const blocking = validation.issues.filter((issue) => issue.severity === "blocking");
  const verify = validation.issues.filter((issue) => issue.severity === "needs_verification");
  const advisories = validation.issues.filter((issue) => issue.severity === "advisory");

  const stats = computeValidationStats(validation);

  if (stats.failed > 0) {
    const parts: string[] = [
      `${stats.failed} ${stats.failed === 1 ? "check" : "checks"} failed`,
      `${stats.passed} passed`
    ];
    if (stats.unverified > 0) {
      parts.push(`${stats.unverified} unverified`);
    }
    badges.push({
      kind: "blocking",
      label: parts.join(" · "),
      title: `${stats.failed} ${stats.failed === 1 ? "check failed" : "checks failed"}, ${stats.passed} passed${stats.unverified > 0 ? `, ${stats.unverified} unverified` : ""}.`
    });
  } else if (stats.unverified > 0) {
    badges.push({
      kind: "unverified",
      label: `${stats.passed} checks passed · ${stats.unverified} unverified`,
      title: `${stats.passed} checks passed, ${stats.unverified} ${stats.unverified === 1 ? "check relies" : "checks rely"} on unverified or researched specifications.`
    });
  } else if (validation.valid && blocking.length === 0) {
    badges.push({
      kind: "ok",
      label: stats.passed > 0 ? `${stats.passed} checks passed` : "Compatible",
      title: "Rules engine passed all compatibility checks."
    });
  }

  for (const issue of blocking) {
    badges.push({ kind: "blocking", label: ruleLabel(issue.rule), title: issue.detail });
  }
  for (const issue of verify) {
    badges.push({ kind: "unverified", label: `${ruleLabel(issue.rule)} unverified`, title: issue.detail });
  }
  for (const issue of advisories) {
    badges.push({ kind: "warn", label: `${ruleLabel(issue.rule)} advisory`, title: issue.detail });
  }
  return badges;
}
