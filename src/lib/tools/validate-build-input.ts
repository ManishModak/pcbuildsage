import { z } from "zod";
import { leadingJsonValue, parsedJson } from "./lenient-input";

// validate_build's input side: the schema, the free-order parts schema sent to
// providers, and the clean-up of each build's parts before validation.

// The field guidance lives once on `parts`, not on each of its nine slots: a
// per-slot copy made this the largest tool schema small models are sent.
// The slot names the category, so a part carries none of its own.
const partSchema = z.union([
  z.string(),
  z.object({
    product_id: z.string().min(1).optional(),
    name: z.string().optional(),
    owned: z.boolean().optional(),
    key: z.string().optional()
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
      cpu: partSchema.optional(),
      gpu: partSchema.optional(),
      motherboard: partSchema.optional(),
      ram: partSchema.optional(),
      storage: z.union([partSchema, z.array(partSchema)]).optional(),
      psu: partSchema.optional(),
      case: partSchema.optional(),
      cooler: partSchema.optional()
    })
    // Unknown keys fail the call instead of silently dropping a part (see normalizeParts).
    .strict()
    .describe(
      "Every part of this build, keyed by category; storage may be a list. A part to buy is {\"product_id\": the 10-character ID from search_products}. A part the user already owns is {\"name\": \"RTX 3070\", \"owned\": true}: checked for compatibility, costs 0. The tool keeps no state between calls: pass the full build each time."
    )
});

export const validateBuildInputSchema = z.object({
  builds: parsedJson(z
    .array(singleBuildValidationSchema)
    .min(1)
    .max(5)
    // Results are keyed by label, so duplicate labels would silently overwrite each other.
    .refine((builds) => new Set(builds.map((b) => b.label.trim().toLowerCase())).size === builds.length, {
      message: "Each build needs a unique label."
    })
    .describe("One to five complete build proposals to validate side by side, each with a unique label.")),
  budget: z
    .number()
    .positive()
    .optional()
    .describe(
      "The user's whole-build budget in the active currency's standard major units (e.g. 45000). When given, each build gets code-computed budget figures (over_by/under_by) to quote instead of calculating them."
    )
});

export type ValidateBuildInput = z.infer<typeof validateBuildInputSchema>;

/**
 * The provider schema with each build's `parts` as a free-form object, its
 * categories named in the description. Under tool_choice "required" or a named
 * tool, NIM (and llama.cpp) generate arguments from a grammar that fixes the
 * key order to the schema's (cpu before gpu), so Lightning, writing the GPU
 * first as the system prompt's cascade orders it, could not add the CPU after
 * it: every r35 gaming failure. Validation still checks every part.
 */
export function freeOrderParts(jsonSchema: Record<string, unknown>): Record<string, unknown> {
  type Parts = { type?: string; description?: string; properties?: Record<string, unknown>; additionalProperties?: unknown };
  const out = structuredClone(jsonSchema) as { properties?: { builds?: { items?: { properties?: { parts?: Parts } } } } };
  const props = out.properties?.builds?.items?.properties;
  const storage = props?.parts?.properties?.storage;
  if (!props?.parts || !storage) return jsonSchema;
  // Storage's schema (a part or a list of parts) covers every slot's value. A
  // bare {"type":"object"} made NIM's grammar emit an empty object.
  props.parts = {
    type: "object",
    additionalProperties: storage,
    description: `${props.parts.description ?? ""} Keys, in any order: cpu, gpu, motherboard, ram, storage (one part or a list), psu, case, cooler.`.trim()
  };
  return out as Record<string, unknown>;
}

/** True for a part entry that names nothing: null, "", or an object without product_id, key or name. */
function isEmptyPart(part: unknown): boolean {
  if (part === null || part === undefined) return true;
  if (typeof part === "string") return part.trim() === "";
  if (Array.isArray(part)) return part.every(isEmptyPart);
  if (typeof part !== "object") return false;
  const p = part as { product_id?: unknown; key?: unknown; name?: unknown };
  return ![p.product_id, p.key, p.name].some((v) => typeof v === "string" && v.trim() !== "");
}

/**
 * True for a GPU entry that stands for the CPU's own graphics rather than a
 * card: no product_id and a name like "Integrated Radeon Graphics (no discrete
 * GPU)". Lightning sent one marked owned for a 5600G build (r11 hinglish).
 */
function isIntegratedGraphicsPlaceholder(part: unknown): boolean {
  const entry = part as { product_id?: unknown; name?: unknown } | null;
  const name = typeof part === "string" ? part : entry?.product_id ? undefined : entry?.name;
  return typeof name === "string" && /\b(integrated|onboard|on-board|igpu)\b|\bno (discrete|dedicated)\b/i.test(name);
}

/**
 * True for a cooler entry that stands for the CPU's boxed cooler rather than a
 * listing: no product_id, not owned, and a name like "Wraith Stealth (included
 * with Ryzen 5 5600G)". Lightning passed these as parts to buy (r12 local-ai,
 * aaa), which made the build unpresentable.
 */
function isStockCoolerPlaceholder(part: unknown): boolean {
  const entry = part as { product_id?: unknown; name?: unknown; owned?: unknown } | null;
  const name = typeof part === "string" ? part : entry?.product_id || entry?.owned === true ? undefined : entry?.name;
  return typeof name === "string" && /\b(stock|included|bundled|in[- ]box|boxed|wraith)\b/i.test(name);
}

/** Part keys models use for a category, after lowercasing and turning spaces and hyphens into underscores. */
const PART_KEY_ALIASES: Record<string, string> = {
  processor: "cpu",
  graphics: "gpu", graphics_card: "gpu", video_card: "gpu",
  mainboard: "motherboard", mobo: "motherboard", board: "motherboard",
  memory: "ram",
  ssd: "storage", hdd: "storage", drive: "storage",
  power_supply: "psu",
  cabinet: "case", chassis: "case",
  cpu_cooler: "cooler"
};

/** The category a part key names: the key itself, normalized, or the category it is an alias of. */
function partCategory(key: string): string {
  const normalized = key.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return PART_KEY_ALIASES[normalized] ?? normalized;
}

/**
 * Cleans each build's parts before validation. Keys are mapped to their
 * category ("Processor" -> cpu, "mainboard" -> motherboard): providers are sent
 * parts with free key names (see freeOrderParts), and the schema rejects any
 * key left unknown rather than dropping that part. A key whose category is
 * already taken stays as written, so it is rejected too. Drops entries that
 * name nothing (Lightning sent `"cooler":{}` for "no cooler"), GPU entries
 * standing for integrated graphics and cooler entries standing for a boxed
 * cooler, so they read as an absent part instead of failing the whole call,
 * counting as an owned card or blocking presentation.
 */
export function normalizeParts(input: Record<string, unknown>): Record<string, unknown> {
  const builds = typeof input.builds === "string" ? (() => { try { return JSON.parse(input.builds as string) as unknown; } catch { return leadingJsonValue(input.builds as string) ?? input.builds; } })() : input.builds;
  if (!Array.isArray(builds)) return input;
  return {
    ...input,
    builds: builds.map((build) => {
      const parts = (build as { parts?: unknown } | null)?.parts;
      if (!parts || typeof parts !== "object" || Array.isArray(parts)) return build;
      // Keys already naming their category first, so an alias never displaces one.
      const entries = Object.entries(parts).sort(([a], [b]) => Number(a !== partCategory(a)) - Number(b !== partCategory(b)));
      const keyed: Record<string, unknown> = {};
      for (const [key, part] of entries) {
        const category = partCategory(key);
        keyed[category in keyed ? key : category] = part;
      }
      return { ...(build as object), parts: Object.fromEntries(Object.entries(keyed).filter(([category, part]) => !isEmptyPart(part) && !(category === "gpu" && isIntegratedGraphicsPlaceholder(part)) && !(category === "cooler" && isStockCoolerPlaceholder(part)))) };
    })
  };
}

/** Ends a rejected validate_build call's error, so the model can fix the call instead of dropping `builds`. */
export const VALIDATE_BUILD_INPUT_HINT =
  'Pass builds as a JSON array (not a string) of 1 to 5 objects, each with a unique label and parts holding every part of that build. Example: {"budget":45000,"builds":[{"label":"Within budget","parts":{"cpu":{"product_id":"da6670a41d"},"motherboard":{"product_id":"3a1ade8a84"},"ram":{"product_id":"245608e19e"},"storage":{"product_id":"d5ac436749"},"psu":{"product_id":"cfcdeeb795"},"case":{"product_id":"c2e05370d9"}}}]}';
