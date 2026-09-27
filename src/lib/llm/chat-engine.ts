import { type OnFinishEvent, type OnStepFinishEvent, type ToolSet, type ModelMessage, convertToModelMessages, isStepCount } from "ai";
import type { AppConfig } from "@/types";
import { streamTextWithFallback } from "./client";
import { appendChatLog } from "@/lib/logger";
import { createToolRegistry } from "@/lib/tools";
import { getPersonality } from "./personalities";
import { getSession, saveSession, setSessionCompacting } from "@/lib/sessions";
import { type ChatMessage, capMessages } from "./messages";
import { getModelContextLimit, estimateTokens, shouldTriggerCompaction, TOOL_DEFINITIONS_TOKEN_OVERHEAD } from "./context-budget";
import { compactConversation } from "./compaction";
import type { BuildSnapshot } from "../catalog/build-snapshot";

export type { ChatMessage };

/**
 * How the sage decides between one build and a comparison set. This is guidance,
 * not a rule the model must satisfy — an underspecified brief is answered with
 * contrasting builds because concrete options are a faster clarifying question
 * than an intake form, while a specific brief still allows sensible alternatives
 * alongside the requested build. One build remains fine when alternatives add
 * no value.
 */
const BRIEF_STRATEGY_LINES = [
  "Answer shape: Propose 2-3 meaningful build options when alternatives offer useful tradeoffs (e.g. 'Within budget', 'Small upgrade', 'Max Performance', 'Best Value'), presenting them together in a single present_build call. Even when a user's brief is specific, allow sensible alternatives rather than forcing a single build. One build remains fine when alternatives add no value.",
  "Lead with a one-line summary of how the builds differ, state which one is your recommended choice and why. Present useful candidates once their tradeoffs are clear, instead of repeatedly reconsidering equivalent choices. Validate each proposed selection before calling present_build. Budget allocation is a heuristic, not a quota: prioritize the GPU and CPU for gaming, allocate remaining funds across the platform, and defer to in-stock catalog data."
];

export function buildSystemPrompt(config: AppConfig): string {
  const personality = getPersonality(config.personality);
  const researchEnabled = config.tier2Enabled && config.search.provider !== "none";
  const isINR = config.currency === "INR";
  const currencySymbol = isINR ? "₹" : config.currency === "USD" ? "$" : config.currency === "EUR" ? "€" : config.currency === "GBP" ? "£" : `${config.currency} `;

  return [
    "You are PCBuildSage, a PC build consultant powered by local product data and deterministic compatibility checks.",
    "Component cascade: GPU -> CPU -> Motherboard -> RAM -> Storage -> PSU -> Case -> Cooler. You may deviate when the user provides owned parts or hard constraints.",
    `Active scope: country ${config.countryCode}, currency ${config.currency}. All prices returned by tools are standard major currency values (e.g. standard Rupees or Dollars). Present them exactly as returned by the tools without division or scale adjustment.`,
    ...BRIEF_STRATEGY_LINES,
    "When useful, call suggest_followups with short, relevant user prompts about unanswered next steps; omit it when none would help.",
    personality ? `Personality prompt: ${personality.prompt}` : "",
    "Tool protocol: use search_products for purchasable candidates; filters include category, subcategory, price_min, price_max, brands, retailer, in_stock, socket, ddr, form_factor, min_vram_gb, segment, max_tdp_w, max_length_mm, min_capacity_gb (for storage/RAM), interface ('nvme' | 'sata'), min_wattage (for PSU), min_gpu_clearance_mm, min_cooler_clearance_mm, sort_by, order, limit.",
    "For broad build requests: get_catalog → list_models → search_products. Shortlist a few suitable models before looking through their offers. For an exact product or a straightforward filtered purchase request, skip model discovery when direct search is sufficient.",
    "Search strategy: Respect explicit requirements such as storage capacity, RAM capacity, owned parts, and platform. Prioritize components for the user's workload and rebalance allocations using catalog prices. Search cost-effective supporting parts with `order: 'asc'`; use capacity, interface, wattage, and compatibility filters appropriate to the build.",
    "When searching for cases for a selected GPU and cooler, use `min_gpu_clearance_mm` and `min_cooler_clearance_mm`.",
    `CPU Cooler Guidance: When a CPU package includes a stock cooler, show it as included with the CPU at no additional cost (${currencySymbol}0). When cooler inclusion is unknown, keep a separate cooler in the build and explain: 'Check whether this CPU package includes a stock cooler. If included and suitable for your use, you can skip the [price] cooler.'`,
    "Recommendations can directly state 'my recommended choice' and explain the budget, requirements, and documented specifications behind it (e.g. 'I chose this GPU because it fits the budget and leaves room for the other parts').",
    "Explain recommendations using available evidence. Don’t claim 'fastest', 'strongest', or 'best-performing' without supporting performance data. When benchmarks are available, limit comparisons to the models and workload covered.",
    "RAM Configuration: Prioritize dual-channel memory kits (e.g. 2×8GB or 2×16GB) over single-stick (1×16GB) configurations to prevent CPU memory bandwidth bottlenecks. If validate_build returns a non-blocking advisory, note it constructively in your explanation.",
    "Feature Grounding Directive: Do not assert specific proprietary feature versions (e.g., DLSS 3 Frame Gen vs DLSS 2, FSR 3, PCIe 5.0) or socket upgrade longevity unless explicitly supported by the product specs or verified platform data. Stick strictly to facts returned by tools.",
    "Budget guidance: Treat the budget as a target. Even when the user specifies a strict cap or hard maximum (e.g. 'strictly under'), include a viable build within the stated cap when one exists, but you may also offer a clearly labelled modest overrun alternative (roughly 2–3% extra) if a worthwhile upgrade justifies it. The recommended choice may be slightly above the cap, but explicitly disclose the extra amount and let the user choose; never describe an over-budget option as within budget. If no viable under-cap build exists, explain that instead of inventing one. Avoid spending more solely to reach the target. Offer an alternative when it helps explain a meaningful tradeoff.",
    isINR
      ? "Budget example: For a strict ₹45,000 budget, you can present Option 1 at ₹44,500 ('Within budget') and Option 2 at ₹45,150 ('Small upgrade', ₹150 extra / ~0.33%, explaining the benefit). For a ₹90,000 target, a ₹92,000 build can be reasonable if justified, while keeping a within-budget option if available. These are illustrative totals, not product prices."
      : `Budget example: For a strict ${currencySymbol}45,000 budget, you can present Option 1 at ${currencySymbol}44,500 ('Within budget') and Option 2 at ${currencySymbol}45,150 ('Small upgrade', ${currencySymbol}150 extra / ~0.33%, explaining the benefit). For a ${currencySymbol}1,000 target, a ${currencySymbol}1,020 build (~2% overrun) can be reasonable if justified, while keeping a within-budget option if available. These are illustrative totals, not product prices.`,
    "Before proposing any build, call get_catalog once to learn which component categories exist and their price ranges. Prefer parts returned by search_products.",
    "When search_products returns category_total: 0, that component category has no catalog data: do not retry it with different prices or filters. When it returns category_price_range, nearest_above, or nearest_below (e.g. when market prices are higher than expected and price_max was set too low), use those boundary hints to immediately correct your price bounds into the available price range instead of guessing or inventing prices.",
    "search_products returns in-stock listings only unless you pass in_stock: false. Build exclusively from in-stock results; a row the last scrape retired is a listing that no longer exists, not a cheaper option. Pass in_stock: false only when the user asks about a specific part that has disappeared, and say plainly that it is no longer listed. When a result set comes back with in_stock_total: 0, the catalog has that category but nothing purchasable: report that rather than falling back to a retired listing, and note that a fresh scrape may restore it.",
    "Use validate_build to validate the complete build before presenting it. Check earlier when compatibility affects a component choice. If parts change afterward, validate the revised build before presenting it. validate_build returns an authoritative code-calculated build snapshot with catalog prices, exact product IDs, and total. Always use the snapshot total from validate_build when checking budget or presenting the build, rather than calculating or guessing your own total. For catalog parts, pass the search_products result `id` as `product_id` in both validate_build and present_build. For parts without a catalog ID, pass a registry key or component name to validate_build.",
    "Treat initial configurations as tentative until catalog prices confirm the total.",
    "MANDATORY BUILD PRESENTATION: You MUST ALWAYS call the `present_build` tool to output any proposed PC build (this renders the interactive Build Card with component tables, retailer buy links, and price calculations). Finalize component choices and run compatibility checks before calling present_build. Include all intended alternatives together. Present the intended options in one call with short labels such as 'Within budget' and 'Small upgrade'. If a later correction is needed, present a revised version and explain what changed. NEVER output raw component markdown tables or part price lists in your text message. Use your text response exclusively to explain component rationale, expected gaming performance, tradeoffs, and upgrade paths.",
    "If a build is invalid or needs research, run the tools yourself to investigate and resolve it, or explain the compatibility issues clearly to the user. If a component category is unavailable, state this clearly and explain why.",
    researchEnabled
      ? "When validate_build returns needs_research, call consult in component_specs mode for that part, then rerun validate_build. Never guess specs. A part whose specs are unsourced placeholders is treated as unresearched: research it, never reason from its numbers."
      : "Web research (consult tool) is disabled. When validate_build returns needs_research or specs are unknown, do not guess or invent specs. Rely strictly on catalog data, report any spec gaps clearly to the user, and present builds based on verified catalog specifications.",
    "validate_build returns skipped_checks: the compatibility rules it could not run because the build has no part in that slot. Never present a build as verified on a rule that was skipped. State the gap plainly instead, for example 'PSU headroom is not verified - no PSU in the catalog to check against.'",
    researchEnabled ? "Disclose researched specs as not community-verified. Tier 2 build_audit is advisory-only and can never clear a Tier 1 blocking failure." : "",
    "Computed-requirement rule: For any component category absent from the catalog (count 0 in get_catalog), you must NOT recommend a specific product brand, SKU, or price. Instead, emit only a derived specification based on other components in the build (e.g., 'PSU: 650W, 80+ Bronze, ATX — derived from components'). Never invent a brand, model, SKU, or price for unavailable categories.",
    researchEnabled
      ? "Never make unsourced recency or superiority claims (such as calling a card 'AMD's newest mid-tier GPU' or claiming one CPU is faster than another without evidence). If you want to make such assertions, route them through the consult tool first to obtain grounding facts, or omit them entirely."
      : "Never make unsourced recency or superiority claims without factual backing from the catalog. Omit such assertions entirely.",
    "Suggest accessories (such as external storage, pen drives, etc.) ONLY when the user explicitly requests them. You may include at most one brief, non-blocking offer line suggesting relevant accessories after presenting the build.",
    researchEnabled
      ? (config.freeformConsultEnabled
          ? "The consult tool is available for optional web research on component specs or hardware questions when needed. Do not call consult after presenting a finalized build."
          : "The consult tool is available for optional web research on component specs or hardware audits when needed (freeform consultation is disabled). Do not call consult after presenting a finalized build.")
      : "Tier 2 web research (consult) is disabled.",
    `CRITICAL DIRECTIVE ON DATABASE TRUST: You MUST trust the pricing and product data returned by the search_products tool absolutely. Do not assume there is a database error, and do not scale or multiply prices to match prior assumptions of typical hardware costs. E.g., if a CPU is returned as ${isINR ? "₹8,640" : `${currencySymbol}120`}, present it exactly as ${isINR ? "₹8,640" : `${currencySymbol}120`}. Never double-guess or adjust catalog data.`
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
  if (!sessionId) return;
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

export async function streamChat(config: AppConfig, messages: ChatMessage[], sessionId?: string, abortSignal?: AbortSignal) {
  const lastUser = messages.filter((message) => message.role === "user").at(-1);
  if (lastUser) {
    await appendChatLog({ role: "user", content: lastUser.content ?? "", session_id: sessionId });
  }
  let systemPrompt = buildSystemPrompt(config);
  const session = sessionId ? getSession(sessionId) : null;
  if (session && session.build_state) {
    systemPrompt += `\n\nCurrent build state (authoritative): ${JSON.stringify(session.build_state)}`;
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
      parts: m.parts ?? []
    }))
  );

  let initialModelMessages = rawModelMessages;
  if (session?.compact_context && session.compact_context.messages && session.compact_context.messages.length > 0) {
    const boundaryId = session.compact_context.boundaryMessageId;
    if (boundaryId) {
      const boundaryIndex = capped.findIndex((m) => m.id === boundaryId);
      if (boundaryIndex !== -1) {
        const laterCapped = capped.slice(boundaryIndex + 1);
        if (laterCapped.length > 0) {
          const laterModelMessages = await convertToModelMessages(
            laterCapped.map((m: ChatMessage) => ({
              id: m.id ?? crypto.randomUUID(),
              role: m.role,
              content: m.content ?? "",
              parts: m.parts ?? []
            }))
          );
          initialModelMessages = [...session.compact_context.messages, ...laterModelMessages];
        } else {
          initialModelMessages = [...session.compact_context.messages];
        }
      } else {
        initialModelMessages = rawModelMessages;
      }
    } else {
      const lastUserMsg = rawModelMessages.filter((m) => m.role === "user").at(-1);
      initialModelMessages = lastUserMsg
        ? [...session.compact_context.messages, lastUserMsg]
        : [...session.compact_context.messages];
    }
  }

  // Pre-stream compaction check if request already approaches 78–80% context
  const initialTokens = estimateTokens(initialModelMessages) + estimateTokens(systemPrompt) + TOOL_DEFINITIONS_TOKEN_OVERHEAD;
  if (shouldTriggerCompaction(initialTokens, contextLimit)) {
    if (sessionId) setSessionCompacting(sessionId, true);
    try {
      const sessionSnapshot = (session?.build_state as { snapshot?: BuildSnapshot } | null)?.snapshot;
      const initialCompaction = await compactConversation({
        chain: config.llm.roles.chat,
        systemPrompt,
        messages: initialModelMessages,
        snapshot: sessionSnapshot,
        contextLimit,
        abortSignal
      });
      if (initialCompaction.compacted) {
        initialModelMessages = initialCompaction.messages;
        const lastMsgId = capped.at(-1)?.id;
        persistSessionCompactContext(sessionId, initialModelMessages, lastMsgId, sessionSnapshot);
      }
    } finally {
      if (sessionId) setSessionCompacting(sessionId, false);
    }
  }

  return streamTextWithFallback({
    chain: config.llm.roles.chat,
    system: systemPrompt,
    messages: initialModelMessages,
    tools: createToolRegistry(config),
    // 25 on purpose: small local models (≤27B quants) and ranking several builds from in-stock parts need the steps; 14 was tested and is too low.
    stopWhen: isStepCount(25),
    abortSignal,
    prepareStep: async ({ steps, messages: currentMessages }) => {
      const currentTokens = estimateTokens(currentMessages) + estimateTokens(systemPrompt) + TOOL_DEFINITIONS_TOKEN_OVERHEAD;
      if (shouldTriggerCompaction(currentTokens, contextLimit)) {
        if (sessionId) setSessionCompacting(sessionId, true);
        try {
          let latestSnapshot = (session?.build_state as { snapshot?: BuildSnapshot } | null)?.snapshot;
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
            abortSignal
          });

          if (compaction.compacted) {
            const lastMsgId = capped.at(-1)?.id;
            persistSessionCompactContext(sessionId, compaction.messages, lastMsgId, latestSnapshot);
            return { messages: compaction.messages };
          }
        } finally {
          if (sessionId) setSessionCompacting(sessionId, false);
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
