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
import {
  benchmarkScore,
  loadBenchmarks,
  PERFORMANCE_METRICS,
  type BenchmarkDataset,
  type PerformanceMetric,
  type ScoredCategory
} from "@/lib/benchmarks";
import { formatPrice, ignoredFieldsNote, lenientToolSchema, parsedJson, splitUnknownFields } from "./lenient-input";

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
  performance: z
    .enum(PERFORMANCE_METRICS)
    .optional()
    .describe("Rank gpu or cpu models by benchmark score for this workload. 'rendering' is Blender 3D rendering speed: never use it to judge gaming."),
  model_ids: parsedJson(z.array(z.string()).min(2).max(5))
    .optional()
    .describe("Compare only these 2-5 finalists: model_id values from an earlier list_models result."),
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
  /** Benchmark datasets to rank with; defaults to data/benchmarks (tests pass fixtures). */
  benchmarks?: readonly BenchmarkDataset[];
};

export const validListModelsFilters = Object.keys(listModelsInputSchema.shape);

export function createListModelsTool(
  scope: ListModelsScope,
  repository?: CatalogRepository
) {
  return tool({
    description:
      "Use list_models to discover and compare unique hardware component models, their key functional specifications, observed price ranges, and listing availability. Aggregates matching listings into unique models while distinguishing important hardware variants (such as VRAM or capacity variants). Useful for broad category exploration before drilling into specific retailer offers with search_products. Pass performance to rank GPUs or CPUs by benchmark score, and model_ids to compare shortlisted finalists.",
    inputSchema: lenientToolSchema(listModelsInputSchema, "list_models"),
    execute: async (input) => listModels(input, scope, repository ?? scope.repository)
  });
}

/** Benchmark figures added to each model when `performance` is set; null when the model has no score. */
export type ModelPerf = {
  /** Dataset index: the category baseline scores 100 */
  score: number;
  /** 100 * (score / leader score - 1): 0 for the leader, negative for the rest */
  vs_leader_pct: number;
  /** Score per 1,000 units of the local currency at the model's lowest price */
  per_1k: number | null;
};

/** Provenance and coverage for a ranked list, given once per result. */
export type PerfInfo = {
  metric: PerformanceMetric;
  dataset: string;
  source: string;
  baseline: string | null;
  leader: string | null;
  /** Counted over every matching model, before the limit */
  scored: number;
  unscored: number;
  note: string;
};

type RankedModelItem = ComponentModelItem & { perf?: ModelPerf | null };

/** list_models output plus tool-level extras (see SearchProductsToolResult). */
export type ListModelsToolResult = Omit<ListModelsResult, "models"> & {
  models: Array<Omit<ComponentModelItem, "registry_key"> & { perf?: ModelPerf | null }>;
  perf_info?: PerfInfo;
  nearest_match?: { model_id: string; name: string; price: number; listing_count: number };
  matches_without_price_limit?: number;
  ignored_fields?: string[];
};

/** Internal result: models still carry registry_key for benchmark lookups. */
type RunResult = Omit<ListModelsToolResult, "models"> & { models: RankedModelItem[] };

const PERF_NOTE = "Relative index (baseline = 100). Treat gaps under 10% as a tie.";
const RENDERING_NOTE = " Rendering scores are Blender 3D rendering speed and say nothing about gaming.";

/**
 * Adds each model's score, sorts scored models first (highest score; ties
 * keep price order) and unscored ones after in price order, and summarises
 * coverage. Callers pass every matching model so the leader and coverage
 * describe the whole set, then apply the limit.
 */
function rankByPerformance(
  models: ComponentModelItem[],
  dataset: BenchmarkDataset,
  category: ScoredCategory
): { models: RankedModelItem[]; info: PerfInfo } {
  const scored = models.map((model) => ({ model, score: benchmarkScore(dataset, category, model.registry_key) }));
  let leader: (typeof scored)[number] | undefined;
  for (const item of scored) {
    if (item.score !== undefined && (leader?.score === undefined || item.score > leader.score)) leader = item;
  }
  const leaderScore = leader?.score;
  const ranked = [...scored]
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1))
    .map(({ model, score }) => {
      const price = model.price_range.min;
      const perf: ModelPerf | null =
        score === undefined || leaderScore === undefined
          ? null
          : {
              score,
              vs_leader_pct: Math.round((score / leaderScore - 1) * 100),
              per_1k: typeof price === "number" && price > 0 ? Math.round((score * 1000 * 100) / price) / 100 : null
            };
      return { ...model, perf };
    });
  const scoredCount = scored.filter((item) => item.score !== undefined).length;
  return {
    models: ranked,
    info: {
      metric: dataset.metric,
      dataset: dataset.id,
      source: `${dataset.source.name} (${dataset.source.licence}), snapshot ${dataset.source.snapshot}`,
      baseline: dataset.baselines[category] ?? null,
      leader: leader?.model.model_id ?? null,
      scored: scoredCount,
      unscored: models.length - scoredCount,
      note: PERF_NOTE + (dataset.metric === "rendering" ? RENDERING_NOTE : "")
    }
  };
}

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
  const { models, ...rest } = await runListModels(input, scope, repository);
  // registry_key only serves benchmark lookups; it stays out of the tool output.
  const result: ListModelsToolResult = {
    models: models.map((model) => {
      const output = { ...model };
      delete output.registry_key;
      return output;
    }),
    ...rest
  };
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
): Promise<RunResult> {
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

  const { segment, interface: iface, min_wattage, performance, model_ids, ...rest } = input;

  // Direct callers skip schema parsing, so these two are checked against the schema here.
  let modelIds: string[] | undefined;
  if (model_ids !== undefined) {
    const parsed = listModelsInputSchema.shape.model_ids.safeParse(model_ids);
    if (!parsed.success || !parsed.data) {
      return emptyResult(scope, "Invalid model_ids: list 2 to 5 model_id values from an earlier list_models result.");
    }
    modelIds = parsed.data;
  }
  let dataset: BenchmarkDataset | undefined;
  if (performance !== undefined) {
    if (!listModelsInputSchema.shape.performance.safeParse(performance).success) {
      return emptyResult(scope, `Invalid performance value: use one of ${PERFORMANCE_METRICS.join(", ")}.`);
    }
    if (category !== "gpu" && category !== "cpu") {
      return emptyResult(scope, 'performance ranks GPUs or CPUs only: set category to "gpu" or "cpu".');
    }
    dataset = (scope.benchmarks ?? loadBenchmarks()).find((item) => item.metric === performance);
  }

  const repo = repository ?? scope.repository ?? getCatalogRepository();
  const repoInput: RepoListInput = {
    ...rest,
    ...(category !== undefined ? { category } : {}),
    modules,
    ...(modelIds ? { model_ids: modelIds } : {})
  };
  const toolFilters: ToolSideFilters = { segment, interface: iface, min_wattage };
  const hasToolFilters = segment !== undefined || iface !== undefined || min_wattage !== undefined;

  // rank = false keeps price order, for callers that want the cheapest model rather than the fastest.
  const run = async (overrides: Partial<RepoListInput> = {}, rank = true): Promise<RunResult> => {
    const rankWith = rank ? dataset : undefined;
    if (!hasToolFilters && !rankWith) return repo.listModels({ ...repoInput, ...overrides }, scope);
    // Tool-side filters and ranking run after aggregation, so fetch every model and apply the limit here.
    const all = await repo.listModels({ ...repoInput, ...overrides, limit: Number.MAX_SAFE_INTEGER }, scope);
    if (all.error) return all;
    const matching = all.models.filter((model) => matchesToolSideFilters(model, toolFilters));
    const ranking = rankWith ? rankByPerformance(matching, rankWith, category as ScoredCategory) : undefined;
    const limit = Math.max(1, Math.round(Number(overrides.limit ?? repoInput.limit ?? 20)) || 20);
    const models = (ranking?.models ?? matching).slice(0, limit);
    const truncated = matching.length > models.length;
    let hint = truncated
      ? `Showing ${models.length} of ${matching.length} matching models. Narrow results by category, price bounds, or specification filters.`
      : models.length === 0
        ? "No models found matching the specified criteria."
        : undefined;
    if (ranking && ranking.info.unscored > 0) {
      const gap =
        `${ranking.info.unscored} of ${matching.length} models have no ${ranking.info.metric} score and are listed after the scored ones; ` +
        "don't call the top scored model the fastest of them all.";
      hint = hint ? `${hint} ${gap}` : gap;
    }
    // The repository's hint described the unfiltered set, so it is replaced.
    return {
      ...all,
      models,
      total_matching_models: matching.length,
      returned_models: models.length,
      truncated,
      hint,
      ...(ranking ? { perf_info: ranking.info } : {})
    };
  };

  const result = await run();
  if (result.models.length === 0 && !result.error) await addNearestModel(result, repoInput, scope, run);
  // Small models sometimes pass search_products product ids here. A nearest match means the ids were fine.
  if (modelIds && result.models.length === 0 && !result.error && !result.nearest_match) {
    const note =
      "No models matched model_ids with these filters. model_ids takes model_id values from a list_models result, not product_id values from search_products.";
    result.hint = result.hint ? `${note} ${result.hint}` : note;
  }
  if (performance !== undefined && !dataset && !result.error) {
    const note = `No ${performance} benchmark data is installed, so models are in price order.`;
    result.hint = result.hint ? `${result.hint} ${note}` : note;
  }
  return result;
}

/**
 * Same zero-result recovery as search_products: re-run once without price
 * bounds (in stock only) and report the cheapest model and how many exist.
 */
async function addNearestModel(
  result: RunResult,
  input: RepoListInput,
  scope: ListModelsScope,
  run: (overrides?: Partial<RepoListInput>, rank?: boolean) => Promise<RunResult>
): Promise<void> {
  const { price_min: min, price_max: max } = input;
  if (min === undefined && max === undefined) return;
  if (min !== undefined && max !== undefined && min > max) return;

  const unbounded = await run({ price_min: undefined, price_max: undefined, in_stock: true }, false);
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
