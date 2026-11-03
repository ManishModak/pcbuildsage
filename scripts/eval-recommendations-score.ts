/**
 * scripts/eval-recommendations-score.ts
 *
 * Code-only scoring for the recommendation eval (scripts/eval-recommendations.ts).
 * Each build the model presented is checked against the catalog and the case's
 * rules; a case passes when any presented build passes every hard check. No LLM
 * judge: everything here reads the validated snapshot and catalog rows.
 */

import type { AskTurn, PresentedBuild } from "../src/cli/ask-turn";
import { parseSpecsFromTitle } from "../src/lib/spec-parsers";

/** One buyer prompt from evals/recommendations/cases.json. */
export type EvalCase = {
  id: string;
  prompt: string;
  budget: number;
  /** required: a GPU must be in the build; none: it must not; optional: either. */
  gpu: "required" | "optional" | "none";
  checks?: {
    /** Every part of the category must match the regex (case-insensitive). */
    nameMatches?: Record<string, string>;
    /** No part name may match the regex (case-insensitive). */
    nameExcludes?: string;
    /** Total RAM across all RAM parts, from the listing titles. */
    minRamGb?: number;
  };
};

/** The catalog fields the scorer needs for one product id. */
export type CatalogRow = { id: string; category: string; name: string; in_stock: boolean };
export type CatalogLookup = (id: string) => CatalogRow | undefined;

export type BuildScore = {
  label: string;
  passed: boolean;
  /** Hard-check failures, one line each. */
  failures: string[];
  /** Reported only: low budget use and unverified specs. */
  warnings: string[];
  total: number | null;
  budgetUsedPct: number | null;
  unverified: number;
  parts: Array<{ category: string; name: string; product_id?: string; price: number | null }>;
};

export type CaseScore = {
  id: string;
  budget: number;
  passed: boolean;
  /** Why no build could pass (no build presented, timeout, provider error); fixed wording, safe to publish. */
  turnFailures: string[];
  builds: BuildScore[];
  steps: number;
  wallMs: number;
};

export const CORE_CATEGORIES = ["cpu", "motherboard", "ram", "storage", "psu", "case"] as const;
const LOW_BUDGET_USE_PCT = 70;

/** Scores one presented build against the case's hard checks. */
export function scoreBuild(build: PresentedBuild, evalCase: EvalCase, lookup: CatalogLookup): BuildScore {
  const snap = build.snapshot;
  const failures: string[] = [];
  const warnings: string[] = [];
  if (!snap) {
    return { label: build.label, passed: false, failures: ["no validated snapshot for this build"], warnings, total: null, budgetUsedPct: null, unverified: 0, parts: [] };
  }

  // Names come from catalog rows only: a part the catalog doesn't know keeps
  // the model's own text, which must not reach the published scorecard.
  const components = snap.components.map((c) => {
    if (c.included) return { category: c.category, name: "stock cooler" }; // ships with the CPU
    const row = c.product_id ? lookup(c.product_id) : undefined;
    if (!row) failures.push(`${c.category} is not a catalog product`);
    else if (row.category !== c.category) failures.push(`${c.category} "${row.name}" is a ${row.category} in the catalog`);
    else if (!row.in_stock) failures.push(`${c.category} "${row.name}" is out of stock`);
    return { category: c.category, name: row?.name ?? "unknown part" };
  });

  const has = (category: string) => components.some((c) => c.category === category);
  const missing = CORE_CATEGORIES.filter((category) => !has(category));
  if (missing.length > 0) failures.push(`missing core parts: ${missing.join(", ")}`);
  if (evalCase.gpu === "required" && !has("gpu")) failures.push("GPU required but none in the build");
  if (evalCase.gpu === "none" && has("gpu")) failures.push("GPU excluded but the build has one");

  const summary = snap.validation_summary;
  if (!snap.valid) failures.push("snapshot is not valid");
  if (!summary) failures.push("snapshot has no validation summary");
  else if (summary.failed > 0) failures.push(`${summary.failed} compatibility check(s) failed`);

  const total = snap.total;
  const budgetUsedPct = total == null ? null : Math.round((total / evalCase.budget) * 1000) / 10;
  if (total == null) failures.push("build has no complete total");
  else if (total > evalCase.budget) failures.push(`total ${total} is over the ${evalCase.budget} budget`);
  else if (budgetUsedPct != null && budgetUsedPct < LOW_BUDGET_USE_PCT) warnings.push(`uses only ${budgetUsedPct}% of the budget`);

  failures.push(...caseCheckFailures(components, evalCase));

  const unverified = summary?.unverified ?? 0;
  if (unverified > 0) warnings.push(`${unverified} unverified spec check(s)`);

  return {
    label: build.label,
    passed: failures.length === 0,
    failures,
    warnings,
    total,
    budgetUsedPct,
    unverified,
    parts: snap.components.map((c) => ({ category: c.category, name: c.name, ...(c.product_id ? { product_id: c.product_id } : {}), price: c.price }))
  };
}

function caseCheckFailures(components: Array<{ category: string; name: string }>, evalCase: EvalCase): string[] {
  const checks = evalCase.checks;
  if (!checks) return [];
  const failures: string[] = [];
  for (const [category, pattern] of Object.entries(checks.nameMatches ?? {})) {
    const re = new RegExp(pattern, "i");
    const parts = components.filter((c) => c.category === category);
    if (parts.length === 0) failures.push(`no ${category} to match /${pattern}/`);
    for (const part of parts) {
      if (!re.test(part.name)) failures.push(`${category} "${part.name}" does not match /${pattern}/`);
    }
  }
  if (checks.nameExcludes) {
    const re = new RegExp(checks.nameExcludes, "i");
    for (const part of components) {
      if (re.test(part.name)) failures.push(`${part.category} "${part.name}" matches excluded /${checks.nameExcludes}/`);
    }
  }
  if (checks.minRamGb != null) {
    let ramGb = 0;
    for (const part of components.filter((c) => c.category === "ram")) {
      const capacity = parseSpecsFromTitle(part.name, "ram")?.capacity_gb;
      if (typeof capacity === "number") ramGb += capacity;
    }
    if (ramGb < checks.minRamGb) failures.push(`RAM is ${ramGb} GB, below ${checks.minRamGb} GB`);
  }
  return failures;
}

/**
 * Scores a whole case: it passes when any presented build passes. The raw
 * stream error stays in the turn (results.json); the score only names its kind.
 */
export function scoreCase(evalCase: EvalCase, turn: AskTurn, lookup: CatalogLookup, wallMs: number, timedOut = false): CaseScore {
  const builds = turn.builds.map((build) => scoreBuild(build, evalCase, lookup));
  const turnFailures: string[] = [];
  if (builds.length === 0) turnFailures.push("no build presented");
  if (timedOut) turnFailures.push("timed out");
  else if (turn.streamError) turnFailures.push("provider error");
  return {
    id: evalCase.id,
    budget: evalCase.budget,
    passed: builds.some((b) => b.passed),
    turnFailures,
    builds,
    steps: turn.steps,
    wallMs
  };
}

/** The build a scorecard row shows: the first passing one, else the first presented. */
function headlineBuild(score: CaseScore): BuildScore | undefined {
  return score.builds.find((b) => b.passed) ?? score.builds[0];
}

/**
 * Markdown scorecard with scores only: no model text or build labels, so it
 * can be published under the provider's terms.
 */
export function formatScorecard(scores: CaseScore[], meta: { model: string; catalog: string; date: string }): string {
  const passed = scores.filter((s) => s.passed).length;
  const lines = [
    `# Recommendation eval: ${passed}/${scores.length} cases pass`,
    "",
    `Model \`${meta.model}\` · catalog ${meta.catalog} · ${meta.date}`,
    "",
    "| Case | Result | Builds passing | Total / budget | Unverified | Steps | Time | Why it failed / warnings |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |"
  ];
  for (const s of scores) {
    const b = headlineBuild(s);
    const passing = `${s.builds.filter((x) => x.passed).length}/${s.builds.length}`;
    const total = b?.total != null ? `${b.total.toLocaleString("en-IN")} / ${s.budget.toLocaleString("en-IN")} (${b.budgetUsedPct}%)` : "–";
    const notes = s.passed ? (b?.warnings ?? []) : [...s.turnFailures, ...(b?.failures ?? [])];
    lines.push(`| ${s.id} | ${s.passed ? "pass" : "**fail**"} | ${passing} | ${total} | ${b?.unverified ?? "–"} | ${s.steps} | ${Math.round(s.wallMs / 1000)}s | ${escapeCell(notes.join("; ")) || "–"} |`);
  }
  return `${lines.join("\n")}\n`;
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
