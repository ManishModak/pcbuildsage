import { type OnFinishEvent, type OnStepFinishEvent, type ToolSet, type ModelMessage, type UIMessage, convertToModelMessages, isStepCount } from "ai";
import type { AppConfig } from "@/types";
import { streamTextWithFallback } from "./client";
import { appendChatLog } from "@/lib/logger";
import { createToolRegistry, getCatalog } from "@/lib/tools";
import type { CatalogRepository, GetCatalogResult } from "@/lib/catalog";
import { getPersonality } from "./personalities";
import { getSession, saveSession, setSessionCompacting, type StoredCompactContext } from "@/lib/sessions";
import { type ChatMessage, capMessages, deriveBuildState } from "./messages";
import {
  getModelContextLimit,
  shouldTriggerCompaction,
  measureToolDefinitionsTokens,
  calculateStepTokens
} from "./context-budget";
import { compactConversation } from "./compaction";
import type { BuildSnapshot } from "../catalog/build-snapshot";
import { isHostedDemo } from "../config/deployment";
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
    `Active scope: country ${config.countryCode}, currency ${config.currency}. All prices returned by tools are standard major currency values (e.g. standard Rupees or Dollars). Present them exactly as returned by the tools without division or scale adjustment.`,
    catalogBlock,
    ...BRIEF_STRATEGY_LINES,
    "When useful, call suggest_followups with short, relevant user prompts about unanswered next steps; omit it when none would help.",
    personality ? `Personality prompt: ${personality.prompt}` : "",
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
    "Validate each proposed build with validate_build before presenting it. Check earlier when compatibility affects a component choice. Always use the snapshot total from validate_build when checking budget or presenting the build, rather than calculating or guessing your own total.",
    "Treat initial configurations as tentative until catalog prices confirm the total.",
    "Call `present_build` to present proposed PC builds so the interactive Build Card renders with component tables, retailer links, and verified pricing. Finalize component choices and run compatibility checks before calling present_build. Include all intended alternatives together in one call with short labels such as 'Within budget' and 'Small upgrade'. If a later correction is needed, present a revised version and explain what changed. Never output raw component markdown tables or part price lists in your text message. Use your text response exclusively to explain component rationale, expected performance for that workload, tradeoffs, and upgrade paths.",
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

function persistSessionCompactContext(
  sessionId: string | undefined,
  messages: ModelMessage[],
  boundaryMessageId?: string,
  snapshot?: BuildSnapshot | null
): void {
  if (isHosted() || !sessionId) return;
  const current = getSession(sessionId);
  if (!current) return;
  const nextRev = (current.revision ?? 0) + 1;
  saveSession({
    id: sessionId,
    revision: nextRev,
    compactContext: {
      messages,
      boundaryMessageId,
      snapshot: snapshot ?? null
    }
  });
}

export async function streamChat(
  config: AppConfig,
  messages: ChatMessage[],
  sessionId?: string,
  abortSignal?: AbortSignal,
  clientCompactContext?: StoredCompactContext | null,
  responseMessageId?: string
) {
  const lastUser = messages.filter((message) => message.role === "user").at(-1);
  if (lastUser) {
    await appendChatLog({ role: "user", content: lastUser.content ?? "", session_id: sessionId });
  }
  let systemPrompt = buildSystemPrompt(config, await loadCatalogSummary(config));
  const session = (!isHosted() && sessionId) ? getSession(sessionId) : null;
  const buildState = session?.build_state ?? deriveBuildState(messages as unknown as UIMessage[]);
  if (buildState) {
    systemPrompt += `\n\nCurrent build state (authoritative): ${JSON.stringify(buildState)}`;
  }
  const truncatedSystem = systemPrompt.slice(0, 500) + (systemPrompt.length > 500 ? "..." : "");
  await appendChatLog({ role: "system", content: truncatedSystem, session_id: sessionId });

  const activeEntry = config.llm.roles.chat[0];
  const contextLimit = getModelContextLimit(activeEntry);

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
    }))
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
            }))
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

  const tools = createToolRegistry(config);
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
      const initialCompaction = await compactConversation({
        chain: config.llm.roles.chat,
        systemPrompt,
        messages: initialModelMessages,
        snapshot: sessionSnapshot,
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
    // 25 on purpose: small local models (≤27B quants) and ranking several builds from in-stock parts need the steps; 14 was tested and is too low.
    stopWhen: isStepCount(25),
    abortSignal,
    prepareStep: async ({ steps, messages: currentMessages }) => {
      const currentTokens = calculateStepTokens({
        steps,
        currentMessages,
        systemPrompt,
        toolsOverhead
      });
      if (shouldTriggerCompaction(currentTokens, contextLimit)) {
        if (!isHosted() && sessionId) setSessionCompacting(sessionId, true);
        try {
          let latestSnapshot = (buildState as { snapshot?: BuildSnapshot } | null)?.snapshot;
          for (const step of steps) {
            for (const res of step.toolResults || []) {
              const snap = getSnapshotFromOutput((res as { output?: unknown }).output);
              if (snap) latestSnapshot = snap;
            }
          }

          const compaction = await compactConversation({
            chain: config.llm.roles.chat,
            systemPrompt,
            messages: currentMessages,
            snapshot: latestSnapshot,
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
            return { messages: compaction.messages };
          }
        } finally {
          if (!isHosted() && sessionId) setSessionCompacting(sessionId, false);
        }
      }
      return {};
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
