import { tool } from "ai";
import { z } from "zod";
import { getCatalogRepository, type CatalogRepository, type CatalogScope } from "@/lib/catalog";

export type GetCatalogScope = CatalogScope & {
  repository?: CatalogRepository;
};

export function createGetCatalogTool(scope: GetCatalogScope, repository?: CatalogRepository) {
  return tool({
    description:
      "Call get_catalog ONCE at the start of a build to see which component categories have products in the local catalog. Every category is listed; a category with count 0 has no products and cannot be built with - say so plainly rather than inventing parts. The count and price range of each category cover only parts that go INSIDE a PC. Some categories also carry a `subcategories` breakdown of accessories that are stocked but are NOT build parts (for storage: external drives, pen drives, memory cards); never put those in a build unless the user explicitly asks. Prices are in standard major units (Rupees/Dollars).",
    inputSchema: z.object({}),
    execute: async () => getCatalog(scope, repository ?? scope.repository)
  });
}

export async function getCatalog(scope: GetCatalogScope, repository?: CatalogRepository) {
  const repo = repository ?? scope.repository ?? getCatalogRepository();
  return repo.getCatalog(scope);
}

