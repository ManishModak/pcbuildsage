import type { BuildIssue, ProductRow, ValidationResult } from "@/types/client";
import type { ToolPart } from "./tool-chip";

export const CATEGORY_LABELS: Record<string, string> = {
  cpu: "CPU",
  gpu: "GPU",
  motherboard: "Motherboard",
  ram: "Memory",
  storage: "Storage",
  psu: "Power Supply",
  case: "Case",
  cooler: "Cooler"
};

const CATEGORY_ORDER = ["gpu", "cpu", "motherboard", "ram", "storage", "psu", "case", "cooler"];

export type BuildComponent = {
  category: string;
  categoryLabel: string;
  name: string;
  registryKey?: string;
  price: number | null;
  currency: string;
  retailer?: string;
  url?: string;
  unverified: boolean;
  unverifiedNote?: string;
};

export type DerivedBuild = {
  /** Model-supplied name for the tradeoff this build makes, when it proposed several. */
  label?: string;
  components: BuildComponent[];
  currency: string;
  validation: ValidationResult | null;
};

function partLabel(part: unknown): { key?: string; name: string } {
  if (typeof part === "string") return { key: part, name: part };
  if (part && typeof part === "object") {
    const value = part as { key?: string; name?: string };
    return { key: value.key, name: value.name ?? value.key ?? "unknown" };
  }
  return { name: "unknown" };
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Best-effort reconstruction of a proposed build from a message's tool activity:
 * validate_build supplies the parts + compatibility verdict, search_products
 * supplies price / retailer / link for each part where a match is found.
 */
export function deriveBuild(parts: ToolPart[], fallbackCurrency: string): DerivedBuild | null {
  const validatePart = [...parts]
    .reverse()
    .find((part) => part.type === "tool-validate_build" && part.state === "output-available");
  if (!validatePart) return null;

  const input = validatePart.input as { parts?: Record<string, unknown>; label?: string } | undefined;
  if (!input?.parts) return null;
  const validation = (validatePart.output as ValidationResult | undefined) ?? null;
  const label = typeof input.label === "string" && input.label.trim() ? input.label.trim() : undefined;

  // Index every product row seen in this message for price/retailer lookup.
  const products: ProductRow[] = [];
  for (const part of parts) {
    if (part.type === "tool-search_products" && part.state === "output-available") {
      const output = part.output as { results?: ProductRow[] } | undefined;
      if (Array.isArray(output?.results)) products.push(...output!.results);
    }
  }
  const byKey = new Map<string, ProductRow>();
  const byName = products.map((product) => ({ product, norm: normalize(product.name) }));
  for (const product of products) {
    if (product.registry_key) byKey.set(product.registry_key, product);
  }

  const findProduct = (label: { key?: string; name: string }): ProductRow | undefined => {
    if (label.key && byKey.has(label.key)) return byKey.get(label.key);
    const target = normalize(label.name);
    return byName.find(({ norm }) => norm.includes(target) || target.includes(norm))?.product;
  };

  const currency = products[0]?.currency ?? fallbackCurrency;

  const entries = Object.entries(input.parts).flatMap(([category, raw]) => {
    const items = Array.isArray(raw) ? raw : [raw];
    return items.map((item) => ({ category, label: partLabel(item) }));
  });

  const components: BuildComponent[] = entries.map(({ category, label }) => {
    const product = findProduct(label);
    const note = componentNote(validation?.issues ?? [], label.key ?? label.name, label.name);
    return {
      category,
      categoryLabel: CATEGORY_LABELS[category] ?? category,
      name: product?.name ?? label.name,
      registryKey: label.key,
      price: product?.price ?? null,
      currency: product?.currency ?? currency,
      retailer: product?.retailer,
      url: product?.url,
      unverified: Boolean(note),
      unverifiedNote: note
    };
  });

  components.sort(
    (a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category)
  );

  return { label, components, currency, validation };
}

/**
 * Derive every distinct build proposed in a message (deduped by part set,
 * latest verdict wins). Multiple distinct builds render as labelled pill tabs.
 */
export function deriveBuilds(parts: ToolPart[], fallbackCurrency: string): DerivedBuild[] {
  const validateParts = parts.filter(
    (part) => part.type === "tool-validate_build" && part.state === "output-available"
  );
  const bySignature = new Map<string, ToolPart>();
  for (const part of validateParts) {
    const input = part.input as { parts?: Record<string, unknown> } | undefined;
    if (!input?.parts || Object.keys(input.parts).length === 0) continue;
    bySignature.set(partsSignature(input.parts), part);
  }
  const builds: DerivedBuild[] = [];
  for (const part of bySignature.values()) {
    const build = deriveBuild([...parts.filter((p) => p.type === "tool-search_products"), part], fallbackCurrency);
    if (build) builds.push(build);
  }
  return builds;
}

/** Stable, key-order-insensitive signature for a validate_build parts map. */
function partsSignature(parts: Record<string, unknown>): string {
  return JSON.stringify(
    Object.entries(parts)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([category, value]) => [category, JSON.stringify(value)])
  );
}

function componentNote(issues: BuildIssue[], key: string, name: string): string | undefined {
  const relevant = issues.find(
    (issue) =>
      (issue.severity === "needs_verification" || issue.severity === "needs_research") &&
      issue.components.some((component) => component === key || normalize(component) === normalize(name))
  );
  if (!relevant) return undefined;
  return relevant.severity === "needs_research"
    ? "specs not found in registry — researched, not community-verified"
    : "specs researched from the web, not yet community-verified";
}

export type StripBadge = { kind: "ok" | "blocking" | "warn" | "unverified"; label: string; title: string };

/** Build the validation strip from a ValidationResult. */
export function validationStrip(validation: ValidationResult | null): StripBadge[] {
  if (!validation) return [];
  const badges: StripBadge[] = [];
  const blocking = validation.issues.filter((issue) => issue.severity === "blocking");
  const research = validation.issues.filter((issue) => issue.severity === "needs_research");
  const verify = validation.issues.filter((issue) => issue.severity === "needs_verification");

  if (validation.valid && blocking.length === 0 && research.length === 0) {
    badges.push({ kind: "ok", label: "Compatible", title: "Rules engine passed all Tier 1 checks." });
  }
  for (const issue of blocking) {
    badges.push({ kind: "blocking", label: ruleLabel(issue.rule), title: issue.detail });
  }
  for (const issue of research) {
    badges.push({ kind: "warn", label: `${ruleLabel(issue.rule)} needs research`, title: issue.detail });
  }
  for (const issue of verify) {
    badges.push({ kind: "unverified", label: `${ruleLabel(issue.rule)} unverified`, title: issue.detail });
  }
  return badges;
}

function ruleLabel(rule: string): string {
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
