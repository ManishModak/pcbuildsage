import { tool } from "ai";
import { z } from "zod";
import { resolveComponent, withTitleGpuLength, type ComponentCategory } from "../registry";
import { parseSpecsFromTitle } from "../spec-parsers";
import { getCatalogRepository, type CatalogRepository, type CatalogScope } from "../catalog";
import { validateBuild, type BuildParts, type BuildPart } from "../rules-engine";
import { createBuildSnapshot } from "../catalog/build-snapshot";

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
      "Use validate_build to validate the complete build before presenting it. Check earlier when compatibility affects a component choice. If parts change afterward, validate the revised build before presenting it. It returns compatibility results and an authoritative code-calculated build snapshot with catalog prices, exact product IDs, and total. When proposing several builds side by side, pass a short label for each so the interface can title them. Preferred parts format uses exact catalog product IDs: {\"label\":\"Max frames now\",\"parts\":{\"cpu\":{\"product_id\":\"in-cpu-amd-ryzen-7-9700x-01\"},\"motherboard\":{\"product_id\":\"in-mobo-msi-b650-01\"},\"ram\":{\"product_id\":\"in-ram-corsair-32gb-01\"}}}.",
    inputSchema: validateBuildInputSchema,
    execute: async ({ label, parts }: { label?: string; parts: BuildParts }) => {
      // Collect candidate product IDs from both object product_id and legacy strings
      const candidateIds = Array.from(
        new Set(
          Object.values(parts)
            .flatMap((raw) => (Array.isArray(raw) ? raw : [raw]))
            .flatMap((part) => {
              if (!part) return [];
              if (typeof part === "string" && part.trim().length > 0) return [part.trim()];
              if (typeof part === "object" && part && part.product_id?.trim()) return [part.product_id.trim()];
              return [];
            })
        )
      );

      const repo = repository ?? getCatalogRepository();
      const products = candidateIds.length > 0
        ? await repo.searchProducts({ product_ids: candidateIds, inStockOnly: false, limit: candidateIds.length }, scope)
        : { results: [], total_matching: 0 };
      const byId = new Map(products.results.map((product) => [product.id, product]));

      // Narrow server-side normalization:
      // If a legacy string exactly matches a catalog product ID in the active scope, treat it as that product ID.
      // Preserve genuine registry-key/name support when there is no exact catalog ID match.
      // Object product IDs are trimmed exactly like legacy strings so padded IDs resolve identically.
      const normalizePart = (part: BuildPart): BuildPart => {
        if (typeof part === "string") {
          const trimmed = part.trim();
          if (byId.has(trimmed)) {
            return { product_id: trimmed };
          }
          return part;
        }
        if (part && typeof part.product_id === "string") {
          const pid = part.product_id.trim();
          if (pid && pid !== part.product_id) {
            return { ...part, product_id: pid };
          }
        }
        return part;
      };

      const normalizedParts: BuildParts = {};
      for (const [category, raw] of Object.entries(parts) as [ComponentCategory, BuildPart | BuildPart[]][]) {
        if (!raw) continue;
        if (Array.isArray(raw)) {
          normalizedParts[category] = raw.map(normalizePart);
        } else {
          normalizedParts[category] = normalizePart(raw);
        }
      }

      const getUnresolvedMessage = (part: BuildPart, category: ComponentCategory): string => {
        if (typeof part === "object" && part && part.product_id) {
          const pid = part.product_id.trim();
          const product = byId.get(pid);
          if (!product) {
            return `Unresolved product ID '${pid}' for ${category}. Verify the product ID from search_products results.`;
          }
          if (product.category !== category) {
            return `Product '${pid}' is categorized as ${product.category}, not ${category}.`;
          }
          return `No ${category} specs found in registry or research cache for '${product.name}'.`;
        }
        if (typeof part === "string") {
          return `Unresolved component ID or name '${part}' for ${category}. Ensure product IDs match search_products results or specify a known component name.`;
        }
        return `No ${category} specs found in registry or research cache.`;
      };

      const validation = validateBuild(normalizedParts, {
        resolve: (part, category) => {
          if (typeof part === "string" || !part.product_id) {
            return resolveComponent(typeof part === "string" ? { key: part, name: part, category } : { ...part, category });
          }
          const product = byId.get(part.product_id.trim());
          if (!product || product.category !== category) return undefined;
          const resolved = resolveComponent({ key: product.registry_key ?? undefined, name: product.name, category });
          if (!resolved) return undefined;
          // One narrow merge path for offer-title specs: GPU lengths go through
          // the provenance/conflict handling in withTitleGpuLength (idempotent
          // when resolveComponent already merged the same title); RAM keeps its
          // title capacity normalization.
          const withTitle = category === "gpu" ? withTitleGpuLength(resolved, product.name) : resolved;
          const titleSpecs = category === "ram" ? parseSpecsFromTitle(product.name, category) : undefined;
          return { ...withTitle, key: product.id, spec: { ...withTitle.spec, ...titleSpecs, ...(product.specs?.spec_conflict ? { spec_conflict: product.specs.spec_conflict } : {}) } };
        },
        getUnresolvedMessage
      });

      const snapshot = createBuildSnapshot({ label, parts: normalizedParts, validation, productsById: byId, scope });
      return { ...validation, snapshot };
    }
  });
}
