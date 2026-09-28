import { tool } from "ai";
import { z } from "zod";
import {
  getCatalogRepository,
  type CatalogRepository,
  type CatalogScope,
  type ComponentModelItem,
  type ListModelsResult,
  type ListModelsInput as RepoListInput
} from "@/lib/catalog";
import { hasWattageConflict, type RegistrySpec } from "@/lib/registry";
import { formatPrice, ignoredFieldsNote, lenientToolSchema, splitUnknownFields } from "./lenient-input";

export const listModelsInputSchema = z.object({
  category: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.enum(["gpu", "cpu", "motherboard", "ram", "storage", "psu", "case", "cooler"]))
    .optional()
    .describe("Component category to list models for (gpu, cpu, motherboard, ram, storage, psu, case, cooler)."),
  price_min: z
    .number()
    .nonnegative()
    .optional()
    .describe("Minimum price in standard major units for the active currency (e.g. Rupees or Dollars)."),
  price_max: z
    .number()
    .nonnegative()
    .optional()
    .describe("Maximum price in standard major units for the active currency (e.g. Rupees or Dollars)."),
  socket: z
    .string()
    .optional()
    .describe("CPU or motherboard socket filter (e.g. AM5, LGA 1700)."),
  ddr: z
    .string()
    .trim()
    .toUpperCase()
    .pipe(z.enum(["DDR3", "DDR4", "DDR5"]))
    .optional()
    .describe("Memory generation filter (case-insensitive, e.g. ddr5)."),
  min_vram_gb: z
    .number()
    .nonnegative()
    .optional()
    .describe("Minimum GPU VRAM in GB."),
  min_capacity_gb: z
    .number()
    .nonnegative()
    .optional()
    .describe("Minimum storage or RAM capacity in GB."),
  modules: z
    .coerce
    .number()
    .int()
    .positive()
    .optional()
    .describe("RAM stick count filter, e.g. 2 for dual-channel kits. Resolved from registry modules or title patterns like '2x8GB'."),
  form_factor: z
    .string()
    .optional()
    .describe("Motherboard or case form factor filter (e.g. ATX, Mini-ITX)."),
  segment: z
    .enum(["gaming", "workstation", "display"])
    .optional()
    .describe("Registry-resolved GPU segment filter."),
  interface: z
    .enum(["nvme", "sata"])
    .optional()
    .describe("Storage interface filter: 'nvme' for fast M.2 NVMe SSDs, 'sata' for standard SATA SSDs/HDDs."),
  min_wattage: z
    .number()
    .nonnegative()
    .optional()
    .describe("Minimum registry-resolved power supply wattage in watts (e.g. 550, 650, 750, 850)."),
  in_stock: z
    .boolean()
    .default(true)
    .describe("Only include models with in-stock listings. Defaults to true."),
  limit: z
    .number()
    .int()
    .positive()
    .default(20)
    .describe("Maximum number of models to return. Defaults to 20.")
}).strict();

export type ListModelsInput = z.input<typeof listModelsInputSchema>;

export type ListModelsScope = CatalogScope & {
  repository?: CatalogRepository;
};

export const validListModelsFilters = Object.keys(listModelsInputSchema.shape);

export function createListModelsTool(
  scope: ListModelsScope,
  repository?: CatalogRepository
) {
  return tool({
    description:
      "Use list_models to discover and compare unique hardware component models, their key functional specifications, observed price ranges, and listing availability. Aggregates matching listings into unique models while distinguishing important hardware variants (such as VRAM or capacity variants). Useful for broad category exploration before drilling into specific retailer offers with search_products.",
    inputSchema: lenientToolSchema(listModelsInputSchema, "list_models"),
    execute: async (input) => listModels(input, scope, repository ?? scope.repository)
  });
}

/** list_models output plus tool-level extras (see SearchProductsToolResult). */
export type ListModelsToolResult = ListModelsResult & {
  nearest_match?: { model_id: string; name: string; price: number; listing_count: number };
  matches_without_price_limit?: number;
  ignored_fields?: string[];
};

type ToolSideFilters = Pick<ListModelsInput, "segment" | "interface" | "min_wattage">;

/**
 * Filters the repository's model aggregation does not apply, checked here
 * against each model's resolved specs with the same rules search_products uses.
 */
function matchesToolSideFilters(model: ComponentModelItem, filters: ToolSideFilters): boolean {
  const spec = (model.specs ?? {}) as RegistrySpec & Record<string, unknown>;
  if (filters.segment && spec.segment !== filters.segment) return false;
  if (filters.interface && spec.interface !== filters.interface) return false;
  if (filters.min_wattage !== undefined) {
    if (hasWattageConflict(spec)) return false;
    if (Number(spec.wattage ?? spec.wattage_w ?? -1) < filters.min_wattage) return false;
  }
  return true;
}

function emptyResult(scope: ListModelsScope, error: string): ListModelsResult {
  return {
    models: [],
    total_matching_models: 0,
    returned_models: 0,
    truncated: false,
    scope: { country_code: scope?.countryCode ?? "US", currency: scope?.currency ?? "USD" },
    error
  };
}

/**
 * list_models entry point for the chat tool and direct callers. Unknown
 * fields are dropped and reported (ignored_fields + a hint line) rather than
 * failing the call.
 */
export async function listModels(
  rawInput: ListModelsInput,
  scope: ListModelsScope,
  repository?: CatalogRepository
): Promise<ListModelsToolResult> {
  const { known: input, ignored } = splitUnknownFields(rawInput, validListModelsFilters);
  const result: ListModelsToolResult = await runListModels(input, scope, repository);
  if (ignored.length > 0) {
    const note = ignoredFieldsNote(ignored, validListModelsFilters);
    result.ignored_fields = ignored;
    result.hint = result.hint ? `${note} ${result.hint}` : note;
  }
  return result;
}

async function runListModels(
  input: ListModelsInput,
  scope: ListModelsScope,
  repository?: CatalogRepository
): Promise<ListModelsToolResult> {
  const category =
    typeof input.category === "string" && input.category.trim()
      ? (input.category.trim().toLowerCase() as ListModelsInput["category"])
      : undefined;

  // Coerce `modules` for direct (unparsed) calls; schema-parsed calls arrive numeric.
  let modules: number | undefined;
  if (input.modules !== undefined) {
    const coerced = typeof input.modules === "string" ? Number(input.modules.trim()) : Number(input.modules);
    if (!Number.isInteger(coerced) || coerced <= 0) {
      return emptyResult(
        scope,
        `Invalid modules filter: expected a positive integer stick count (e.g. 2 for dual-channel kits). Valid filters: ${validListModelsFilters.join(", ")}.`
      );
    }
    modules = coerced;
  }

  const repo = repository ?? scope.repository ?? getCatalogRepository();
  const { segment, interface: iface, min_wattage, ...rest } = input;
  const repoInput: RepoListInput = { ...rest, ...(category !== undefined ? { category } : {}), modules };
  const toolFilters: ToolSideFilters = { segment, interface: iface, min_wattage };
  const hasToolFilters = segment !== undefined || iface !== undefined || min_wattage !== undefined;

  const run = async (overrides: Partial<RepoListInput> = {}): Promise<ListModelsResult> => {
    if (!hasToolFilters) return repo.listModels({ ...repoInput, ...overrides }, scope);
    // Tool-side filters run after aggregation, so fetch every model and apply the limit here.
    const all = await repo.listModels({ ...repoInput, ...overrides, limit: Number.MAX_SAFE_INTEGER }, scope);
    if (all.error) return all;
    const matching = all.models.filter((model) => matchesToolSideFilters(model, toolFilters));
    const limit = Math.max(1, Math.round(Number(overrides.limit ?? repoInput.limit ?? 20)) || 20);
    const models = matching.slice(0, limit);
    const truncated = matching.length > models.length;
    const hint = truncated
      ? `Showing ${models.length} of ${matching.length} matching models. Narrow results by category, price bounds, or specification filters.`
      : models.length === 0
        ? "No models found matching the specified criteria."
        : undefined;
    // The repository's hint described the unfiltered set, so it is replaced.
    return { ...all, models, total_matching_models: matching.length, returned_models: models.length, truncated, hint };
  };

  const result: ListModelsToolResult = await run();
  if (result.models.length === 0 && !result.error) await addNearestModel(result, repoInput, scope, run);
  return result;
}

/**
 * Same zero-result recovery as search_products: re-run once without price
 * bounds (in stock only) and report the cheapest model and how many exist.
 */
async function addNearestModel(
  result: ListModelsToolResult,
  input: RepoListInput,
  scope: ListModelsScope,
  run: (overrides?: Partial<RepoListInput>) => Promise<ListModelsResult>
): Promise<void> {
  const { price_min: min, price_max: max } = input;
  if (min === undefined && max === undefined) return;
  if (min !== undefined && max !== undefined && min > max) return;

  const unbounded = await run({ price_min: undefined, price_max: undefined, in_stock: true });
  const cheapest = unbounded.models.find((model) => typeof model.price_range.min === "number");
  if (!cheapest || typeof cheapest.price_range.min !== "number") return;

  const price = cheapest.price_range.min;
  const count = unbounded.total_matching_models;
  const fmt = (n: number) => formatPrice(n, unbounded.scope?.currency ?? scope.currency ?? "USD");
  const band =
    min !== undefined && max !== undefined
      ? `between ${fmt(min)} and ${fmt(max)}`
      : max !== undefined
        ? `at or under ${fmt(max)}`
        : `at or above ${fmt(min as number)}`;

  result.nearest_match = { model_id: cheapest.model_id, name: cheapest.name, price, listing_count: cheapest.listing_count };
  result.matches_without_price_limit = count;
  result.hint =
    `No models ${band}. Cheapest in-stock model for these filters: ${cheapest.name} from ${fmt(price)} ` +
    `(${count} model${count === 1 ? "" : "s"} without the price limit).`;
}
