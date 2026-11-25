import type { ToolSet } from "ai";
import { FAR_OVER_BUDGET } from "@/lib/tools/validate-build";
import { formatPrice } from "@/lib/tools/lenient-input";
import { presentRefusal } from "@/lib/tools/present-build";
import { MAX_BATCH_QUERIES, normalizeSearchCallQueries } from "@/lib/tools/search-products";

// The chat turn's rules, step by step: when research closes, when validate_build
// and present_build are forced, which repeated calls are refused, and when
// follow-ups may end the turn. chat-engine.ts applies them in prepareStep and
// stopWhen; nothing here streams or talks to a provider.

/** Agentic turn budget: the model gets this many tool steps before it must wrap up. */
export const MAX_STEPS = 25;
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

export type StepLike = {
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

/**
 * True once present_build has presented a build that settles the turn: any
 * presentation pushForNearBudgetPresent didn't flag far over the budget, so
 * also any build presented on the final step. Earlier far-over presentations
 * leave the turn working, and the final step still forces present_build so
 * a cheaper build validated since gets shown (Lightning r38 4K validated
 * 1,50,858 after showing 2,79,668 for 2,50,000, then validated again on the
 * final step).
 */
function presentSettled(steps: StepLike[] | undefined | null): boolean {
  const names = callNamesById(steps);
  const presented = (steps ?? []).flatMap((step) => (step?.toolResults ?? []).filter((res) => isPresentResult(res, names) && isPresentedResult(res)));
  if (presented.length === 0) return false;
  return presented.some((res) => (unwrapToolOutput(res.output ?? res.result) as { far_over_budget?: unknown }).far_over_budget !== true);
}

function hasNonEmptyFollowups(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const followups = (value as { followups?: unknown }).followups;
  return Array.isArray(followups) && followups.some((item) => typeof item === "string" && item.trim().length > 0);
}

function isFollowupsToolCall(call: StepToolCallLike | null | undefined, result?: StepToolResultLike): boolean {
  if (call?.toolName === "suggest_followups") return true;
  if (call?.toolName !== "present_build") return false;
  if (hasNonEmptyFollowups(call.input)) return true;
  return hasNonEmptyFollowups(unwrapToolOutput(result?.output ?? result?.result));
}

/** True once suggest_followups or present_build with followups has been called in the current turn. */
export function hasFollowupsCall(steps: StepLike[] | undefined | null): boolean {
  const resultsById = new Map<string, StepToolResultLike>();
  for (const step of steps ?? []) {
    for (const res of step?.toolResults ?? []) {
      if (typeof res?.toolCallId === "string") resultsById.set(res.toolCallId, res);
    }
  }
  return (steps ?? []).some((step) =>
    (step?.toolCalls ?? []).some((call) => isFollowupsToolCall(call, typeof call?.toolCallId === "string" ? resultsById.get(call.toolCallId) : undefined))
  );
}

function isCleanPresentedResult(res: StepToolResultLike | null | undefined): boolean {
  if (!isPresentedResult(res)) return false;
  const out = unwrapToolOutput(res?.output ?? res?.result);
  if (!out || typeof out !== "object") return false;
  const record = out as { far_over_budget?: unknown; not_presented?: unknown; label_note?: unknown };
  if (record.far_over_budget === true) return false;
  if (Array.isArray(record.not_presented) && record.not_presented.length > 0) return false;
  if (typeof record.label_note === "string" && record.label_note.trim().length > 0) return false;
  return true;
}

/**
 * End the turn after suggest_followups (or present_build with followups) once
 * the text reply is written, without breaking force-present: a validated-but-
 * unpresented turn keeps going so present_build can still be forced.
 *
 * Only stops when (a) the latest step itself wrote non-empty assistant text (so
 * an earlier pre-search progress line like "I'll check prices first" never
 * substitutes for a final explanation), and (b) follow-ups are in the latest
 * step and every other call in that step needs no model follow-up (only a clean
 * present_build with no partial refusals, label corrections, or far-over-budget
 * warnings qualifies).
 */
export function stopAfterFollowups({ steps }: { steps: StepLike[] }): boolean {
  if (!hasFollowupsCall(steps)) return false;
  if (buildPending(steps)) return false;
  const last = steps.at(-1);
  if (typeof last?.text !== "string" || last.text.trim().length === 0) return false;
  const calls = last?.toolCalls ?? [];
  const names = callNamesById(steps);
  const resultsById = new Map((last?.toolResults ?? []).map((res) => [res?.toolCallId, res]));
  if (!calls.some((call) => isFollowupsToolCall(call, resultsById.get(call?.toolCallId)))) return false;
  return calls.every((call) => {
    if (call?.toolName === "suggest_followups") return true;
    if (call?.toolName !== "present_build") return false;
    const res = resultsById.get(call.toolCallId);
    return isPresentResult(res, names) && isCleanPresentedResult(res);
  });
}

/**
 * Per-step tool forcing so a validated turn can't end on a text reply:
 * after validate_build returns a presentable build the model must call another tool
 * (toolChoice "required"), and near the step limit (reserving FINAL_STEP for the
 * final explanation) or after a repeated validate_build call, forces present_build
 * by name.
 *
 * Advertised tool schemas (`activeTools`) and system instructions are NEVER mutated
 * mid-turn so prompt/KV caches stay valid across every step; late-turn and
 * validate-first transitions are enforced in tool execution (`gateResearchTools`
 * and `holdFollowupsUntilPresented`).
 *
 * Returns {} (auto) otherwise when nothing is validated yet or after
 * presenting, so the model can ask, research freely and explain afterwards.
 */
export function forcePresentDirectives(
  steps: StepLike[] | undefined | null,
  stepNumber: number
): { toolChoice?: "required" | "none" | { type: "tool"; toolName: string } } {
  if (presentSettled(steps)) return {};
  // A presentation not yet settled (far over budget) counts as validated: its
  // build may have been validated only inside present_build.
  const validated = hasSuccessfulValidation(steps) || hasPresentedBuild(steps);
  // Force present_build at FINAL_STEP - 1 so FINAL_STEP stays free for a text explanation,
  // and keep forcing at FINAL_STEP if somehow still unpresented.
  if (validated && (stepNumber >= FINAL_STEP - 1 || repeatedValidation(steps))) {
    return { toolChoice: { type: "tool", toolName: "present_build" } };
  }
  if (stepNumber >= PRESENT_FORCE_START_STEP) {
    if (validated) return { toolChoice: "required" };
    // Research is closed and present_build needs a validation, so validate_build
    // is the one useful call; FINAL_STEP allows text only so the turn never ends empty.
    return stepNumber >= FINAL_STEP ? { toolChoice: "none" } : { toolChoice: { type: "tool", toolName: "validate_build" } };
  }
  if (validated) {
    return { toolChoice: "required" };
  }
  if (mustCallValidateFirst(steps, stepNumber)) {
    return { toolChoice: { type: "tool", toolName: "validate_build" } };
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
  return Object.values(builds).some((build) => isFarOverBudget((build as { budget?: unknown } | null)?.budget));
}

type BudgetFigures = { target: number; over_by: number };

/** True when validate_build's budget figures put a build more than FAR_OVER_BUDGET over its budget. */
function isFarOverBudget(budget: unknown): budget is BudgetFigures {
  const b = budget as { target?: unknown; over_by?: unknown } | null | undefined;
  return typeof b?.target === "number" && typeof b.over_by === "number" && b.over_by > b.target * FAR_OVER_BUDGET;
}

type PresentedBuildLike = {
  label?: unknown;
  validated_label?: unknown;
  product_ids?: unknown;
  validation?: { budget?: unknown; snapshot?: { currency?: unknown } } | null;
};

/** The highest total a build may have and stay within FAR_OVER_BUDGET of `target`. */
function nearBudgetLimit(target: number): number {
  return Math.floor(target * (1 + FAR_OVER_BUDGET));
}

/** Note on a presentation whose builds are all far over the budget; `closest` is the least over. */
export function farOverBudgetNote(closestLabel: string, budget: BudgetFigures, currency?: string): string {
  const fmt = (n: number) => formatPrice(n, currency);
  return `Shown, but every build here is more than ${Math.round(FAR_OVER_BUDGET * 100)}% over the ${fmt(budget.target)} budget (closest: '${closestLabel}', ${fmt(budget.over_by)} over). The budget is the user's limit, so keep going: swap the priciest parts for cheaper ones from this turn's results, call validate_build, then present a build at or under ${fmt(nearBudgetLimit(budget.target))}. If nothing can fit, say so in your reply.`;
}

/** present_build's result for a far-over build presented again: it is already on screen. */
export const FAR_OVER_ALREADY_SHOWN =
  "Already shown above. Present a different build within the budget, or say in your reply why none fits.";

/**
 * After present_build shows only builds more than FAR_OVER_BUDGET over the
 * budget, before the final step, its result is flagged far_over_budget and
 * tells the model to find and present a build within the budget; the turn
 * policy treats the turn as unsettled until then (presentSettled). The card
 * stays shown, so a model that answers in text still leaves the user a build.
 * The same far-over builds presented again are refused as already shown.
 * Lightning presented 52,779 for 35,000 (r37 office) and 2,34,629 for 70,000
 * (r37 owned-gpu) at steps 21-22 and stopped. `stepNumber` is the current
 * 0-indexed step.
 */
export function pushForNearBudgetPresent(tools: ToolSet, stepNumber: () => number): ToolSet {
  const present = tools.present_build;
  if (!present?.execute) return tools;
  const execute = present.execute as (input: unknown, options: unknown) => unknown;
  // Sorted product IDs of every far-over build shown this turn.
  const shown = new Set<string>();
  const key = (build: PresentedBuildLike) => (Array.isArray(build.product_ids) ? [...build.product_ids].map(String).sort().join(",") : "");
  return {
    ...tools,
    present_build: {
      ...present,
      execute: (async (input: unknown, options: unknown) => {
        const output = await execute(input, options);
        if (stepNumber() >= FINAL_STEP) return output;
        const result = output as { presented?: unknown; builds?: unknown } | null;
        if (result?.presented !== true || !Array.isArray(result.builds) || result.builds.length === 0) return output;
        const builds = (result.builds as PresentedBuildLike[]).map((build) => ({ build, budget: build?.validation?.budget }));
        if (!builds.every((b): b is { build: PresentedBuildLike; budget: BudgetFigures } => isFarOverBudget(b.budget))) return output;
        if (builds.every(({ build }) => shown.has(key(build)))) return { presented: false, error: FAR_OVER_ALREADY_SHOWN };
        for (const { build } of builds) shown.add(key(build));
        const closest = builds.reduce((min, b) => (b.budget.over_by < min.budget.over_by ? b : min));
        const label = String(closest.build.validated_label ?? closest.build.label ?? "");
        const currency = closest.build.validation?.snapshot?.currency;
        return { ...result, far_over_budget: true, next_step: farOverBudgetNote(label, closest.budget, typeof currency === "string" ? currency : undefined) };
      }) as never
    }
  };
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
 * core category, and hasn't presented one that settles it (presentSettled).
 * Follow-ups wait until it has, so they can't end the turn first.
 */
export function buildPending(steps: StepLike[] | undefined | null): boolean {
  return (hasSuccessfulValidation(steps) || isBuildingTurn(steps) || hasPresentedBuild(steps)) && !presentSettled(steps);
}

function isBuildingTurn(steps: StepLike[] | undefined | null): boolean {
  return searchedEveryCoreCategory(steps);
}

const DEFAULT_SEARCH_LIMIT = 12;

/** Normalized effective result limit for a search_products query (1..12, default 12). */
function effectiveSearchLimit(input: unknown): number {
  if (!input || typeof input !== "object" || Array.isArray(input)) return DEFAULT_SEARCH_LIMIT;
  const raw = (input as { limit?: unknown }).limit;
  if (raw === undefined || raw === null) return DEFAULT_SEARCH_LIMIT;
  const n = typeof raw === "string" ? Number(raw.trim()) : Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_SEARCH_LIMIT;
  return Math.min(DEFAULT_SEARCH_LIMIT, Math.max(1, Math.round(n)));
}

function isRepeatedSlot(slot: Record<string, unknown>): boolean {
  if (slot.repeated === true) return true;
  return slot.search_closed === true && typeof slot.message === "string" && slot.message.startsWith("Same call as ");
}

/**
 * Extracts executed search categories and research call records from turn steps,
 * preferring actual tool results over requested inputs so rejected, failed, or
 * truncated calls never count as searched or repeated.
 */
function inspectExecutedResearch(steps: StepLike[] | undefined | null): {
  searchedCategories: Set<string>;
  repeated: boolean;
} {
  const searchedCategories = new Set<string>();
  const seenLimit = new Map<string, number>();
  let repeated = false;

  const recordKey = (key: string, limit: number) => {
    const earlier = seenLimit.get(key);
    if (earlier !== undefined && limit <= earlier) {
      repeated = true;
    }
    if (earlier === undefined || limit > earlier) {
      seenLimit.set(key, limit);
    }
  };

  for (const step of steps ?? []) {
    const resultsById = new Map<string, StepToolResultLike>();
    for (const res of step?.toolResults ?? []) {
      if (typeof res?.toolCallId === "string") resultsById.set(res.toolCallId, res);
    }
    for (const call of step?.toolCalls ?? []) {
      if (typeof call?.toolName !== "string" || !(RESEARCH_TOOLS as readonly string[]).includes(call.toolName)) continue;
      const res = typeof call.toolCallId === "string" ? resultsById.get(call.toolCallId) : undefined;
      if (res) {
        if (res.error != null) continue;
        const out = unwrapToolOutput(res.output ?? res.result);
        if (!out || typeof out !== "object") continue;
        const outObj = out as Record<string, unknown>;
        if (typeof outObj.error === "string") continue;
        if (outObj.search_closed === true) {
          if (isRepeatedSlot(outObj)) repeated = true;
          continue;
        }
        if (call.toolName === "search_products" && outObj.batch === true && Array.isArray(outObj.searches)) {
          const normalized = normalizeSearchCallQueries(call.input);
          const subInputs = normalized.kind === "batch" ? normalized.queries : [];
          const slots = outObj.searches.slice(0, MAX_BATCH_QUERIES);
          for (let i = 0; i < slots.length; i++) {
            const slot = slots[i];
            if (!slot || typeof slot !== "object") continue;
            const slotObj = slot as Record<string, unknown>;
            if (typeof slotObj.error === "string") continue;
            if (slotObj.search_closed === true) {
              if (isRepeatedSlot(slotObj)) repeated = true;
              continue;
            }
            const subInput = subInputs[i];
            const cat =
              typeof slotObj.category === "string"
                ? slotObj.category
                : typeof (subInput as { category?: unknown } | null)?.category === "string"
                  ? (subInput as { category: string }).category
                  : undefined;
            if (cat && cat.trim()) searchedCategories.add(cat.trim().toLowerCase());
            if (subInput !== undefined) {
              recordKey(researchCallKey("search_products", subInput), effectiveSearchLimit(subInput));
            }
          }
          continue;
        }
        if (call.toolName === "search_products") {
          const normalized = normalizeSearchCallQueries(call.input);
          if (normalized.kind === "single") {
            const cat = normalized.query.category;
            if (typeof cat === "string" && cat.trim()) searchedCategories.add(cat.trim().toLowerCase());
            recordKey(researchCallKey("search_products", normalized.query), effectiveSearchLimit(normalized.query));
          }
          continue;
        }
        recordKey(researchCallKey(call.toolName, call.input), DEFAULT_SEARCH_LIMIT);
        continue;
      }

      // No toolResult on this step (e.g. unit-test fixture with toolCalls only): normalize input once.
      if (call.toolName === "search_products") {
        const normalized = normalizeSearchCallQueries(call.input);
        if (normalized.kind === "invalid") continue;
        if (normalized.kind === "batch") {
          for (const sub of normalized.queries) {
            const cat = (sub as { category?: unknown } | null)?.category;
            if (typeof cat === "string" && cat.trim()) searchedCategories.add(cat.trim().toLowerCase());
            recordKey(researchCallKey("search_products", sub), effectiveSearchLimit(sub));
          }
        } else {
          const cat = normalized.query.category;
          if (typeof cat === "string" && cat.trim()) searchedCategories.add(cat.trim().toLowerCase());
          recordKey(researchCallKey("search_products", normalized.query), effectiveSearchLimit(normalized.query));
        }
      } else {
        recordKey(researchCallKey(call.toolName, call.input), DEFAULT_SEARCH_LIMIT);
      }
    }
  }

  return { searchedCategories, repeated };
}

/** True when executed search_products calls (single or batch) cover every core category. */
function searchedEveryCoreCategory(steps: StepLike[] | undefined | null): boolean {
  const { searchedCategories } = inspectExecutedResearch(steps);
  return CORE_SEARCH_CATEGORIES.every((category) => searchedCategories.has(category));
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
  // Forced once: forcing again after a call that left out a part trapped the
  // model in repeat calls with no way to search (Lightning, r7 esports).
  if (calls.some((call) => call?.toolName === "validate_build")) return false;
  const { searchedCategories, repeated } = inspectExecutedResearch(steps);
  // stepNumber is 0-indexed: step VALIDATE_FIRST_STEP is stepNumber VALIDATE_FIRST_STEP - 1, as in the search pause.
  if (stepNumber + 1 < VALIDATE_FIRST_STEP && !repeated) return false;
  return CORE_SEARCH_CATEGORIES.every((category) => searchedCategories.has(category));
}

/** Research tools that close late in a turn that has nothing validated yet. */
const RESEARCH_TOOLS = ["search_products", "list_models", "consult"] as const;

/**
 * True when late-turn research is closed because nothing is validated or
 * presented yet and the turn has reached PRESENT_FORCE_START_STEP.
 */
export function isResearchClosed(steps: StepLike[] | undefined | null, stepNumber: number): boolean {
  if (stepNumber < PRESENT_FORCE_START_STEP) return false;
  return !hasSuccessfulValidation(steps) && !hasPresentedBuild(steps);
}

/**
 * True when late-turn research should be blocked in tool execution (any unsettled
 * turn from PRESENT_FORCE_START_STEP onward, including validated turns waiting
 * for present_build, so activeTools never needs to change mid-turn).
 */
export function isLateTurnResearchClosed(steps: StepLike[] | undefined | null, stepNumber: number): boolean {
  if (stepNumber < PRESENT_FORCE_START_STEP) return false;
  return !presentSettled(steps);
}

/** Steps the model still has after the current one (0-indexed stepNumber). */
export function stepsLeftAfter(stepNumber: number): number {
  return Math.max(0, FINAL_STEP - stepNumber);
}

/** Tool result a closed research tool returns in place of running. */
export function researchClosedMessage(stepsLeft: number, validated = false): string {
  if (validated) {
    return `Search is closed for this turn (${stepsLeft} step${stepsLeft === 1 ? "" : "s"} left). Call present_build now with your validated build (or validate_build to adjust it).`;
  }
  return `Search is closed for this turn (${stepsLeft} step${stepsLeft === 1 ? "" : "s"} left). Call validate_build now with the best parts you've already found, then present_build a valid build.`;
}

/** Instruction appended to the system prompt while research is closed. */
export function researchClosedInstruction(stepsLeft: number): string {
  return stepsLeft > 0
    ? `\n\nTurn budget: research is closed (${stepsLeft} step${stepsLeft === 1 ? "" : "s"} left). Do not call search_products, list_models or consult. Call validate_build with the best parts already found, then present_build.`
    : "\n\nTurn budget: no tool steps left. Answer now in text with the best build you can assemble from the parts already found, and say it was not validated.";
}

type ClosedResearchOutput = { results: []; search_closed: true; repeated?: true; message: string };

function isClosedResearchOutput(output: unknown): output is ClosedResearchOutput {
  return Boolean(output && typeof output === "object" && (output as { search_closed?: unknown }).search_closed === true);
}

/** Wraps an updated domain object back into an MCP CallToolResult envelope when the raw output used one. */
function wrapIfMcp(rawOutput: unknown, domain: Record<string, unknown>): unknown {
  if (!isCallToolResultShape(rawOutput)) return domain;
  return {
    ...(rawOutput as Record<string, unknown>),
    content: [{ type: "text", text: JSON.stringify(domain) }],
    structuredContent: domain
  };
}

/** Categories every whole build needs; once all are searched the model has enough to validate. */
const CORE_SEARCH_CATEGORIES = ["cpu", "motherboard", "ram", "storage", "psu", "case"] as const;

/** By this step a turn should have validated something; research results say so from here on. */
export const VALIDATE_BY_STEP = 10;

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
 * result only pointed back at it (r20 1440p). When the earlier call found
 * nothing it says so: Lightning re-ran an empty AM4 Mini-ITX board search
 * three times on "Pick from these" with nothing listed. An identical call in
 * the same step runs while the first is still pending, so it only points at it.
 */
export function repeatedSearchMessage(firstStep: number, rows: readonly string[] = [], outcome: RepeatOutcome = "rows"): string {
  if (outcome === "pending") return "Same call as another one in this step: use that call's result.";
  if (outcome === "empty") {
    return `Same call as step ${firstStep}, which found nothing, so it would find nothing again. Drop or change a filter (term, socket, form_factor, price) and search again.`;
  }
  const top = rows.length > 0 ? ` Its top results: ${rows.join("; ")}.` : "";
  return `Same call as step ${firstStep}.${top} Pick from these or the rest of its results earlier in this turn, or change the filters.`;
}

/** What the earlier identical research call returned: still running, rows, or nothing. */
export type RepeatOutcome = "pending" | "rows" | "empty";

/** Rows a repeated research call lists from the earlier one. */
const REPEAT_ROWS = 5;

/** The rows of a search_products result, or the models of a list_models result. */
function resultRows(output: unknown): unknown[] | undefined {
  const value = output as { results?: unknown; models?: unknown } | null;
  return Array.isArray(value?.results) ? value.results : Array.isArray(value?.models) ? value.models : undefined;
}

/** "id name price" for the top rows of a search_products result, or the names of a list_models result. */
function topRows(output: unknown): string[] {
  const rows = resultRows(output) ?? [];
  return rows.slice(0, REPEAT_ROWS).flatMap((row) => {
    const r = row as { id?: unknown; model_id?: unknown; name?: unknown; price?: unknown } | null;
    if (typeof r?.name !== "string") return [];
    const id = typeof r.id === "string" ? `${r.id.slice(0, 10)} ` : typeof r.model_id === "string" ? `${r.model_id} ` : "";
    return [`${id}${r.name}${typeof r.price === "number" ? ` ${r.price}` : ""}`];
  });
}

/** Identity of a research call: tool name plus its input with keys sorted, ignoring `limit` and default `in_stock: true`. */
function researchCallKey(name: string, input: unknown): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) return `${name}:${JSON.stringify(input)}`;
  const entries = Object.entries(input)
    .filter(([key, value]) => {
      if (key === "limit" || value === undefined) return false;
      if (name === "search_products" && key === "in_stock" && value === true) return false;
      return true;
    })
    .map(([key, value]): [string, unknown] =>
      key === "category" && typeof value === "string" ? [key, value.trim().toLowerCase()] : [key, value]
    );
  return `${name}:${JSON.stringify(entries.sort(([a], [b]) => a.localeCompare(b)))}`;
}

function batchSubLabel(sub: unknown, index: number): string {
  if (!sub || typeof sub !== "object") return `search_${index + 1}`;
  const s = sub as { category?: unknown; term?: unknown; query?: unknown; model_id?: unknown };
  const category = typeof s.category === "string" ? s.category.trim().toLowerCase() : "";
  const term = typeof s.term === "string" ? s.term.trim() : typeof s.query === "string" ? s.query.trim() : "";
  const modelId = typeof s.model_id === "string" ? s.model_id.trim() : "";
  if (category && term) return `${category}: ${term}`;
  if (category) return category;
  if (term) return term;
  if (modelId) return modelId;
  return `search_${index + 1}`;
}

/** Where the turn stands, read by the research gate when it runs a tool. */
export interface ResearchProgress {
  /** True once validate_build returned a presentable build this turn. */
  validated: () => boolean;
  /** True once validate_build was called this turn, whatever it returned. */
  validateCalled?: () => boolean;
  /** True when step policy is forcing validate_build before further research. */
  validateFirstForced?: () => boolean;
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

type SeenResearchEntry = {
  step: number;
  rows: string[];
  outcome: RepeatOutcome;
  limit: number;
};

/** True when an earlier search already covers this request's effective result limit. */
function isCoveredByEarlier(earlier: SeenResearchEntry, limit: number): boolean {
  if (earlier.outcome === "pending" || earlier.outcome === "empty") return true;
  return limit <= earlier.limit;
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
  // First step and widest effective limit of each distinct research call.
  const seen = new Map<string, SeenResearchEntry>();
  const allCoreSearched = () => CORE_SEARCH_CATEGORIES.every((category) => searched.has(category));
  const mustValidateFirst = () =>
    Boolean(progress?.validateFirstForced?.()) ||
    (Boolean(progress?.validateCalled) &&
      !progress!.validated() &&
      !progress!.validateCalled!() &&
      allCoreSearched() &&
      progress!.stepsUsed() + 1 >= VALIDATE_FIRST_STEP);
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
          return {
            results: [],
            search_closed: true,
            message: researchClosedMessage(stepsLeft, Boolean(progress?.validated()))
          } satisfies ClosedResearchOutput;
        }
        if (mustValidateFirst()) {
          return {
            results: [],
            search_closed: true,
            message: validateFirstMessage(progress!.stepsUsed() + 1)
          } satisfies ClosedResearchOutput;
        }

        if (name === "search_products" && input && typeof input === "object" && !Array.isArray(input) && "queries" in input && (input as { queries?: unknown }).queries !== undefined) {
          const normalized = normalizeSearchCallQueries(input);
          if (normalized.kind !== "batch") {
            return (execute as (input: unknown, options: unknown) => unknown)(input, options);
          }

          const capped = normalized.queries;
          const slotResults: Array<Record<string, unknown>> = new Array(capped.length);
          const toRun: Array<{
            index: number;
            sub: unknown;
            key: string;
            limit: number;
            entry: SeenResearchEntry;
            previous: SeenResearchEntry | undefined;
          }> = [];

          for (let i = 0; i < capped.length; i++) {
            const sub = capped[i];
            const subKey = researchCallKey("search_products", sub);
            const subLimit = effectiveSearchLimit(sub);
            const earlier = seen.get(subKey);
            if (earlier !== undefined && isCoveredByEarlier(earlier, subLimit)) {
              const cat = (sub as { category?: unknown } | null)?.category;
              slotResults[i] = {
                label: batchSubLabel(sub, i),
                ...(typeof cat === "string" ? { category: cat.trim().toLowerCase() } : {}),
                results: [],
                search_closed: true,
                repeated: true,
                message: repeatedSearchMessage(earlier.step, earlier.rows, earlier.outcome)
              };
              continue;
            }
            const entry: SeenResearchEntry = {
              step: (progress?.stepsUsed() ?? 0) + 1,
              rows: [],
              outcome: "pending",
              limit: subLimit
            };
            seen.set(subKey, entry);
            toRun.push({ index: i, sub, key: subKey, limit: subLimit, entry, previous: earlier });
          }

          if (toRun.length === 0) {
            return {
              batch: true,
              searches: slotResults,
              results: [],
              search_closed: true,
              repeated: true,
              message: slotResults.map((s) => `${String(s.label)}: ${String(s.message)}`).join("\n")
            };
          }

          const restoreEntry = (item: { key: string; previous: SeenResearchEntry | undefined }) => {
            if (item.previous) seen.set(item.key, item.previous);
            else seen.delete(item.key);
          };

          const rawRecord = input as Record<string, unknown>;
          const ignoredExtras = Object.fromEntries(normalized.ignored.map((k) => [k, rawRecord[k]]));
          let rawOutput: unknown;
          try {
            rawOutput = await (execute as (input: unknown, options: unknown) => unknown)(
              { ...ignoredExtras, queries: toRun.map((item) => item.sub) },
              options
            );
          } catch (error) {
            for (const item of toRun) restoreEntry(item);
            throw error;
          }

          const domain = unwrapToolOutput(rawOutput);
          if (typeof (domain as { error?: unknown } | null)?.error === "string") {
            for (const item of toRun) restoreEntry(item);
            return rawOutput;
          }

          const batchOut = domain as { batch?: unknown; searches?: unknown[] } | null;
          if (batchOut?.batch === true && Array.isArray(batchOut.searches)) {
            for (let j = 0; j < toRun.length; j++) {
              const item = toRun[j];
              const subOut = batchOut.searches[j] as Record<string, unknown> | undefined;
              if (!subOut || typeof subOut.error === "string") {
                restoreEntry(item);
                if (subOut) slotResults[item.index] = subOut;
                continue;
              }
              const cat =
                typeof (item.sub as { category?: unknown } | null)?.category === "string"
                  ? (item.sub as { category: string }).category
                  : typeof subOut.category === "string"
                    ? subOut.category
                    : undefined;
              if (cat) searched.add(cat.trim().toLowerCase());
              item.entry.rows = topRows(subOut);
              item.entry.outcome = resultRows(subOut)?.length === 0 ? "empty" : "rows";
              item.entry.limit = Math.max(item.previous?.limit ?? 0, item.limit);
              slotResults[item.index] = subOut;
            }
          } else {
            for (const item of toRun) {
              const cat = (item.sub as { category?: unknown } | null)?.category;
              if (typeof cat === "string") searched.add(cat.trim().toLowerCase());
              item.entry.rows = topRows(domain);
              item.entry.outcome = resultRows(domain)?.length === 0 ? "empty" : "rows";
              item.entry.limit = Math.max(item.previous?.limit ?? 0, item.limit);
              slotResults[item.index] = {
                label: batchSubLabel(item.sub, item.index),
                ...(typeof cat === "string" ? { category: cat.trim().toLowerCase() } : {}),
                ...(domain && typeof domain === "object" ? (domain as Record<string, unknown>) : {})
              };
            }
          }

          const merged: Record<string, unknown> = {
            ...(domain && typeof domain === "object" && !Array.isArray(domain) ? (domain as Record<string, unknown>) : {}),
            batch: true,
            searches: slotResults
          };
          if (normalized.truncated && typeof merged.note !== "string") {
            const batchNote = `Ran the first ${MAX_BATCH_QUERIES} sub-queries—the maximum per batch.`;
            merged.note = batchNote;
            merged.hint = typeof merged.hint === "string" ? `${merged.hint} ${batchNote}` : batchNote;
          }
          if (shouldNudge()) {
            return wrapIfMcp(rawOutput, { ...merged, next_step: validateNextNote(progress!.stepsUsed() + 1) });
          }
          const left = CORE_SEARCH_CATEGORIES.filter((c) => !searched.has(c));
          const coreSearched = CORE_SEARCH_CATEGORIES.length - left.length;
          const nextDomain =
            progress && !progress.validated() && coreSearched >= 2 && left.length > 0
              ? { ...merged, next_step: remainingSearchNote(left) }
              : merged;
          return wrapIfMcp(rawOutput, nextDomain);
        }

        const key = researchCallKey(name, input);
        const callLimit = name === "search_products" ? effectiveSearchLimit(input) : DEFAULT_SEARCH_LIMIT;
        const earlier = seen.get(key);
        if (earlier !== undefined && isCoveredByEarlier(earlier, callLimit)) {
          return {
            results: [],
            search_closed: true,
            repeated: true,
            message: repeatedSearchMessage(earlier.step, earlier.rows, earlier.outcome)
          } satisfies ClosedResearchOutput;
        }
        // Recorded before the await so a parallel identical call in the same step is caught;
        // a failed call restores the prior seen state so its retry runs.
        const entry: SeenResearchEntry = {
          step: (progress?.stepsUsed() ?? 0) + 1,
          rows: [],
          outcome: "pending",
          limit: callLimit
        };
        seen.set(key, entry);
        let rawOutput: unknown;
        try {
          rawOutput = await (execute as (input: unknown, options: unknown) => unknown)(input, options);
        } catch (error) {
          if (earlier) seen.set(key, earlier);
          else seen.delete(key);
          throw error;
        }
        const domain = unwrapToolOutput(rawOutput);
        if (typeof (domain as { error?: unknown } | null)?.error === "string") {
          if (earlier) seen.set(key, earlier);
          else seen.delete(key);
          return rawOutput;
        }
        const category = (input as { category?: unknown } | null)?.category;
        if (typeof category === "string") searched.add(category.trim().toLowerCase());
        entry.rows = topRows(domain);
        entry.outcome = resultRows(domain)?.length === 0 ? "empty" : "rows";
        entry.limit = Math.max(earlier?.limit ?? 0, callLimit);
        if (!domain || typeof domain !== "object" || Array.isArray(domain)) return rawOutput;
        if (shouldNudge()) {
          return wrapIfMcp(rawOutput, { ...(domain as Record<string, unknown>), next_step: validateNextNote(progress!.stepsUsed() + 1) });
        }
        const left = CORE_SEARCH_CATEGORIES.filter((c) => !searched.has(c));
        const coreSearched = CORE_SEARCH_CATEGORIES.length - left.length;
        return progress && !progress.validated() && coreSearched >= 2 && left.length > 0
          ? wrapIfMcp(rawOutput, { ...(domain as Record<string, unknown>), next_step: remainingSearchNote(left) })
          : rawOutput;
      }) as typeof execute,
      toModelOutput: (async (args: { output: unknown }) => {
        const domain = unwrapToolOutput(args.output);
        if (isClosedResearchOutput(domain)) return { type: "text", value: domain.message };
        const note = (domain as { next_step?: unknown } | null)?.next_step;
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
