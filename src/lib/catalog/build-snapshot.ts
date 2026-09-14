import type { ComponentCategory, ResolvedSpec } from "../registry";
import type { BuildPart, BuildParts, ValidationResult } from "../rules-engine";
import { isStockCooler } from "../rules-engine";
import type { CatalogScope, SearchProductItem } from "./repository";
import { toPriceMinor, fromPriceMinor } from "@/types/catalog";

export interface BuildSnapshotComponent {
  category: ComponentCategory | string;
  product_id?: string;
  name: string;
  price: number | null;
  currency: string;
  retailer?: string;
  url?: string;
  observed_at?: string;
  included?: boolean;
}

export interface BuildSnapshotValidationSummary {
  passed: number;
  failed: number;
  unverified: number;
  skipped: number;
  issues: string[];
}

export interface BuildSnapshot {
  label?: string;
  components: BuildSnapshotComponent[];
  total: number | null;
  subtotal: number;
  currency: string;
  is_complete: boolean;
  component_count: number;
  unpriced_count: number;
  missing_prices: string[];
  currencies: string[];
  parts: BuildParts;
  valid: boolean;
  validation_summary?: BuildSnapshotValidationSummary;
  created_at: string;
}

export function isPartMarkedIncluded(part: BuildPart | undefined): boolean {
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

/**
 * Resolve an included stock cooler component if applicable (Q4 cleanup).
 */
export function resolveIncludedCooler(
  item: BuildPart,
  resolvedCooler: ResolvedSpec | undefined,
  catalogProduct: SearchProductItem | undefined,
  primaryCurrency: string
): BuildSnapshotComponent | null {
  if (catalogProduct) return null;
  const isMarked = isPartMarkedIncluded(item);
  const isStock = Boolean(resolvedCooler && isStockCooler(resolvedCooler));
  if (!isMarked && !isStock) return null;

  const coolerName =
    typeof item === "string"
      ? (item === "included" ? "Stock Cooler (Included with CPU)" : item)
      : (item.name || (resolvedCooler?.spec?.model ? String(resolvedCooler.spec.model) : "Stock Cooler (Included)"));

  return {
    category: "cooler",
    name: coolerName,
    price: 0,
    currency: primaryCurrency,
    included: true
  };
}

export const CATEGORY_ORDER: ComponentCategory[] = [
  "gpu",
  "cpu",
  "motherboard",
  "ram",
  "storage",
  "psu",
  "case",
  "cooler"
];

export function createBuildSnapshot({
  label,
  parts,
  validation,
  productsById,
  scope
}: {
  label?: string;
  parts: BuildParts;
  validation: ValidationResult;
  productsById: Map<string, SearchProductItem>;
  scope: CatalogScope;
}): BuildSnapshot {
  const components: BuildSnapshotComponent[] = [];
  const primaryCurrency = scope.currency || "USD";

  for (const category of CATEGORY_ORDER) {
    const raw = parts[category];
    if (!raw) continue;
    const items = Array.isArray(raw) ? raw : [raw];

    for (const item of items) {
      const productId = typeof item === "object" && item && item.product_id ? item.product_id.trim() : undefined;
      const catalogProduct = productId ? productsById.get(productId) : undefined;

      // Check for included cooler
      if (category === "cooler") {
        const resolvedCooler = validation.resolved.cooler as ResolvedSpec | undefined;
        const included = resolveIncludedCooler(item as BuildPart, resolvedCooler, catalogProduct, primaryCurrency);
        if (included) {
          components.push(included);
          continue;
        }
      }

      if (catalogProduct) {
        const observedAt =
          catalogProduct.last_scraped ||
          catalogProduct.first_seen ||
          catalogProduct.offers?.[0]?.observedAt;

        components.push({
          category,
          product_id: catalogProduct.id,
          name: catalogProduct.name,
          price: typeof catalogProduct.price === "number" ? catalogProduct.price : null,
          currency: catalogProduct.currency || primaryCurrency,
          retailer: catalogProduct.retailer,
          url: catalogProduct.url,
          observed_at: observedAt,
          included: false
        });
      } else {
        // Not found in catalog: missing price
        const fallbackName =
          typeof item === "string"
            ? item
            : (item.name || item.key || item.product_id || "Unresolved Part");

        components.push({
          category,
          product_id: productId,
          name: fallbackName,
          price: null,
          currency: primaryCurrency,
          included: false
        });
      }
    }
  }

  // Calculate currencies, unpriced items, and totals
  const pricedComponents = components.filter((c) => c.price !== null);
  const distinctCurrencies = Array.from(new Set(pricedComponents.map((c) => c.currency)));
  const unpricedComponents = components.filter((c) => c.price === null);
  const missingPrices = unpricedComponents.map((c) => `${c.category}: ${c.name}`);

  // Check for foreign currency components
  const foreignCurrencyItems = pricedComponents.filter((c) => c.currency !== primaryCurrency);
  for (const fc of foreignCurrencyItems) {
    missingPrices.push(`${fc.category}: ${fc.name} (priced in ${fc.currency} instead of ${primaryCurrency})`);
  }

  // Known subtotal in primary currency computed with minor units
  const primaryPriced = components.filter((c) => c.price !== null && c.currency === primaryCurrency);
  const subtotalMinor = primaryPriced.reduce(
    (sum, c) => sum + toPriceMinor(c.price!, primaryCurrency),
    0
  );
  const subtotal = fromPriceMinor(subtotalMinor, primaryCurrency);

  // Complete total strictly requires ALL parts to be priced in the primary currency
  const allMatchPrimary =
    components.length > 0 &&
    pricedComponents.length === components.length &&
    foreignCurrencyItems.length === 0;

  const isComplete =
    unpricedComponents.length === 0 &&
    components.length > 0 &&
    allMatchPrimary;

  const total = isComplete ? subtotal : null;

  const validationSummary: BuildSnapshotValidationSummary = {
    passed: validation.summary?.passed ?? validation.checks?.filter((c) => c.status === "passed").length ?? 0,
    failed: validation.summary?.failed ?? validation.checks?.filter((c) => c.status === "failed").length ?? 0,
    unverified: validation.summary?.unverified ?? validation.checks?.filter((c) => c.status === "unverified").length ?? 0,
    skipped: validation.skipped_checks?.length ?? 0,
    issues: (validation.issues || []).map((i) => i.detail || `${i.rule}: ${i.severity}`)
  };

  return {
    label,
    components,
    total,
    subtotal,
    currency: primaryCurrency,
    is_complete: isComplete,
    component_count: components.length,
    unpriced_count: unpricedComponents.length,
    missing_prices: missingPrices,
    currencies: distinctCurrencies,
    parts,
    valid: Boolean(validation.valid),
    validation_summary: validationSummary,
    created_at: new Date().toISOString()
  };
}
