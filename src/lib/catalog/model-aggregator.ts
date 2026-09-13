/**
 * src/lib/catalog/model-aggregator.ts
 *
 * Canonical model grouping, stable variant identification, and deterministic
 * model ID building and matching.
 */

import type { Product } from "@/types/db";
import type { RegistrySpec } from "@/lib/registry";
import { slugifyComponent } from "@/lib/normalizer";
import { toCompactFunctionalSpecs } from "./compact";
import type { ComponentModelItem, ListModelsInput } from "./repository";

/**
 * Extracts or builds the canonical base key for a product.
 * Prefers resolved registry key, then product's stored registry_key,
 * and falls back to a normalized slug of the model or product name.
 */
export function getCanonicalBaseKey(
  product: Product,
  spec?: RegistrySpec,
  registryKey?: string
): string {
  const key = (registryKey ?? product.registry_key)?.toLowerCase().trim();
  if (key) return key;

  const modelOrName =
    (typeof spec?.model === "string" && spec.model) ||
    product.normalized_name ||
    product.name;
  const slug = slugifyComponent(modelOrName);
  if (slug) return slug;

  const fallbackCat = (product.category || "item").toLowerCase().trim();
  return `unknown-${fallbackCat}`;
}

/**
 * Builds a deterministic, filter-independent canonical model ID.
 * - GPUs with VRAM append -${vram}gb (e.g. rx-7700-xt-12gb)
 * - PSUs append -${wattage}w (e.g. rm750x-750w)
 * - Storage/RAM append capacity (e.g. -${cap}gb or -${tb}tb)
 * - Unkeyed products use consistent slugified fallback
 */
export function buildCanonicalModelId(
  product: Product,
  spec?: RegistrySpec,
  registryKey?: string
): string {
  const baseKey = getCanonicalBaseKey(product, spec, registryKey);
  const category = (product.category || "").toLowerCase().trim();

  if (category === "gpu" && spec?.vram_gb !== undefined && spec.vram_gb !== null) {
    const vram = Number(spec.vram_gb);
    if (Number.isFinite(vram) && vram > 0) {
      const vramSuffix = `-${vram}gb`;
      if (!baseKey.endsWith(vramSuffix)) {
        return `${baseKey}${vramSuffix}`;
      }
    }
  } else if (category === "psu") {
    const wattage = spec?.wattage ?? spec?.wattage_w;
    if (wattage !== undefined && wattage !== null) {
      const watt = Number(wattage);
      if (Number.isFinite(watt) && watt > 0) {
        const wattSuffix = `-${watt}w`;
        if (!baseKey.endsWith(wattSuffix)) {
          return `${baseKey}${wattSuffix}`;
        }
      }
    }
  } else if (category === "storage" || category === "ram") {
    if (spec?.capacity_gb !== undefined && spec.capacity_gb !== null) {
      const cap = Number(spec.capacity_gb);
      if (Number.isFinite(cap) && cap > 0) {
        const capGbSuffix = `-${cap}gb`;
        const capTbSuffix = cap >= 1000 && cap % 1000 === 0 ? `-${cap / 1000}tb` : null;
        const alreadyHas =
          baseKey.endsWith(capGbSuffix) ||
          (capTbSuffix !== null && baseKey.endsWith(capTbSuffix));
        if (!alreadyHas) {
          return `${baseKey}${capTbSuffix ?? capGbSuffix}`;
        }
      }
    }
  }

  return baseKey;
}

/**
 * Evaluates whether a product and its spec match a target model ID.
 * Matches canonical model ID, base key, registry key, spec model, product name/slug,
 * and variant aliases (e.g. GB vs TB representations, or base registry key with variant suffix).
 */
export function matchesModelId(
  product: Product,
  spec: RegistrySpec | undefined,
  targetModelId: string,
  registryKey?: string
): boolean {
  const target = targetModelId.toLowerCase().trim();
  if (!target) return false;

  const canonicalId = buildCanonicalModelId(product, spec, registryKey).toLowerCase();
  if (canonicalId === target) return true;

  const baseKey = getCanonicalBaseKey(product, spec, registryKey).toLowerCase();
  const rawRegKey = (registryKey ?? product.registry_key)?.toLowerCase().trim();

  // If target matches the base key or raw registry key
  if (baseKey === target) return true;
  if (rawRegKey && rawRegKey === target) return true;

  // Spec model or normalized slug
  if (spec?.model && typeof spec.model === "string") {
    const specModelLower = spec.model.toLowerCase().trim();
    if (specModelLower === target || slugifyComponent(spec.model) === target) {
      return true;
    }
  }

  // Product title or normalized name match
  const normName = product.normalized_name?.toLowerCase().trim();
  if (normName && (normName === target || slugifyComponent(normName) === target)) {
    return true;
  }
  const prodName = product.name.toLowerCase().trim();
  if (prodName && (prodName === target || slugifyComponent(product.name) === target)) {
    return true;
  }

  // Suffix matching against baseKey or rawRegKey for specific variants
  const category = (product.category || "").toLowerCase().trim();
  if (category === "gpu" && spec?.vram_gb !== undefined && spec.vram_gb !== null) {
    const vram = Number(spec.vram_gb);
    if (Number.isFinite(vram) && vram > 0) {
      if (`${baseKey}-${vram}gb` === target) return true;
      if (rawRegKey && `${rawRegKey}-${vram}gb` === target) return true;
    }
  } else if (category === "psu") {
    const wattage = spec?.wattage ?? spec?.wattage_w;
    if (wattage !== undefined && wattage !== null) {
      const watt = Number(wattage);
      if (Number.isFinite(watt) && watt > 0) {
        if (`${baseKey}-${watt}w` === target) return true;
        if (rawRegKey && `${rawRegKey}-${watt}w` === target) return true;
      }
    }
  } else if (category === "storage" || category === "ram") {
    if (spec?.capacity_gb !== undefined && spec.capacity_gb !== null) {
      const cap = Number(spec.capacity_gb);
      if (Number.isFinite(cap) && cap > 0) {
        if (`${baseKey}-${cap}gb` === target) return true;
        if (rawRegKey && `${rawRegKey}-${cap}gb` === target) return true;
        if (cap >= 1000 && cap % 1000 === 0) {
          const tbVal = cap / 1000;
          if (`${baseKey}-${tbVal}tb` === target) return true;
          if (rawRegKey && `${rawRegKey}-${tbVal}tb` === target) return true;
        }
      }
    }
  }

  return false;
}

export interface AggregateModelsOptions {
  resolveSpec?: (product: Product) => { spec?: RegistrySpec; key?: string } | undefined;
  input?: ListModelsInput;
}

/**
 * Pure aggregation of product listings into unique ComponentModelItem objects.
 * Computes min_price, max_price, and listing_count in a single pass without buffering price arrays.
 * Retains complete eligible-set aggregation before caller pagination/slicing.
 */
export function aggregateModels(
  products: Product[],
  options: AggregateModelsOptions = {}
): ComponentModelItem[] {
  const { resolveSpec, input = {} } = options;

  type ModelAccumulator = {
    model_id: string;
    name: string;
    category: string;
    specs: Record<string, unknown>;
    min_price: number | null;
    max_price: number | null;
    listing_count: number;
  };

  const modelMap = new Map<string, ModelAccumulator>();

  for (const product of products) {
    const resolved = resolveSpec ? resolveSpec(product) : undefined;
    let spec = resolved?.spec;
    const regKey = resolved?.key ?? product.registry_key ?? undefined;

    if (!spec && product.specs) {
      if (typeof product.specs === "object") {
        spec = product.specs as RegistrySpec;
      } else if (typeof product.specs === "string") {
        try {
          spec = JSON.parse(product.specs);
        } catch {}
      }
    }

    // In-memory spec filtering for listModels criteria
    const canon = (v: unknown): string => (typeof v === "string" ? v.trim().toLowerCase() : "");
    if (input.socket) {
      const sockets = [
        spec?.socket,
        ...(Array.isArray(spec?.sockets) ? spec.sockets : [])
      ].filter(Boolean).map(canon);
      if (!sockets.includes(canon(input.socket))) continue;
    }
    if (input.ddr && canon(spec?.ddr) !== canon(input.ddr)) continue;
    if (input.form_factor) {
      const targetForm = canon(input.form_factor);
      const forms = [
        spec?.form_factor,
        ...(Array.isArray(spec?.form_factors) ? spec.form_factors : [])
      ].map(canon);
      if (!forms.includes(targetForm)) continue;
    }
    if (input.min_vram_gb !== undefined && Number(spec?.vram_gb ?? -1) < input.min_vram_gb) {
      continue;
    }
    if (input.min_capacity_gb !== undefined && Number(spec?.capacity_gb ?? -1) < input.min_capacity_gb) {
      continue;
    }

    const modelId = buildCanonicalModelId(product, spec, regKey);
    const existing = modelMap.get(modelId);

    if (existing) {
      existing.listing_count++;
      if (typeof product.price === "number") {
        existing.min_price =
          existing.min_price === null ? product.price : Math.min(existing.min_price, product.price);
        existing.max_price =
          existing.max_price === null ? product.price : Math.max(existing.max_price, product.price);
      }
    } else {
      const cleanSpecs =
        toCompactFunctionalSpecs(spec as Record<string, unknown> | null | undefined) ?? {};
      const name =
        typeof spec?.model === "string"
          ? spec.model
          : product.normalized_name || product.name;
      const price = typeof product.price === "number" ? product.price : null;

      modelMap.set(modelId, {
        model_id: modelId,
        name,
        category: product.category,
        specs: cleanSpecs,
        min_price: price,
        max_price: price,
        listing_count: 1
      });
    }
  }

  const allModels: ComponentModelItem[] = Array.from(modelMap.values()).map((acc) => ({
    model_id: acc.model_id,
    name: acc.name,
    category: acc.category,
    specs: acc.specs,
    price_range: {
      min: acc.min_price,
      max: acc.max_price
    },
    listing_count: acc.listing_count
  }));

  allModels.sort((a, b) => {
    if (a.price_range.min !== null && b.price_range.min !== null) {
      if (a.price_range.min !== b.price_range.min) {
        return a.price_range.min - b.price_range.min;
      }
    } else if (a.price_range.min !== null) {
      return -1;
    } else if (b.price_range.min !== null) {
      return 1;
    }
    if (b.listing_count !== a.listing_count) {
      return b.listing_count - a.listing_count;
    }
    return a.name.localeCompare(b.name);
  });

  return allModels;
}
