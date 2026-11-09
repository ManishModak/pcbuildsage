import type { ToolSet } from "ai";
import { FAR_OVER_BUDGET } from "@/lib/tools/validate-build";
import { presentRefusal } from "@/lib/tools/present-build";

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
export function buildPending(steps: StepLike[] | undefined | null): boolean {
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
export function stepsLeftAfter(stepNumber: number): number {
  return Math.max(0, FINAL_STEP - stepNumber);
}

/** Tool result a closed research tool returns in place of running. */
export function researchClosedMessage(stepsLeft: number): string {
  return `Search is closed for this turn (${stepsLeft} step${stepsLeft === 1 ? "" : "s"} left). Call validate_build now with the best parts you've already found, then present_build a valid build.`;
}

/** Instruction appended to the system prompt while research is closed. */
export function researchClosedInstruction(stepsLeft: number): string {
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
  const seen = new Map<string, { step: number; rows: string[]; outcome: RepeatOutcome }>();
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
          return { results: [], search_closed: true, message: repeatedSearchMessage(earlier.step, earlier.rows, earlier.outcome) } satisfies ClosedResearchOutput;
        }
        // Recorded before the await so a parallel identical call in the same step is caught;
        // a failed call is forgotten so its retry runs.
        const entry = { step: (progress?.stepsUsed() ?? 0) + 1, rows: [] as string[], outcome: "pending" as RepeatOutcome };
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
        entry.outcome = resultRows(output)?.length === 0 ? "empty" : "rows";
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
