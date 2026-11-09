import { type OnFinishEvent, type OnStepFinishEvent, type ToolSet, type ModelMessage, type UIMessage, convertToModelMessages, isStepCount } from "ai";
import type { AppConfig } from "@/types";
import { streamTextWithFallback } from "./client";
import { rememberFoundParts } from "./found-parts";
import { appendChatLog } from "@/lib/logger";
import { createToolRegistry, getCatalog } from "@/lib/tools";
import { FAR_OVER_BUDGET } from "@/lib/tools/validate-build";
import { presentRefusal } from "@/lib/tools/present-build";
import type { CatalogRepository, GetCatalogResult } from "@/lib/catalog";
import { getPersonality } from "./personalities";
import { getSession, saveCompactContext, setSessionCompacting, type StoredCompactContext } from "@/lib/sessions";
import { type ChatMessage, capMessages, deriveBuildState, latestValidationSnapshots } from "./messages";
import {
  getModelContextLimit,
  shouldTriggerCompaction,
  measureToolDefinitionsTokens,
  calculateStepTokens
} from "./context-budget";
import { compactConversation } from "./compaction";
import { fullSnapshotsOf } from "./validation-snapshots";
import type { BuildSnapshot } from "../catalog/build-snapshot";
import { isHostedDemo } from "../config/deployment";
import { record as recordAnalytics } from "../analytics/store";
function isHosted(): boolean {
  return isHostedDemo();
}

export type { ChatMessage };

/**
 * Formats a compact catalog summary block for the system prompt.
 * Contains categories with count 0 or more, price ranges, and accessory subcategories.
 */
export function formatCatalogSummary(catalog: GetCatalogResult): string {
  const currency = catalog.scope.currency;
  const currencySymbol =
    currency === "INR" ? "₹" : currency === "USD" ? "$" : currency === "EUR" ? "€" : currency === "GBP" ? "£" : `${currency} `;

  const lines = catalog.categories.map((cat) => {
    const priceRange =
      cat.count > 0 && cat.price_min != null && cat.price_max != null
        ? `${currencySymbol}${cat.price_min}–${currencySymbol}${cat.price_max}`
        : "none";
    let line = `- ${cat.category}: ${cat.count} items (${cat.in_stock_count} in stock), price: ${priceRange}`;
    if (cat.subcategories && Object.keys(cat.subcategories).length > 0) {
      const subs = Object.entries(cat.subcategories)
        .map(([subName, sub]) => {
          const subRange =
            sub.price_min != null && sub.price_max != null
              ? ` (${currencySymbol}${sub.price_min}–${currencySymbol}${sub.price_max})`
              : "";
          return `${subName}: ${sub.count}${subRange}`;
        })
        .join(", ");
      line += ` [accessories: ${subs}]`;
    }
    return line;
  });

  return `Catalog summary (${catalog.scope.country_code}, ${currency}):\n${lines.join("\n")}`;
}

/**
 * Catalog summary for the system prompt. A catalog outage must not take the
 * whole chat down, so a failed lookup returns an empty block and the model
 * still has search_products to discover what exists.
 */
export async function loadCatalogSummary(config: AppConfig, repository?: CatalogRepository): Promise<string> {
  try {
    const catalog = await getCatalog({ dbPath: config.dbPath, countryCode: config.countryCode, currency: config.currency }, repository);
    return formatCatalogSummary(catalog);
  } catch (error) {
    console.warn("Catalog summary unavailable:", error instanceof Error ? error.message : String(error));
    return "";
  }
}

/**
 * How the sage decides between one build and a comparison set. This is guidance,
 * not a rule the model must satisfy — an underspecified brief is answered with
 * contrasting builds because concrete options are a faster clarifying question
 * than an intake form, while a specific brief still allows sensible alternatives
 * alongside the requested build. One build remains fine when alternatives add
 * no value.
 */
const BRIEF_STRATEGY_LINES = [
  "Answer shape: Usually offer 3 builds, up to 5 when they differ meaningfully; 1 is fine when alternatives add nothing. List the recommended build first.",
  "Lead with a one-line summary of how the builds differ, state which one is your recommended choice and why. Present useful candidates once their tradeoffs are clear, instead of repeatedly reconsidering equivalent choices. Validate each proposed selection before calling present_build. Budget allocation is a heuristic, not a quota: prioritise the parts that matter for the user's stated workload, allocate remaining funds across the platform, and defer to in-stock catalog data."
];

export function buildSystemPrompt(
  config: AppConfig,
  catalogSummary?: string | GetCatalogResult
): string {
  const personality = getPersonality(config.personality);
  const researchEnabled = config.tier2Enabled && config.search.provider !== "none";
  const isINR = config.currency === "INR";
  const currencySymbol = isINR ? "₹" : config.currency === "USD" ? "$" : config.currency === "EUR" ? "€" : config.currency === "GBP" ? "£" : `${config.currency} `;

  const catalogBlock =
    typeof catalogSummary === "object" && catalogSummary !== null
      ? formatCatalogSummary(catalogSummary)
      : typeof catalogSummary === "string"
        ? catalogSummary
        : "";

  return [
    "You are PCBuildSage, a PC build consultant powered by local product data and deterministic compatibility checks.",
    "Component cascade: GPU -> CPU -> Motherboard -> RAM -> Storage -> PSU -> Case -> Cooler. You may deviate when the user provides owned parts or hard constraints.",
    "A gaming build gets a dedicated GPU, its largest part of the budget (often 35-45%); fit the rest around it with cost-effective parts (a 6-core CPU without integrated graphics, a dual-channel 16 GB kit, a 500 GB-1 TB SSD). Rely on integrated graphics for gaming only when the user asks for no graphics card or none fits the budget.",
    'Parts the user already owns: pass each to validate_build as {"name":"RTX 3070","owned":true} so PSU wattage and clearance are checked against it. It costs 0 and is not part of the price; search and buy only the rest. Mark a part owned only when the user says they have it. A build that uses the CPU\'s integrated graphics leaves gpu out. Every part you buy goes to validate_build as its product_id from search_products; a name alone can\'t be bought.',
    "Finish every build request with present_build. Pick the parts yourself and offer the choices as separate builds; never stop to ask the user to choose a part or a build. Ask a question only when the request has no budget or no use.",
    `Active scope: country ${config.countryCode}, currency ${config.currency}. All prices returned by tools are standard major currency values (e.g. standard Rupees or Dollars). Present them exactly as returned by the tools without division or scale adjustment.`,
    catalogBlock,
    ...BRIEF_STRATEGY_LINES,
    "When useful, call suggest_followups with short, relevant user prompts about unanswered next steps; omit it when none would help.",
    personality ? `Personality prompt: ${personality.prompt}` : "",
    `Turn budget: you get at most ${MAX_STEPS} tool steps per reply. Search independent categories in parallel (several search_products calls in one step), never repeat a search you already ran, and call validate_build once you have a candidate for every part, by about step ${VALIDATE_BY_STEP}, leaving the remaining steps to fix what it rejects.`,
    "For broad build requests: list_models → search_products. Shortlist a few suitable models before looking through their offers. For an exact product or a straightforward filtered purchase request, skip model discovery when direct search is sufficient.",
    "Search strategy: Respect explicit requirements such as storage capacity, RAM capacity, owned parts, and platform. Prioritize components for the user's workload and rebalance allocations using catalog prices. Search cost-effective supporting parts with `order: 'asc'`; use capacity, interface, wattage, and compatibility filters appropriate to the build.",
    "When searching for cases for a selected GPU and cooler, use `min_gpu_clearance_mm` and `min_cooler_clearance_mm`.",
    `CPU Cooler Guidance: When a CPU package includes a stock cooler, show it as included with the CPU at no additional cost (${currencySymbol}0). When cooler inclusion is unknown, keep a separate cooler in the build and explain: 'Check whether this CPU package includes a stock cooler. If included and suitable for your use, you can skip the [price] cooler.'`,
    "Recommendations can directly state 'my recommended choice' and explain the budget, requirements, and documented specifications behind it (e.g. 'I chose this GPU because it fits the budget and leaves room for the other parts').",
    "Explain recommendations using available evidence. Don’t claim 'fastest', 'strongest', or 'best-performing' without supporting performance data. When benchmarks are available, limit comparisons to the models and workload covered.",
    "RAM Configuration: Prioritize dual-channel memory kits (e.g. 2×8GB or 2×16GB) over single-stick (1×16GB) configurations to prevent CPU memory bandwidth bottlenecks. If validate_build returns a non-blocking advisory, note it constructively in your explanation.",
    "Feature grounding: Do not assert specific proprietary feature versions (e.g., DLSS 3 Frame Gen vs DLSS 2, FSR 3, PCIe 5.0) or socket upgrade longevity unless explicitly supported by the product specs or verified platform data. Stick strictly to facts returned by tools.",
    `Budget guidance: The recommended build may exceed the user's stated budget or strict cap by a small margin (about 2–3%) only when it buys a clear value jump. Example: a 4060 build at ${currencySymbol}45,000 versus a 4070 build at ${currencySymbol}46,000. Always state the exact extra amount, and never describe an over-budget build as within budget. Whenever a build within the cap exists, include one and label it "Within budget". If none exists, say so instead of inventing one.`,
    isINR
      ? "Budget example: For a strict ₹45,000 budget, you can present a within-budget option at ₹45,000 (labeled 'Within budget') alongside a recommended option at ₹46,000 (labeled 'Small upgrade' or 'Recommended', ₹1,000 extra / ~2.2% over cap, explaining the clear value jump). These are illustrative totals, not product prices."
      : `Budget example: For a strict ${currencySymbol}45,000 budget, you can present a within-budget option at ${currencySymbol}45,000 (labeled 'Within budget') alongside a recommended option at ${currencySymbol}46,000 (labeled 'Small upgrade' or 'Recommended', ${currencySymbol}1,000 extra / ~2.2% over cap, explaining the clear value jump). These are illustrative totals, not product prices.`,
    "When search_products returns category_total: 0, that component category has no catalog data: do not retry it with different prices or filters. When it returns category_price_range, nearest_above, or nearest_below (e.g. when market prices are higher than expected and price_max was set too low), use those boundary hints to immediately correct your price bounds into the available price range instead of guessing or inventing prices.",
    "search_products returns in-stock listings only unless you pass in_stock: false. Build exclusively from in-stock results; a row the last scrape retired is a listing that no longer exists, not a cheaper option. Pass in_stock: false only when the user asks about a specific part that has disappeared, and say plainly that it is no longer listed. When a result set comes back with in_stock_total: 0, the catalog has that category but nothing purchasable: report that rather than falling back to a retired listing, and note that a fresh scrape may restore it.",
    "Validate each proposed build with validate_build before presenting it. Check earlier when compatibility affects a component choice. Always use the snapshot total from validate_build when checking budget or presenting the build, rather than calculating or guessing your own total. When the user states a budget, pass it as `budget` to validate_build and quote its budget.over_by / under_by, vs_cheapest.more_by and price_summary figures instead of calculating prices or differences yourself. Product IDs are 40-char hashes: search_products shows the first 10 chars, and validate_build/present_build accept any unique prefix of at least 8 chars.",
    "Treat initial configurations as tentative until catalog prices confirm the total.",
    "Call `present_build` to present proposed PC builds so the interactive Build Card renders with component tables, retailer links, and verified pricing. Finalize component choices and run compatibility checks before calling present_build. Pass labels matching validate_build from this turn; product_ids are optional prefixes defaulting to the validated snapshot. Include all intended alternatives together in one call with short labels such as 'Within budget' and 'Small upgrade'. If a later correction is needed, present a revised version and explain what changed. Never output raw component markdown tables or part price lists in your text message. Use your text response exclusively to explain component rationale, expected performance for that workload, tradeoffs, and upgrade paths.",
    "If a build is invalid or needs research, run the tools yourself to investigate and resolve it, or explain the compatibility issues clearly to the user. If a component category is unavailable, state this clearly and explain why.",
    researchEnabled
      ? "When validate_build returns needs_research, call consult in component_specs mode for that part, then rerun validate_build. Never guess specs. A part whose specs are unsourced placeholders is treated as unresearched: research it, never reason from its numbers."
      : "Web research (consult tool) is disabled. When validate_build returns needs_research or specs are unknown, do not guess or invent specs. Rely strictly on catalog data, report any spec gaps clearly to the user, and present builds based on verified catalog specifications.",
    "validate_build returns skipped_checks: the compatibility rules it could not run because the build has no part in that slot. Never present a build as verified on a rule that was skipped. State the gap plainly instead, for example 'PSU headroom is not verified - no PSU in the catalog to check against.'",
    researchEnabled ? "Disclose researched specs as not community-verified. Tier 2 build_audit is advisory-only and can never clear a Tier 1 blocking failure." : "",
    "Computed-requirement rule: For any component category absent from the catalog (count 0 in the catalog summary), do not recommend a specific product brand, SKU, or price. Instead, emit only a derived specification based on other components in the build (e.g., 'PSU: 650W, 80+ Bronze, ATX — derived from components'). Never invent a brand, model, SKU, or price for unavailable categories.",
    researchEnabled
      ? "Never make unsourced recency or superiority claims (such as calling a card 'AMD's newest mid-tier GPU' or claiming one CPU is faster than another without evidence). If you want to make such assertions, route them through the consult tool first to obtain grounding facts, or omit them entirely."
      : "Never make unsourced recency or superiority claims without factual backing from the catalog. Omit such assertions entirely.",
    "Suggest accessories (such as external storage, pen drives, etc.) only when the user explicitly requests them. You may include at most one brief, non-blocking offer line suggesting relevant accessories after presenting the build.",
    researchEnabled
      ? (config.freeformConsultEnabled
          ? "The consult tool is available for optional web research on component specs or hardware questions when needed. Do not call consult after presenting a finalized build."
          : "The consult tool is available for optional web research on component specs or hardware audits when needed (freeform consultation is disabled). Do not call consult after presenting a finalized build.")
      : "",
    `Trust catalog data: Always trust pricing and product data returned by search_products because local catalog snapshots are authoritative. Do not assume database errors or scale prices to match prior assumptions of typical hardware costs. E.g., if a CPU is returned as ${isINR ? "₹8,640" : `${currencySymbol}120`}, present it exactly as ${isINR ? "₹8,640" : `${currencySymbol}120`}. Never second-guess or adjust catalog data.`
  ]
    .filter(Boolean)
    .join("\n");
}

export function getSnapshotFromOutput(output: unknown): BuildSnapshot | undefined {
  if (!output || typeof output !== "object") return undefined;
  const obj = output as Record<string, unknown>;
  const val = "value" in obj && obj.value && typeof obj.value === "object" ? (obj.value as Record<string, unknown>) : obj;
  if ("snapshot" in val && val.snapshot && typeof val.snapshot === "object") {
    return val.snapshot as BuildSnapshot;
  }
  return undefined;
}

/** Agentic turn budget: the model gets this many tool steps before it must wrap up. */
const MAX_STEPS = 25;
/** From this step, late-turn tool use narrows to validation and presentation (research closes). */
const PRESENT_FORCE_START_STEP = 20;
/** 0-indexed stepNumber of the final allowed step. */
const FINAL_STEP = MAX_STEPS - 1;

type StepToolCallLike = {
  toolName?: unknown;
  toolCallId?: string;
  input?: unknown;
};

type StepToolResultLike = {
  toolName?: unknown;
  toolCallId?: string;
  output?: unknown;
  result?: unknown;
  error?: unknown;
};

type StepLike = {
  text?: string | null;
  toolCalls?: StepToolCallLike[] | null;
  toolResults?: StepToolResultLike[] | null;
};

function unwrapToolOutput(output: unknown): unknown {
  if (output && typeof output === "object" && "value" in output) {
    return (output as { value: unknown }).value;
  }
  // MCP-backed tools (voice route) return the full CallToolResult; the domain
  // result lives in structuredContent. Chat tools never emit this shape, so
  // the default web-chat path is behaviour-identical.
  if (isCallToolResultShape(output)) {
    return output.structuredContent;
  }
  return output;
}

function isCallToolResultShape(output: unknown): output is { structuredContent: unknown } {
  if (!output || typeof output !== "object") return false;
  const obj = output as Record<string, unknown>;
  return (
    Array.isArray(obj.content) &&
    obj.structuredContent !== null &&
    typeof obj.structuredContent === "object"
  );
}

/**
 * True when a validate_build result holds a build worth presenting: valid,
 * no blocking issues, every part purchasable, and a whole build (CPU and motherboard at least), not
 * a spot check such as "will this GPU fit my case?". Invalid results and
 * spot checks leave the model free to answer in text.
 */
function isPresentableValidationOutput(output: unknown): boolean {
  const val = unwrapToolOutput(output);
  if (!val || typeof val !== "object") return false;
  const obj = val as Record<string, unknown>;
  const entries = obj.builds && typeof obj.builds === "object" ? Object.values(obj.builds) : [obj];
  return entries.some(isPresentableBuild);
}

function isPresentableBuild(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  const build = entry as { missing_parts?: unknown; snapshot?: { components?: unknown } };
  // present_build refuses these, so forcing it would only waste the last step.
  if (presentRefusal("", entry as never)) return false;
  // Forcing is for whole builds: a CPU and motherboard, nothing core missing.
  if (Array.isArray(build.missing_parts) && build.missing_parts.length > 0) return false;
  const components = Array.isArray(build.snapshot?.components) ? build.snapshot.components : [];
  const categories = new Set(components.map((c) => (c as { category?: unknown } | null)?.category));
  return categories.has("cpu") && categories.has("motherboard");
}

/**
 * True once a validate_build call in the current turn returned a presentable build.
 * Matches results by tool name, falling back to the tool-call IDs issued
 * earlier in the turn for providers that omit names on results.
 */
export function hasSuccessfulValidation(steps: StepLike[] | undefined | null): boolean {
  const validateCallIds = new Set<string>();
  for (const step of steps ?? []) {
    for (const call of step?.toolCalls ?? []) {
      if (call?.toolName === "validate_build" && typeof call.toolCallId === "string") {
        validateCallIds.add(call.toolCallId);
      }
    }
  }
  for (const step of steps ?? []) {
    for (const res of step?.toolResults ?? []) {
      if (!res) continue;
      const nameMatch = res.toolName === "validate_build";
      const idMatch = typeof res.toolCallId === "string" && validateCallIds.has(res.toolCallId);
      if (!nameMatch && !idMatch) continue;
      if (res.error != null) continue;
      const raw = res.output ?? res.result;
      if (isPresentableValidationOutput(raw)) return true;
    }
  }
  return false;
}

/**
 * True when a present_build call's result actually presented a build. A call
 * the tool rejected (`presented: false`) or that errored (no tool-result at
 * all) shows the user nothing, so it must not count as presented.
 */
function isPresentedResult(res: StepToolResultLike | null | undefined): boolean {
  if (!res || res.error != null) return false;
  const out = unwrapToolOutput(res.output ?? res.result);
  if (!out || typeof out !== "object") return false;
  return (out as { presented?: unknown }).presented !== false;
}

/** Tool-call IDs (and, for nameless results, the call names) of a turn. */
function callNamesById(steps: StepLike[] | undefined | null): Map<string, unknown> {
  const names = new Map<string, unknown>();
  for (const step of steps ?? []) {
    for (const call of step?.toolCalls ?? []) {
      if (typeof call?.toolCallId === "string") names.set(call.toolCallId, call.toolName);
    }
  }
  return names;
}

function isPresentResult(res: StepToolResultLike | null | undefined, names: Map<string, unknown>): boolean {
  if (!res) return false;
  if (res.toolName === "present_build") return true;
  return res.toolName == null && typeof res.toolCallId === "string" && names.get(res.toolCallId) === "present_build";
}

/** True once present_build has successfully presented a build in the current turn. */
export function hasPresentedBuild(steps: StepLike[] | undefined | null): boolean {
  const names = callNamesById(steps);
  return (steps ?? []).some((step) =>
    (step?.toolResults ?? []).some((res) => isPresentResult(res, names) && isPresentedResult(res))
  );
}

/** True once suggest_followups has been called in the current turn. */
export function hasFollowupsCall(steps: StepLike[] | undefined | null): boolean {
  return (steps ?? []).some((step) =>
    (step?.toolCalls ?? []).some((call) => call?.toolName === "suggest_followups")
  );
}

/**
 * End the turn after suggest_followups once the text reply is written,
 * without breaking force-present: a validated-but-unpresented turn keeps
 * going so present_build can still be forced.
 *
 * Only stops when (a) the turn already has non-empty assistant text, so the
 * user never gets chips without a reply, and (b) suggest_followups is in the
 * latest step and every other call in that step needs no model follow-up
 * (only a successful present_build qualifies): a parallel search_products or
 * a rejected present_build has results the model still has to read.
 */
export function stopAfterFollowups({ steps }: { steps: StepLike[] }): boolean {
  if (!hasFollowupsCall(steps)) return false;
  if (buildPending(steps)) return false;
  if (!(steps ?? []).some((step) => typeof step?.text === "string" && step.text.trim().length > 0)) return false;
  const last = steps.at(-1);
  const calls = last?.toolCalls ?? [];
  if (!calls.some((call) => call?.toolName === "suggest_followups")) return false;
  const names = callNamesById(steps);
  const resultsById = new Map((last?.toolResults ?? []).map((res) => [res?.toolCallId, res]));
  return calls.every((call) => {
    if (call?.toolName === "suggest_followups") return true;
    if (call?.toolName !== "present_build") return false;
    const res = resultsById.get(call.toolCallId);
    return isPresentResult(res, names) && isPresentedResult(res);
  });
}

/**
 * Per-step tool forcing so a validated turn can't end on a text reply:
 * after validate_build returns a presentable build the model must call another tool
 * (toolChoice "required"), late-turn steps are restricted to validate_build
 * and present_build, and the final step, or the step after a validate_build
 * call repeating an earlier one (repeatedValidation), forces present_build by name.
 *
 * When nothing is validated by PRESENT_FORCE_START_STEP, research closes
 * (see isResearchClosed / gateResearchTools) and each step is forced to
 * validate_build with what the model has; the final step allows text only so
 * the turn never ends empty.
 *
 * Before that, a turn that searched every core category by VALIDATE_FIRST_STEP
 * without calling validate_build is forced to call it (mustCallValidateFirst),
 * and a turn that is building (isBuildingTurn) must call a tool each step, so
 * it can't stop on a text plan before presenting.
 *
 * Returns {} (auto) otherwise when nothing is validated yet or after
 * presenting, so the model can ask, research freely and explain afterwards.
 */
export function forcePresentDirectives(
  steps: StepLike[] | undefined | null,
  stepNumber: number
): { activeTools?: string[]; toolChoice?: "required" | "none" | { type: "tool"; toolName: string } } {
  const validated = hasSuccessfulValidation(steps);
  if (hasPresentedBuild(steps)) return {};
  if (validated && (stepNumber >= FINAL_STEP || repeatedValidation(steps))) {
    return { activeTools: ["present_build"], toolChoice: { type: "tool", toolName: "present_build" } };
  }
  if (stepNumber >= PRESENT_FORCE_START_STEP) {
    if (validated) return { activeTools: ["validate_build", "present_build"], toolChoice: "required" };
    // Research is closed and present_build needs a validation, so validate_build
    // is the one useful call (Lightning r20 1440p called present_build twice unvalidated).
    return stepNumber >= FINAL_STEP ? { toolChoice: "none" } : { activeTools: ["validate_build"], toolChoice: { type: "tool", toolName: "validate_build" } };
  }
  if (validated) {
    return { toolChoice: "required" };
  }
  if (mustCallValidateFirst(steps, stepNumber)) {
    // activeTools too: llama.cpp ignores a named tool choice (LFM3, r16 office).
    return { activeTools: ["validate_build"], toolChoice: { type: "tool", toolName: "validate_build" } };
  }
  if (isBuildingTurn(steps)) return { toolChoice: "required" };
  return {};
}

/**
 * True when the latest step's validate_build call repeats an earlier one's
 * input exactly and none of its builds is far over the budget: the result
 * can't change, so the next step presents instead. Ornith (r28, 4K) sent the
 * same valid validation six times and timed out. A build far over budget is
 * left to be fixed: forcing it, Lightning (r32 office) presented 72,425 for 35,000.
 */
function repeatedValidation(steps: StepLike[] | undefined | null): boolean {
  const latestStep = (steps ?? []).at(-1);
  const inputs = (steps ?? []).map((step) =>
    (step?.toolCalls ?? []).filter((call) => call?.toolName === "validate_build").map((call) => JSON.stringify(call?.input ?? null))
  );
  const latest = inputs.at(-1) ?? [];
  const earlier = new Set(inputs.slice(0, -1).flat());
  if (!latest.some((input) => earlier.has(input))) return false;
  return !(latestStep?.toolResults ?? []).some((res) => res?.toolName === "validate_build" && hasFarOverBudgetBuild(res.output ?? res.result));
}

/** True when a validate_build output has a build more than FAR_OVER_BUDGET over its budget. */
function hasFarOverBudgetBuild(output: unknown): boolean {
  const builds = (unwrapToolOutput(output) as { builds?: unknown } | null)?.builds;
  if (!builds || typeof builds !== "object") return false;
  return Object.values(builds).some((build) => {
    const budget = (build as { budget?: { target?: unknown; over_by?: unknown } } | null)?.budget;
    return typeof budget?.target === "number" && typeof budget.over_by === "number" && budget.over_by > budget.target * FAR_OVER_BUDGET;
  });
}

/** What suggest_followups returns while a build turn has not presented its build (see buildPending). */
export const FOLLOWUPS_HELD_MESSAGE = "Not shown: finish the build first (validate_build, then present_build), then suggest follow-ups.";

/**
 * suggest_followups refuses while `held()` (a validated turn with nothing
 * presented yet): it can't end the turn then (see stopAfterFollowups), and
 * Ornith (r28, owned GPU) suggested "Present these as buyable build cards"
 * instead of presenting, then timed out. It refuses rather than leaving the
 * tool list, because changing the tool list mid-turn makes a local server
 * re-read the whole prompt (r32: two ~20 s re-reads per Ornith case).
 */
export function holdFollowupsUntilPresented(tools: ToolSet, held: () => boolean): ToolSet {
  const followups = tools.suggest_followups;
  if (!followups?.execute) return tools;
  const execute = followups.execute;
  return {
    ...tools,
    suggest_followups: {
      ...followups,
      execute: (async (input: unknown, options: unknown) =>
        held() ? { prompts: [], error: FOLLOWUPS_HELD_MESSAGE } : (execute as (input: unknown, options: unknown) => unknown)(input, options)) as never
    }
  };
}

/**
 * True once a turn has searched every core category: it is assembling a build.
 * Small models then wrote a text plan and stopped with nothing presented
 * (Qwen3.5 2B, r19 office). A validate_build call alone doesn't count: a spot
 * check or an invalid build may still be answered in text.
 */
/**
 * True while a turn owes the user a build: it validated one, or searched every
 * core category, and hasn't presented one. Follow-ups wait until it has, so
 * they can't end the turn first.
 */
function buildPending(steps: StepLike[] | undefined | null): boolean {
  return (hasSuccessfulValidation(steps) || isBuildingTurn(steps)) && !hasPresentedBuild(steps);
}

function isBuildingTurn(steps: StepLike[] | undefined | null): boolean {
  return searchedEveryCoreCategory((steps ?? []).flatMap((step) => step?.toolCalls ?? []));
}

/** True when the calls include a search_products call for every core category. */
function searchedEveryCoreCategory(calls: StepToolCallLike[]): boolean {
  const searched = new Set(
    calls
      .filter((call) => call?.toolName === "search_products")
      .map((call) => (call?.input as { category?: unknown } | null)?.category)
      .filter((category): category is string => typeof category === "string")
      .map((category) => category.trim().toLowerCase())
  );
  return CORE_SEARCH_CATEGORIES.every((category) => searched.has(category));
}

/**
 * True while every core category has been searched but validate_build was
 * never called, from VALIDATE_FIRST_STEP or as soon as the model repeats a
 * research call it already made: forcePresentDirectives then forces that call.
 * Small models searched straight through the "search paused" results, and
 * LFM3 1.7B re-ran its first six searches for 20 steps (r16 office).
 */
export function mustCallValidateFirst(steps: StepLike[] | undefined | null, stepNumber: number): boolean {
  const calls = (steps ?? []).flatMap((step) => step?.toolCalls ?? []);
  // stepNumber is 0-indexed: step VALIDATE_FIRST_STEP is stepNumber VALIDATE_FIRST_STEP - 1, as in the search pause.
  if (stepNumber + 1 < VALIDATE_FIRST_STEP && !hasRepeatedResearchCall(calls)) return false;
  // Forced once: forcing again after a call that left out a part trapped the
  // model in repeat calls with no way to search (Lightning, r7 esports).
  if (calls.some((call) => call?.toolName === "validate_build")) return false;
  return searchedEveryCoreCategory(calls);
}

/** Research tools that close late in a turn that has nothing validated yet. */
const RESEARCH_TOOLS = ["search_products", "list_models", "consult"] as const;

/** True when the turn holds two identical research calls (as researchCallKey sees them). */
function hasRepeatedResearchCall(calls: StepToolCallLike[]): boolean {
  const seen = new Set<string>();
  for (const call of calls) {
    if (typeof call?.toolName !== "string" || !(RESEARCH_TOOLS as readonly string[]).includes(call.toolName)) continue;
    const key = researchCallKey(call.toolName, call.input);
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

/**
 * True when late-turn research is closed: nothing validated or presented yet
 * and the turn has reached PRESENT_FORCE_START_STEP.
 */
export function isResearchClosed(steps: StepLike[] | undefined | null, stepNumber: number): boolean {
  if (stepNumber < PRESENT_FORCE_START_STEP) return false;
  return !hasSuccessfulValidation(steps) && !hasPresentedBuild(steps);
}

/** Steps the model still has after the current one (0-indexed stepNumber). */
function stepsLeftAfter(stepNumber: number): number {
  return Math.max(0, FINAL_STEP - stepNumber);
}

/** Tool result a closed research tool returns in place of running. */
export function researchClosedMessage(stepsLeft: number): string {
  return `Search is closed for this turn (${stepsLeft} step${stepsLeft === 1 ? "" : "s"} left). Call validate_build now with the best parts you've already found, then present_build a valid build.`;
}

/** Instruction appended to the system prompt while research is closed. */
function researchClosedInstruction(stepsLeft: number): string {
  return stepsLeft > 0
    ? `\n\nTurn budget: research is closed (${stepsLeft} step${stepsLeft === 1 ? "" : "s"} left). Do not call search_products, list_models or consult. Call validate_build with the best parts already found, then present_build.`
    : "\n\nTurn budget: no tool steps left. Answer now in text with the best build you can assemble from the parts already found, and say it was not validated.";
}

type ClosedResearchOutput = { results: []; search_closed: true; message: string };

function isClosedResearchOutput(output: unknown): output is ClosedResearchOutput {
  return Boolean(output && typeof output === "object" && (output as { search_closed?: unknown }).search_closed === true);
}

/** Categories every whole build needs; once all are searched the model has enough to validate. */
const CORE_SEARCH_CATEGORIES = ["cpu", "motherboard", "ram", "storage", "psu", "case"] as const;

/** By this step a turn should have validated something; research results say so from here on. */
const VALIDATE_BY_STEP = 10;

/** Note added to research results once every core category is searched, or VALIDATE_BY_STEP passes, with nothing validated. */
export function validateNextNote(stepsUsed: number): string {
  return `${stepsUsed} of ${MAX_STEPS} steps used and nothing validated yet. Stop searching now: call validate_build next with your best pick for each part (${CORE_SEARCH_CATEGORIES.join(", ")}, plus gpu if needed), as up to 5 labelled builds in one call; for a category you haven't searched yet, search it in the same step. Search again only to replace a part its result rejects.`;
}

/**
 * From this step, a turn that has searched every core category but never
 * called validate_build is forced to call it (forcePresentDirectives), and any
 * search gets "validate first" instead of results until it does, for providers
 * that ignore a forced tool choice. Small models ignored the note and kept
 * searching until the step-20 close.
 */
const VALIDATE_FIRST_STEP = 12;

/** Tool result while research waits for a first validate_build call. */
export function validateFirstMessage(stepsUsed: number): string {
  return `Search paused: ${stepsUsed} of ${MAX_STEPS} steps used, every core category searched and validate_build not called yet. Call validate_build now with your best pick for every part (${CORE_SEARCH_CATEGORIES.join(", ")}, plus gpu if needed) from the results you already have. Search reopens after that call, so you can replace any part it rejects.`;
}

/**
 * Note on research results once two core categories are searched with others
 * left: Nemotron Lightning searched one category per step and ran out of time.
 */
export function remainingSearchNote(left: readonly string[]): string {
  return `For a whole build, ${left.join(", ")} ${left.length === 1 ? "is" : "are"} not searched yet: search ${left.length === 1 ? "it" : "them all"} in your next step (one search_products call per category, all in the same step), then call validate_build.`;
}

/**
 * Tool result for a research call identical to an earlier one this turn,
 * listing that call's top rows: Lightning re-ran one search 7 times when the
 * result only pointed back at it (r20 1440p).
 */
export function repeatedSearchMessage(firstStep: number, rows: readonly string[] = []): string {
  const top = rows.length > 0 ? ` Its top results: ${rows.join("; ")}.` : "";
  return `Same call as step ${firstStep}.${top} Pick from these or the rest of its results earlier in this turn, or change the filters.`;
}

/** Rows a repeated research call lists from the earlier one. */
const REPEAT_ROWS = 5;

/** "id name price" for the top rows of a search_products result, or the names of a list_models result. */
function topRows(output: unknown): string[] {
  const value = output as { results?: unknown; models?: unknown } | null;
  const rows = Array.isArray(value?.results) ? value.results : Array.isArray(value?.models) ? value.models : [];
  return rows.slice(0, REPEAT_ROWS).flatMap((row) => {
    const r = row as { id?: unknown; model_id?: unknown; name?: unknown; price?: unknown } | null;
    if (typeof r?.name !== "string") return [];
    const id = typeof r.id === "string" ? `${r.id.slice(0, 10)} ` : typeof r.model_id === "string" ? `${r.model_id} ` : "";
    return [`${id}${r.name}${typeof r.price === "number" ? ` ${r.price}` : ""}`];
  });
}

/** Identity of a research call: tool name plus its input with keys sorted, ignoring `limit`. */
function researchCallKey(name: string, input: unknown): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) return `${name}:${JSON.stringify(input)}`;
  const entries = Object.entries(input).filter(([key, value]) => key !== "limit" && value !== undefined);
  return `${name}:${JSON.stringify(entries.sort(([a], [b]) => a.localeCompare(b)))}`;
}

/** Where the turn stands, read by the research gate when it runs a tool. */
export interface ResearchProgress {
  /** True once validate_build returned a presentable build this turn. */
  validated: () => boolean;
  /** True once validate_build was called this turn, whatever it returned. */
  validateCalled?: () => boolean;
  /** Steps finished so far this turn. */
  stepsUsed: () => number;
}

/** Adds a note to a research tool's model output: a JSON field, or a trailing paragraph for text. */
function withNote(modelOutput: unknown, note: string): unknown {
  const out = modelOutput as { type?: string; value?: unknown } | null;
  if (out?.type === "json" && out.value && typeof out.value === "object" && !Array.isArray(out.value)) {
    return { ...out, value: { ...out.value, next_step: note } };
  }
  if (out?.type === "text" && typeof out.value === "string") return { ...out, value: `${out.value}\n\n${note}` };
  return { type: "json", value: { result: out?.value ?? modelOutput, next_step: note } };
}

/**
 * Wraps the research tools so that, while `closedStepsLeft()` returns a
 * number, they skip their work and return researchClosedMessage as a normal
 * tool result (empty `results` keeps UI renderers happy). With `progress`,
 * once every core category has been searched in a turn with nothing
 * validated, each further research result tells the model to validate next
 * (small models otherwise re-search the same categories until research
 * closes), and from VALIDATE_FIRST_STEP research pauses until validate_build
 * is called once. Other tools are untouched.
 */
export function gateResearchTools(tools: ToolSet, closedStepsLeft: () => number | null, progress?: ResearchProgress): ToolSet {
  const gated: ToolSet = { ...tools };
  const searched = new Set<string>();
  // First step of each distinct research call; Lightning re-ran identical searches up to 4 times (r12 aaa).
  const seen = new Map<string, { step: number; rows: string[] }>();
  const allCoreSearched = () => CORE_SEARCH_CATEGORIES.every((category) => searched.has(category));
  const mustValidateFirst = () =>
    Boolean(progress?.validateCalled) &&
    !progress!.validated() &&
    !progress!.validateCalled!() &&
    allCoreSearched() &&
    progress!.stepsUsed() + 1 >= VALIDATE_FIRST_STEP;
  const shouldNudge = () =>
    Boolean(progress) &&
    !progress!.validated() &&
    (allCoreSearched() || progress!.stepsUsed() + 1 >= VALIDATE_BY_STEP);
  for (const name of RESEARCH_TOOLS) {
    const original = tools[name];
    if (!original?.execute) continue;
    const execute = original.execute;
    const toModelOutput = original.toModelOutput;
    gated[name] = {
      ...original,
      execute: (async (input: unknown, options: unknown) => {
        const stepsLeft = closedStepsLeft();
        if (stepsLeft !== null) {
          return { results: [], search_closed: true, message: researchClosedMessage(stepsLeft) } satisfies ClosedResearchOutput;
        }
        if (mustValidateFirst()) {
          return { results: [], search_closed: true, message: validateFirstMessage(progress!.stepsUsed() + 1) } satisfies ClosedResearchOutput;
        }
        const key = researchCallKey(name, input);
        const earlier = seen.get(key);
        if (earlier !== undefined) {
          return { results: [], search_closed: true, message: repeatedSearchMessage(earlier.step, earlier.rows) } satisfies ClosedResearchOutput;
        }
        // Recorded before the await so a parallel identical call in the same step is caught;
        // a failed call is forgotten so its retry runs.
        const entry = { step: (progress?.stepsUsed() ?? 0) + 1, rows: [] as string[] };
        seen.set(key, entry);
        let output: unknown;
        try {
          output = await (execute as (input: unknown, options: unknown) => unknown)(input, options);
        } catch (error) {
          seen.delete(key);
          throw error;
        }
        if (typeof (output as { error?: unknown } | null)?.error === "string") {
          seen.delete(key);
          return output;
        }
        const category = (input as { category?: unknown } | null)?.category;
        if (typeof category === "string") searched.add(category.trim().toLowerCase());
        entry.rows = topRows(output);
        if (!output || typeof output !== "object" || Array.isArray(output)) return output;
        if (shouldNudge()) return { ...output, next_step: validateNextNote(progress!.stepsUsed() + 1) };
        const left = CORE_SEARCH_CATEGORIES.filter((c) => !searched.has(c));
        const coreSearched = CORE_SEARCH_CATEGORIES.length - left.length;
        return progress && !progress.validated() && coreSearched >= 2 && left.length > 0
          ? { ...output, next_step: remainingSearchNote(left) }
          : output;
      }) as typeof execute,
      toModelOutput: (async (args: { output: unknown }) => {
        if (isClosedResearchOutput(args.output)) return { type: "text", value: args.output.message };
        const note = (args.output as { next_step?: unknown } | null)?.next_step;
        // Without the tool's own toModelOutput, mirror the SDK default (strings as text, the rest as JSON).
        const base = toModelOutput
          ? await (toModelOutput as (a: unknown) => unknown)(args)
          : typeof args.output === "string" ? { type: "text", value: args.output } : { type: "json", value: args.output };
        return typeof note === "string" ? withNote(base, note) : base;
      }) as NonNullable<typeof toModelOutput>
    } as typeof original;
  }
  return gated;
}

function persistSessionCompactContext(
  sessionId: string | undefined,
  messages: ModelMessage[],
  boundaryMessageId?: string,
  snapshot?: BuildSnapshot | null
): void {
  if (isHosted() || !sessionId) return;
  saveCompactContext(sessionId, {
    messages,
    boundaryMessageId,
    snapshot: snapshot ?? null
  });
}

/**
 * Response message id for a chat request, mirroring the AI SDK's
 * getResponseUIMessageId: when the last incoming message is an assistant
 * message (a continuation after a dropped stream), the response must reuse
 * its id so the client appends to it; otherwise undefined (fresh id).
 */
export function continuationMessageId(messages: ReadonlyArray<{ id?: string; role: string }>): string | undefined {
  const last = messages.at(-1);
  return last?.role === "assistant" && typeof last.id === "string" && last.id.length > 0 ? last.id : undefined;
}

/**
 * The voice route's injection point: the ONLY way /api/alexa differs from web
 * chat. `tools` swaps the local registry for MCP-client tools;
 * `systemPromptPrefix` puts rules that must win over the general guidance
 * first, `systemPromptSuffix` appends a closing reminder, and `thinking: false`
 * skips local models' thinking phase. All optional;
 * when absent the web-chat path is behaviour-identical.
 */
export interface StreamChatOverrides {
  tools?: ToolSet;
  systemPromptPrefix?: string;
  systemPromptSuffix?: string;
  /** false: local models answer without a thinking phase (voice latency). */
  thinking?: boolean;
}

export async function streamChat(
  config: AppConfig,
  messages: ChatMessage[],
  sessionId?: string,
  abortSignal?: AbortSignal,
  clientCompactContext?: StoredCompactContext | null,
  responseMessageId?: string,
  overrides?: StreamChatOverrides
) {
  const lastUser = messages.filter((message) => message.role === "user").at(-1);
  if (lastUser) {
    await appendChatLog({ role: "user", content: lastUser.content ?? "", session_id: sessionId });
  }
  let systemPrompt = buildSystemPrompt(config, await loadCatalogSummary(config));
  if (overrides?.systemPromptPrefix) {
    systemPrompt = `${overrides.systemPromptPrefix}\n\n${systemPrompt}`;
  }
  if (overrides?.systemPromptSuffix) {
    systemPrompt += `\n\n${overrides.systemPromptSuffix}`;
  }
  const session = (!isHosted() && sessionId) ? getSession(sessionId) : null;
  const buildState = session?.build_state ?? deriveBuildState(messages as unknown as UIMessage[]);
  if (buildState) {
    systemPrompt += `\n\nCurrent build state (authoritative): ${JSON.stringify(buildState)}`;
  }
  const truncatedSystem = systemPrompt.slice(0, 500) + (systemPrompt.length > 500 ? "..." : "");
  await appendChatLog({ role: "system", content: truncatedSystem, session_id: sessionId });

  const activeEntry = config.llm.roles.chat[0];
  const contextLimit = getModelContextLimit(activeEntry);

  // Created before replay conversion so history tool results go through each
  // tool's toModelOutput (the trimmed model view), not the full UI output.
  // Set by prepareStep: steps left while late-turn research is closed, else null.
  let researchClosedStepsLeft: number | null = null;
  // Set by prepareStep for the research gate's "validate next" note.
  let turnValidated = false;
  let turnValidateCalled = false;
  let turnStepsUsed = 0;
  const userText = messages
    .filter((message) => message.role === "user")
    .map((message) => [message.content ?? "", ...(message.parts ?? []).map((part) => (part.type === "text" ? part.text : ""))].join(" "))
    .join("\n");
  // Set by prepareStep: a validated build is waiting to be presented.
  let followupsHeld = false;
  const registry = holdFollowupsUntilPresented(
    rememberFoundParts(overrides?.tools ?? createToolRegistry(config, { requireCatalogParts: true, userText })),
    () => followupsHeld
  );
  const tools = gateResearchTools(registry, () => researchClosedStepsLeft, {
    validated: () => turnValidated,
    validateCalled: () => turnValidateCalled,
    stepsUsed: () => turnStepsUsed
  });
  const capped = capMessages(messages);
  const rawModelMessages = await convertToModelMessages(
    capped.map((m: ChatMessage) => ({
      id: m.id ?? crypto.randomUUID(),
      role: m.role,
      content: m.content ?? "",
      parts: m.parts && m.parts.length > 0
        ? m.parts
        : typeof m.content === "string" && m.content
          ? [{ type: "text", text: m.content }]
          : []
    })),
    { tools }
  );

  const assistantMsgId = responseMessageId ?? crypto.randomUUID();
  const effectiveCompactContext = isHosted()
    ? (clientCompactContext ?? null)
    : (session?.compact_context ?? clientCompactContext ?? null);

  let latestCompactContext: StoredCompactContext | null = effectiveCompactContext ? { ...effectiveCompactContext } : null;
  // The conversation the model actually sees when resuming from compacted
  // context (earlier summary plus this turn's messages, including the user's
  // question). onFinish stores it with the final reply as the next context.
  let compactBase: ModelMessage[] | null = null;

  let initialModelMessages = rawModelMessages;
  if (effectiveCompactContext && effectiveCompactContext.messages && effectiveCompactContext.messages.length > 0) {
    const boundaryId = effectiveCompactContext.boundaryMessageId;
    if (boundaryId) {
      const boundaryIndex = capped.findIndex((m) => m.id === boundaryId);
      if (boundaryIndex !== -1) {
        const sliceIndex =
          capped[boundaryIndex]?.role === "user" && capped[boundaryIndex + 1]?.role === "assistant"
            ? boundaryIndex + 1
            : boundaryIndex;
        const laterCapped = capped.slice(sliceIndex + 1);
        if (laterCapped.length > 0) {
          const laterModelMessages = await convertToModelMessages(
            laterCapped.map((m: ChatMessage) => ({
              id: m.id ?? crypto.randomUUID(),
              role: m.role,
              content: m.content ?? "",
              parts: m.parts ?? []
            })),
            { tools }
          );
          initialModelMessages = [...effectiveCompactContext.messages, ...laterModelMessages];
        } else {
          initialModelMessages = [...effectiveCompactContext.messages];
        }
        compactBase = initialModelMessages;
      } else {
        initialModelMessages = rawModelMessages;
      }
    } else {
      const lastUserMsg = rawModelMessages.filter((m) => m.role === "user").at(-1);
      initialModelMessages = lastUserMsg
        ? [...effectiveCompactContext.messages, lastUserMsg]
        : [...effectiveCompactContext.messages];
      compactBase = initialModelMessages;
    }
  }

  const toolsOverhead = measureToolDefinitionsTokens(tools);

  // Pre-stream compaction check if request already approaches 78–80% context
  const initialTokens = calculateStepTokens({
    currentMessages: initialModelMessages,
    systemPrompt,
    toolsOverhead
  });
  if (shouldTriggerCompaction(initialTokens, contextLimit)) {
    if (!isHosted() && sessionId) setSessionCompacting(sessionId, true);
    try {
      const sessionSnapshot = (buildState as { snapshot?: BuildSnapshot } | null)?.snapshot;
      const historySnapshots = latestValidationSnapshots(messages as unknown as UIMessage[]);
      const initialCompaction = await compactConversation({
        chain: config.llm.roles.chat,
        systemPrompt,
        messages: initialModelMessages,
        snapshot: sessionSnapshot,
        snapshots: historySnapshots,
        contextLimit,
        force: true,
        abortSignal
      });
      if (initialCompaction.compacted) {
        initialModelMessages = initialCompaction.messages;
        compactBase = initialCompaction.messages;
        latestCompactContext = {
          messages: initialModelMessages,
          boundaryMessageId: assistantMsgId,
          snapshot: sessionSnapshot ?? null
        };
        persistSessionCompactContext(sessionId, initialModelMessages, assistantMsgId, sessionSnapshot);
      }
    } finally {
      if (!isHosted() && sessionId) setSessionCompacting(sessionId, false);
    }
  }

  const streamResult = await streamTextWithFallback({
    chain: config.llm.roles.chat,
    system: systemPrompt,
    messages: initialModelMessages,
    tools,
    ...(overrides?.thinking === false ? { thinking: false } : {}),
    // 25 on purpose: small local models (≤27B quants) and ranking several builds from in-stock parts need the steps; 14 was tested and is too low.
    stopWhen: (opts) => isStepCount(MAX_STEPS)(opts) || stopAfterFollowups(opts as { steps: StepLike[] }),
    abortSignal,
    prepareStep: async ({ steps, stepNumber, messages: currentMessages }) => {
      const currentStep = typeof stepNumber === "number" ? stepNumber : steps.length;
      // A validated turn must end with present_build, never with a text reply.
      const forced = forcePresentDirectives(steps, currentStep);
      followupsHeld = buildPending(steps);
      researchClosedStepsLeft = isResearchClosed(steps, currentStep) ? stepsLeftAfter(currentStep) : null;
      turnValidated = hasSuccessfulValidation(steps) || hasPresentedBuild(steps);
      turnValidateCalled = (steps ?? []).some((step) => (step?.toolCalls ?? []).some((call) => call?.toolName === "validate_build"));
      turnStepsUsed = currentStep;
      // Tell the model research is closed instead of silently narrowing tools.
      const directives = researchClosedStepsLeft === null
        ? forced
        : { ...forced, instructions: systemPrompt + researchClosedInstruction(researchClosedStepsLeft) };
      const currentTokens = calculateStepTokens({
        steps,
        currentMessages,
        systemPrompt,
        toolsOverhead
      });
      if (shouldTriggerCompaction(currentTokens, contextLimit)) {
        if (!isHosted() && sessionId) setSessionCompacting(sessionId, true);
        try {
          // Step results hold full outputs; the model messages hold validate_build's trimmed view.
          let latestSnapshot = (buildState as { snapshot?: BuildSnapshot } | null)?.snapshot;
          let latestSnapshots = latestValidationSnapshots(messages as unknown as UIMessage[]);
          for (const step of steps) {
            for (const res of step.toolResults || []) {
              const output = (res as { output?: unknown }).output;
              const snap = getSnapshotFromOutput(output);
              if (snap) latestSnapshot = snap;
              const all = fullSnapshotsOf(output);
              if (all.length > 0) latestSnapshots = all;
            }
          }

          const compaction = await compactConversation({
            chain: config.llm.roles.chat,
            systemPrompt,
            messages: currentMessages,
            snapshot: latestSnapshot,
            snapshots: latestSnapshots,
            contextLimit,
            force: true,
            abortSignal
          });

          if (compaction.compacted) {
            compactBase = compaction.messages;
            latestCompactContext = {
              messages: compaction.messages,
              boundaryMessageId: assistantMsgId,
              snapshot: latestSnapshot ?? null
            };
            persistSessionCompactContext(sessionId, compaction.messages, assistantMsgId, latestSnapshot);
            return { ...directives, messages: compaction.messages };
          }
        } finally {
          if (!isHosted() && sessionId) setSessionCompacting(sessionId, false);
        }
      }
      return directives;
    },
    onStepFinish: async (step: OnStepFinishEvent<ToolSet>) => {
      const resultsById = new Map((step.toolResults || []).map((result) => [result.toolCallId, result]));
      const promises = [];
      for (const call of step.toolCalls) {
        const result = resultsById.get(call.toolCallId);
        promises.push(
          appendChatLog({
            role: "tool",
            session_id: sessionId,
            toolName: String(call.toolName),
            toolArgs: call.input,
            toolResult: result ? summarizeToolResult(result) : undefined,
            provider: step.model.provider,
            modelId: step.model.modelId
          })
        );
      }
      await Promise.all(promises);
    },
    onFinish: async (finish: OnFinishEvent<ToolSet>) => {
      // Anonymous hosted-only counter: one build_presented per turn that
      // actually presented a build. Zero behavior change to the turn itself.
      try {
        const steps = (finish as unknown as { steps?: StepLike[] }).steps;
        if (hasPresentedBuild(steps)) recordAnalytics("build_presented", "");
      } catch {
        // Never break chat for analytics.
      }
      if (compactBase && finish.text && finish.text.trim().length > 0) {
        latestCompactContext = {
          messages: [...compactBase, { role: "assistant", content: finish.text.trim() }],
          boundaryMessageId: assistantMsgId,
          snapshot: latestCompactContext?.snapshot ?? null
        };
        persistSessionCompactContext(
          sessionId,
          latestCompactContext.messages,
          assistantMsgId,
          latestCompactContext.snapshot as BuildSnapshot | null
        );
      }
      await appendChatLog({
        role: "assistant",
        session_id: sessionId,
        content: finish.text,
        reasoning: finish.reasoningText,
        provider: finish.model.provider,
        modelId: finish.model.modelId
      });
    }
  });

  Object.defineProperties(streamResult, {
    responseMessageId: { value: assistantMsgId, enumerable: true },
    compactContext: { get: () => latestCompactContext, enumerable: true }
  });

  return streamResult as typeof streamResult & {
    responseMessageId: string;
    compactContext: StoredCompactContext | null;
  };
}

function summarizeToolResult(result: unknown) {
  if (typeof result !== "object" || result === null) return result;
  const value = result as Record<string, unknown>;
  return {
    toolCallId: value.toolCallId,
    toolName: value.toolName,
    output: value.output,
    error: value.error instanceof Error ? value.error.message : value.error
  };
}
