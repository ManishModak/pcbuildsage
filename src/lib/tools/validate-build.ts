import { tool } from "ai";
import { z } from "zod";
import { resolveComponent } from "../registry";
import { parseSpecsFromTitle } from "../spec-parsers";
import { getCatalogRepository, type CatalogRepository, type CatalogScope } from "../catalog";
import { validateBuild, type BuildParts } from "../rules-engine";

const componentCategorySchema = z.enum(["cpu", "gpu", "motherboard", "ram", "storage", "psu", "case", "cooler"]);

const partSchema = z.union([
  z.string().describe("Registry key or component name."),
  z.object({
    product_id: z.string().min(1).optional().describe("Exact id from search_products. Preferred for catalog parts; specs are looked up server-side."),
    key: z.string().optional().describe("Canonical registry key when known."),
    name: z.string().optional().describe("Human-readable component name when key is not known."),
    category: componentCategorySchema.optional().describe("Component category hint.")
  }).refine((part) => Boolean(part.product_id?.trim() || part.key?.trim() || part.name?.trim()), { message: "Part object must include at least one of product_id, key or name." })
]);

export const validateBuildInputSchema = z.object({
  label: z
    .string()
    .optional()
    .describe(
      "Short label naming the tradeoff this build makes, e.g. 'Max frames now' or 'Room to upgrade'. Supply it when proposing several builds side by side so each can be titled; omit it for a single build."
    ),
  parts: z
    .object({
      cpu: partSchema.optional().describe("Selected CPU."),
      gpu: partSchema.optional().describe("Selected GPU."),
      motherboard: partSchema.optional().describe("Selected motherboard."),
      ram: partSchema.optional().describe("Selected memory kit."),
      storage: z.union([partSchema, z.array(partSchema)]).optional().describe("Selected storage drive or drives."),
      psu: partSchema.optional().describe("Selected power supply."),
      case: partSchema.optional().describe("Selected case."),
      cooler: partSchema.optional().describe("Selected CPU cooler.")
    })
    .describe("Current build parts keyed by component category.")
});

export function createValidateBuildTool(scope: CatalogScope = { countryCode: "US", currency: "USD" }, repository?: CatalogRepository) {
  return tool({
    description:
      "Use validate_build to validate the complete build before presenting it. Check earlier when compatibility affects a component choice. If parts change afterward, validate the revised build before presenting it. It is deterministic Tier 1 compatibility authority; do not use it for price search or advisory web research. When proposing several builds side by side, pass a short label for each so the interface can title them. Example: {\"label\":\"Max frames now\",\"parts\":{\"cpu\":\"amd-ryzen-7-9700x\",\"motherboard\":\"msi-b650-a\",\"ram\":\"corsair-vengeance-32gb-ddr5-6000\"}}.",
    inputSchema: validateBuildInputSchema,
    execute: async ({ parts }: { parts: BuildParts }) => {
      const ids = Object.values(parts).flatMap((raw) => (Array.isArray(raw) ? raw : [raw]))
        .flatMap((part) => typeof part === "object" && part.product_id ? [part.product_id] : []);
      if (!ids.length) return validateBuild(parts);
      const products = await (repository ?? getCatalogRepository()).searchProducts(
        { product_ids: [...new Set(ids)], in_stock: false, limit: ids.length }, scope
      );
      const byId = new Map(products.results.map((product) => [product.id, product]));
      return validateBuild(parts, {
        resolve: (part, category) => {
          if (typeof part === "string" || !part.product_id) {
            return resolveComponent(typeof part === "string" ? { key: part, name: part, category } : { ...part, category });
          }
          const product = byId.get(part.product_id);
          if (!product || product.category !== category) return undefined;
          const resolved = resolveComponent({ key: product.registry_key ?? undefined, name: product.name, category });
          if (!resolved) return undefined;
          // Only explicit offer-title specs supplement model-level registry data.
          const titleSpecs = category === "ram" || category === "gpu" ? parseSpecsFromTitle(product.name, category) : undefined;
          return { ...resolved, key: product.id, spec: { ...resolved.spec, ...titleSpecs } };
        }
      });
    }
  });
}
