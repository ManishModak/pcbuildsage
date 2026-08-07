import type { ComponentCategory } from "@/lib/registry";

/**
 * Retailers file products by shop-shelf taxonomy, not by build role. MDComputers'
 * "storage" aisle mixes internal SSDs with pen drives, memory cards and NAS boxes,
 * and the scraper inherited that shelf verbatim. `products.subcategory` (written by
 * the Python normalizer) records what a row actually is.
 *
 * Everything the model plans a build against must be scoped through here. When it
 * was not, `get_catalog` reported storage starting at 410 - the price of a 4GB USB
 * stick - and the model, reasoning correctly from that floor, searched 2000-10000
 * and put pen drives in three gaming builds.
 */

/** The eight categories a PC build is assembled from, in cascade order. */
export const COMPONENT_CATEGORIES: ComponentCategory[] = [
  "gpu",
  "cpu",
  "motherboard",
  "ram",
  "storage",
  "psu",
  "case",
  "cooler"
];

/** Storage rows split by build role; other categories carry a NULL subcategory. */
export const STORAGE_SUBCATEGORIES = ["internal", "external", "removable", "accessory"] as const;
export type StorageSubcategory = (typeof STORAGE_SUBCATEGORIES)[number];

/** The only storage rows that belong inside a PC. */
export const BUILD_SUBCATEGORY = "internal";

/**
 * SQL predicate for rows usable in a build. A NULL subcategory means the category
 * has no build/accessory split (cpu, gpu, ram...), so those rows always qualify.
 */
export const BUILD_RELEVANT_SQL = "(subcategory IS NULL OR subcategory = 'internal')";

/** True when the caller is planning a build rather than shopping for accessories. */
export function isBuildRelevant(subcategory: string | null | undefined): boolean {
  return subcategory == null || subcategory === BUILD_SUBCATEGORY;
}
