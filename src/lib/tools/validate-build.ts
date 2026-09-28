import { tool } from "ai";
import { z } from "zod";
import { resolveComponent, withTitleGpuLength, type ComponentCategory } from "../registry";
import { parseSpecsFromTitle } from "../spec-parsers";
import { getCatalogRepository, type CatalogRepository, type CatalogScope } from "../catalog";
import { validateBuild, type BuildParts, type BuildPart, type ValidationResult } from "../rules-engine";
import { createBuildSnapshot, type BuildSnapshot } from "../catalog/build-snapshot";
import { createTurnValidationStore, recordValidation, type TurnValidationStore } from "./turn-state";
import { distinguishingPrefix, MIN_PREFIX_LEN, resolveIdPrefix, shortId } from "./product-ids";

const componentCategorySchema = z.enum(["cpu", "gpu", "motherboard", "ram", "storage", "psu", "case", "cooler"]);

const partSchema = z.union([
  z.string().describe("Registry key, component name, or catalog product ID prefix."),
  z.object({
    product_id: z.string().min(1).optional().describe("Catalog product ID or unique prefix (>=8 chars, first 10 shown by search_products). Preferred for catalog parts; specs are looked up server-side."),
    key: z.string().optional().describe("Canonical registry key when known."),
    name: z.string().optional().describe("Human-readable component name when key is not known."),
    category: componentCategorySchema.optional().describe("Component category hint.")
  }).refine((part) => Boolean(part.product_id?.trim() || part.key?.trim() || part.name?.trim()), { message: "Part object must include at least one of product_id, key or name." })
]);

export const singleBuildValidationSchema = z.object({
  label: z
    .string()
    .min(1)
    .describe(
      "Short label naming the tradeoff this build makes, e.g. 'Within budget', 'Small upgrade', 'Max Performance'."
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

export const validateBuildInputSchema = z.object({
  builds: z
    .array(singleBuildValidationSchema)
    .min(1)
    .max(5)
    // Results are keyed by label, so duplicate labels would silently overwrite each other.
    .refine((builds) => new Set(builds.map((b) => b.label.trim().toLowerCase())).size === builds.length, {
      message: "Each build needs a unique label."
    })
    .describe("One to five complete build proposals to validate side by side, each with a unique label.")
});

export type ValidateBuildInput = z.infer<typeof validateBuildInputSchema>;

/** Prefix lookup against the catalog for short IDs the model passes back. */
async function findIdsByPrefix(
  prefix: string,
  scope: CatalogScope,
  repo: CatalogRepository
): Promise<string[]> {
  const p = prefix.trim();
  if (p.length < MIN_PREFIX_LEN) return [];
  // Escaped: `_` and `%` in a model-supplied prefix are literals, not wildcards.
  const like = `${p.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const countryCode = scope.countryCode ?? "US";
  const currency = scope.currency ?? "USD";
  try {
    const anyRepo = repo as unknown as {
      getDatabase?: (s?: CatalogScope) => {
        prepare: (sql: string) => { all: (...args: unknown[]) => Array<{ id: unknown }> };
      };
      driver?: {
        all: (sql: string, params: unknown[], scope?: CatalogScope) => Promise<unknown[]>;
      };
    };
    if (typeof anyRepo.getDatabase === "function") {
      const db = anyRepo.getDatabase(scope);
      const rows = db
        .prepare("SELECT id FROM products WHERE id LIKE ? ESCAPE '\\' AND country_code = ? AND currency = ? LIMIT 10")
        .all(like, countryCode, currency);
      return rows.map((r) => String(r.id));
    }
    if (anyRepo.driver && typeof anyRepo.driver.all === "function") {
      const rows = await anyRepo.driver.all(
        "SELECT id FROM products WHERE id LIKE ? ESCAPE '\\' AND country_code = ? AND currency = ? LIMIT 10",
        [like, countryCode, currency],
        scope
      );
      return (rows as Array<Record<string, unknown>>).map((r) => String(r.id));
    }
  } catch {
    return [];
  }
  return [];
}

/**
 * An ambiguous ID prefix names no single product, so the build is not valid:
 * the rules engine records any unresolved part as "unverified", which would
 * still let the build pass (and be presented) with a part nobody chose. Turns
 * those checks into failures and their issues into blocking ones, in place.
 */
function failAmbiguousParts(
  validation: ValidationResult,
  parts: BuildParts,
  messageFor: (pid: string, category: ComponentCategory) => string | undefined
): void {
  const messages = new Set<string>();
  for (const [category, raw] of Object.entries(parts) as [ComponentCategory, BuildPart | BuildPart[]][]) {
    for (const part of Array.isArray(raw) ? raw : raw ? [raw] : []) {
      const pid = typeof part === "string" ? part.trim() : part?.product_id?.trim();
      const message = pid ? messageFor(pid, category) : undefined;
      if (message) messages.add(message);
    }
  }
  if (messages.size === 0) return;
  let moved = 0;
  for (const check of validation.checks ?? []) {
    if (check.status === "unverified" && check.message && messages.has(check.message)) {
      check.status = "failed";
      moved++;
    }
  }
  validation.issues = validation.issues.map((issue) =>
    issue.detail && messages.has(issue.detail) ? { ...issue, severity: "blocking" } : issue
  );
  const { passed, failed, unverified } = validation.summary;
  const nowFailed = failed + moved;
  const nowUnverified = Math.max(0, unverified - moved);
  validation.summary = {
    passed,
    failed: nowFailed,
    unverified: nowUnverified,
    text: `${nowFailed} check(s) failed · ${passed} passed · ${nowUnverified} unverified`
  };
  validation.valid = false;
}

/**
 * Model-only view: only {builds}, with product IDs shortened to 10 chars.
 * Also runs on replayed history: an output with no `builds` (an older saved
 * single-build shape) passes through unchanged rather than being emptied.
 */
export function toModelValidateOutput(output: unknown): unknown {
  if (!output || typeof output !== "object") return output;
  const obj = output as Record<string, unknown>;
  const builds = obj.builds;
  if (!builds || typeof builds !== "object") return output;
  const shortBuilds: Record<string, unknown> = {};
  for (const [label, entry] of Object.entries(builds as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") {
      shortBuilds[label] = entry;
      continue;
    }
    const e = entry as Record<string, unknown>;
    const snap = e.snapshot as
      | { components?: Array<Record<string, unknown>> }
      | undefined;
    if (!snap || !Array.isArray(snap.components)) {
      shortBuilds[label] = e;
      continue;
    }
    shortBuilds[label] = {
      ...e,
      snapshot: {
        ...(snap as object),
        components: snap.components.map((c) => ({
          ...c,
          product_id:
            typeof c.product_id === "string" && c.product_id.length > 10
              ? shortId(c.product_id)
              : c.product_id
        }))
      }
    };
  }
  return { builds: shortBuilds };
}

export function createValidateBuildTool(scope: CatalogScope = { countryCode: "US", currency: "USD" }, repository?: CatalogRepository, store?: TurnValidationStore) {
  const turnStore = store ?? createTurnValidationStore();
  return tool({
    description:
      "Use validate_build to validate 1 to 5 proposed PC builds side by side in a single call before presenting them. Each build must have a short label naming its tradeoff (e.g. 'Within budget', 'Small upgrade', 'Max Performance') and its component parts. Returns compatibility results and authoritative code-calculated build snapshots with catalog prices, product IDs, and totals keyed by label. Preferred parts format uses catalog product ID prefixes from search_products (first 10 chars, min 8): {\"builds\":[{\"label\":\"Within budget\",\"parts\":{\"cpu\":{\"product_id\":\"da6670a41d\"},\"gpu\":{\"product_id\":\"a1f8c14e1a\"}}}]}.",
    inputSchema: validateBuildInputSchema,
    toModelOutput: async ({ output }) => ({ type: "json", value: toModelValidateOutput(output) }) as never,
    execute: async (rawInput: unknown) => {
      const input = (rawInput ?? {}) as {
        builds?: Array<{ label: string; parts: BuildParts }>;
        label?: string;
        parts?: BuildParts;
      };

      const buildList: Array<{ label: string; parts: BuildParts }> =
        Array.isArray(input.builds) && input.builds.length > 0
          ? input.builds
          : [{ label: input.label ?? "Proposed Build", parts: input.parts ?? {} }];

      // Collect candidate product IDs across all builds in the batch
      const candidateIds = Array.from(
        new Set(
          buildList.flatMap((b) =>
            Object.values(b.parts)
              .flatMap((raw) => (Array.isArray(raw) ? raw : [raw]))
              .flatMap((part) => {
                if (!part) return [];
                if (typeof part === "string" && part.trim().length > 0) return [part.trim()];
                if (typeof part === "object" && part && part.product_id?.trim()) return [part.product_id.trim()];
                return [];
              })
          )
        )
      );

      const repo = repository ?? getCatalogRepository();
      const products = candidateIds.length > 0
        ? await repo.searchProducts({ product_ids: candidateIds, inStockOnly: false, limit: candidateIds.length }, scope)
        : { results: [], total_matching: 0 };
      const byId = new Map(products.results.map((product) => [product.id, product]));

      // Resolve unique prefixes (>=8 chars) to full catalog IDs. Exact IDs
      // win; otherwise a single LIKE match wins and ambiguous prefixes are
      // reported as unresolved with candidates.
      const prefixToFull = new Map<string, string>();
      const prefixAmbiguous = new Map<string, string[]>();
      for (const candidate of candidateIds) {
        if (byId.has(candidate)) continue;
        if (candidate.length < MIN_PREFIX_LEN) continue;
        const matches = await findIdsByPrefix(candidate, scope, repo);
        if (matches.length === 1 && !byId.has(matches[0])) {
          const fullProducts = await repo.searchProducts(
            { product_ids: [matches[0]], inStockOnly: false, limit: 1 },
            scope
          );
          for (const p of fullProducts.results) byId.set(p.id, p);
        }
        if (matches.length === 1) {
          prefixToFull.set(candidate, matches[0]);
        } else if (matches.length > 1) {
          prefixAmbiguous.set(candidate, matches);
        }
      }

      // Names for ambiguous candidates, so the error can tell the model which
      // product each distinguishing prefix is.
      const ambiguousIds = [...new Set([...prefixAmbiguous.values()].flat())];
      const ambiguousNames = new Map<string, string>();
      if (ambiguousIds.length > 0) {
        const found = await repo.searchProducts(
          { product_ids: ambiguousIds, inStockOnly: false, limit: ambiguousIds.length },
          scope
        );
        for (const p of found.results) ambiguousNames.set(p.id, p.name);
      }
      const ambiguityMessage = (pid: string, category: ComponentCategory): string | undefined => {
        const matches = prefixAmbiguous.get(pid);
        if (!matches) return undefined;
        const listed = matches
          .map((id) => {
            const name = ambiguousNames.get(id);
            return name ? `${distinguishingPrefix(id, matches)} (${name})` : distinguishingPrefix(id, matches);
          })
          .join(", ");
        return `Ambiguous product ID prefix '${pid}' for ${category} matches ${matches.length} products: ${listed}. Pass one of these prefixes.`;
      };

      const resolveSuppliedId = (raw: string): string => {
        const trimmed = raw.trim();
        if (byId.has(trimmed)) return trimmed;
        const mapped = prefixToFull.get(trimmed);
        if (mapped) return mapped;
        // An ambiguous prefix stays unresolved: another build in the batch
        // loading one of its matches must not make it silently pick that one.
        if (prefixAmbiguous.has(trimmed)) return trimmed;
        // Fall back to in-memory prefix match against already-loaded IDs
        // (covers mock repos without LIKE support).
        const loaded = [...byId.keys()];
        const res = resolveIdPrefix(trimmed, loaded);
        if ("full" in res) return res.full;
        return trimmed;
      };

      const results: Record<string, ValidationResult & { snapshot: BuildSnapshot }> = {};

      for (const b of buildList) {
        // Narrow server-side normalization:
        // Exact catalog IDs win; unique prefixes resolve to their full ID and
        // are stored as full IDs. Registry-key/name support is preserved when
        // there is no catalog ID match.
        const normalizePart = (part: BuildPart): BuildPart => {
          if (typeof part === "string") {
            const trimmed = part.trim();
            if (byId.has(trimmed) || prefixToFull.has(trimmed)) {
              return { product_id: resolveSuppliedId(trimmed) };
            }
            // A hash-like string that resolves as a unique prefix against
            // loaded IDs is a product reference, not a registry key.
            if (trimmed.length >= MIN_PREFIX_LEN && !prefixAmbiguous.has(trimmed)) {
              const res = resolveIdPrefix(trimmed, [...byId.keys()]);
              if ("full" in res) return { product_id: res.full };
            }
            return part;
          }
          if (part && typeof part.product_id === "string") {
            const pid = part.product_id.trim();
            const full = resolveSuppliedId(pid);
            if (full !== part.product_id) return { ...part, product_id: full };
            if (pid !== part.product_id) return { ...part, product_id: pid };
          }
          return part;
        };

        const normalizedParts: BuildParts = {};
        for (const [category, raw] of Object.entries(b.parts) as [ComponentCategory, BuildPart | BuildPart[]][]) {
          if (!raw) continue;
          if (Array.isArray(raw)) {
            normalizedParts[category] = raw.map(normalizePart);
          } else {
            normalizedParts[category] = normalizePart(raw);
          }
        }

        const getUnresolvedMessage = (part: BuildPart, category: ComponentCategory): string => {
          const ambiguous = ambiguityMessage(typeof part === "string" ? part.trim() : (part?.product_id?.trim() ?? ""), category);
          if (ambiguous) return ambiguous;
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

        failAmbiguousParts(validation, normalizedParts, (pid, category) => ambiguityMessage(pid, category));

        const snapshot = createBuildSnapshot({ label: b.label, parts: normalizedParts, validation, productsById: byId, scope });
        results[b.label] = { ...validation, snapshot };
        recordValidation(turnStore, b.label, results[b.label]);
      }

      const isLegacySingle = !(rawInput && typeof rawInput === "object" && "builds" in rawInput) && Boolean((rawInput as { parts?: unknown })?.parts);
      const firstResult = Object.values(results)[0];

      if (isLegacySingle && firstResult) {
        const legacyReturn = Object.assign(firstResult, { builds: results, ...results });
        results[Object.keys(results)[0]] = legacyReturn;
        return legacyReturn;
      }

      return {
        builds: results,
        ...results
      };
    }
  });
}
