import type { ModelMessage, ToolCallPart, ToolResultPart } from "ai";
import type { LLMChainEntry } from "@/types";
import { generateTextWithFallback } from "./client";
import type { BuildSnapshot } from "../catalog/build-snapshot";
import { formatSnapshotsForContext } from "./snapshot-formatter";
import { estimateTokens, shouldTriggerCompaction, RESERVED_OUTPUT_TOKENS } from "./context-budget";

export interface CompactionParams {
  chain: LLMChainEntry[];
  systemPrompt: string;
  messages: ModelMessage[];
  snapshot?: BuildSnapshot | BuildSnapshot[] | null;
  snapshots?: BuildSnapshot[] | null;
  contextLimit: number;
  force?: boolean;
  abortSignal?: AbortSignal;
}

export type CompactionResult =
  | {
      compacted: true;
      messages: ModelMessage[];
      handoffText: string;
      tokensBefore: number;
      tokensAfter: number;
    }
  | {
      compacted: false;
      messages: ModelMessage[];
      tokensBefore: number;
      tokensAfter: number;
      reason: string;
    };

interface SearchCallMeta {
  category?: string;
  query?: string;
  priceMax?: number;
}

interface SearchToolOutput {
  results?: unknown[];
  items?: unknown[];
  total_matching?: number;
  in_stock_total?: number;
  error?: string;
}

export interface ShortlistProduct {
  id: string;
  category: string;
  name: string;
  price: number | null;
  currency?: string;
}

function isSearchToolResult(part: unknown): part is {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  output?: unknown;
  result?: unknown;
} {
  if (!part || typeof part !== "object") return false;
  const p = part as Record<string, unknown>;
  return p.type === "tool-result" && p.toolName === "search_products" && typeof p.toolCallId === "string";
}

function isValidateBuildToolResult(part: unknown): part is {
  type: "tool-result";
  toolCallId: string;
  toolName?: string;
  output?: unknown;
  result?: unknown;
} {
  if (!part || typeof part !== "object") return false;
  const p = part as Record<string, unknown>;
  return p.type === "tool-result" && typeof p.toolCallId === "string";
}

/**
 * Extract a concise list of unsuccessful tool calls (e.g. search_products returning 0 matches)
 * preserving query/term and filter criteria so the resumed turn avoids repeating identical dead ends.
 */
export function extractUnsuccessfulSearches(messages: ModelMessage[]): string[] {
  const callArgs = new Map<string, SearchCallMeta>();

  for (const message of messages) {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part && typeof part === "object") {
          const p = part as Record<string, unknown>;
          if (p.type === "tool-call" && p.toolName === "search_products" && typeof p.toolCallId === "string") {
            const rawArgs = p.args ?? p.input;
            if (rawArgs && typeof rawArgs === "object") {
              const argsObj = rawArgs as Record<string, unknown>;
              const termOrQuery =
                typeof argsObj.term === "string"
                  ? argsObj.term
                  : typeof argsObj.query === "string"
                    ? argsObj.query
                    : undefined;
              callArgs.set(p.toolCallId, {
                category: typeof argsObj.category === "string" ? argsObj.category : undefined,
                query: termOrQuery,
                priceMax: typeof argsObj.price_max === "number" ? argsObj.price_max : undefined
              });
            }
          }
        }
      }
    }
  }

  const deadEnds: string[] = [];

  for (const message of messages) {
    if (message.role === "tool" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (isSearchToolResult(part)) {
          const rawOutput = part.output ?? part.result;
          const output =
            rawOutput && typeof rawOutput === "object" && "value" in rawOutput
              ? (rawOutput as { value: unknown }).value
              : rawOutput;

          if (output && typeof output === "object") {
            const outObj = output as SearchToolOutput;
            const count = Array.isArray(outObj.results)
              ? outObj.results.length
              : Array.isArray(outObj.items)
                ? outObj.items.length
                : 0;
            const isOos = outObj.in_stock_total === 0;
            const hasError = Boolean(outObj.error);

            if (count === 0 || isOos || hasError) {
              const meta = callArgs.get(part.toolCallId);
              const filterParts: string[] = [];
              if (meta?.category) filterParts.push(`category: ${meta.category}`);
              if (meta?.query) filterParts.push(`query: "${meta.query}"`);
              if (meta?.priceMax !== undefined) filterParts.push(`max: ${meta.priceMax}`);

              const filterStr = filterParts.length > 0 ? ` (${filterParts.join(", ")})` : "";
              const note = outObj.error ? `Error: ${outObj.error}` : "0 in-stock results";
              deadEnds.push(`search_products${filterStr} returned ${note}`);
            }
          }
        }
      }
    }
  }

  return Array.from(new Set(deadEnds)).slice(0, 5);
}

/**
 * Extract a shortlist of recent search_products results in code (ID, category, name, price, max ~20 rows)
 * so the model does not repeat catalog searches after compaction.
 */
export function extractRecentSearchShortlist(messages: ModelMessage[], maxRows = 20): ShortlistProduct[] {
  const toolCallCategories = new Map<string, string>();
  for (const message of messages) {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part && typeof part === "object") {
          const p = part as Record<string, unknown>;
          if (p.type === "tool-call" && p.toolName === "search_products" && typeof p.toolCallId === "string") {
            const rawArgs = p.args ?? p.input;
            if (rawArgs && typeof rawArgs === "object") {
              const argsObj = rawArgs as Record<string, unknown>;
              if (typeof argsObj.category === "string") {
                toolCallCategories.set(p.toolCallId, argsObj.category);
              }
            }
          }
        }
      }
    }
  }

  const seenIds = new Set<string>();
  const collected: ShortlistProduct[] = [];

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === "tool" && Array.isArray(message.content)) {
      for (let j = message.content.length - 1; j >= 0; j--) {
        const part = message.content[j];
        if (isSearchToolResult(part)) {
          const rawOutput = part.output ?? part.result;
          const output =
            rawOutput && typeof rawOutput === "object" && "value" in rawOutput
              ? (rawOutput as { value: unknown }).value
              : rawOutput;

          if (output && typeof output === "object") {
            const outObj = output as Record<string, unknown>;
            const rawResults = Array.isArray(outObj.results)
              ? outObj.results
              : Array.isArray(outObj.items)
                ? outObj.items
                : [];

            const scopeCurrency =
              typeof (outObj.scope as { currency?: string })?.currency === "string"
                ? (outObj.scope as { currency: string }).currency
                : undefined;

            for (const item of rawResults) {
              if (item && typeof item === "object") {
                const itemObj = item as Record<string, unknown>;
                const id =
                  typeof itemObj.id === "string"
                    ? itemObj.id.trim()
                    : typeof itemObj.product_id === "string"
                      ? itemObj.product_id.trim()
                      : "";
                const name =
                  typeof itemObj.name === "string"
                    ? itemObj.name.trim()
                    : typeof itemObj.title === "string"
                      ? itemObj.title.trim()
                      : "";
                const category =
                  typeof itemObj.category === "string" && itemObj.category.trim()
                    ? itemObj.category.trim().toLowerCase()
                    : (toolCallCategories.get(part.toolCallId)?.trim().toLowerCase() ?? "component");
                const price = typeof itemObj.price === "number" ? itemObj.price : null;
                const currency = typeof itemObj.currency === "string" ? itemObj.currency : scopeCurrency;

                if (id && name && !seenIds.has(id)) {
                  seenIds.add(id);
                  collected.push({ id, category, name, price, currency });
                  if (collected.length >= maxRows) {
                    return collected;
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  return collected;
}

/**
 * Format extracted shortlist products for inclusion into the synthetic context message.
 */
export function formatShortlistForContext(shortlist: ShortlistProduct[]): string {
  if (shortlist.length === 0) return "";
  const lines = shortlist.map((p) => {
    const priceStr = p.price !== null ? (p.currency ? `${p.currency} ${p.price}` : `${p.price}`) : "Price unknown";
    return `- [${p.id}] (${p.category}) ${p.name} — ${priceStr}`;
  });
  return [
    `[Recent Search Shortlist]`,
    `Recent product search results available for consideration:`,
    ...lines
  ].join("\n");
}

/**
 * Extract all authoritative build snapshots from the most recent validate_build tool result.
 * Supports batched validate_build outputs where builds are keyed by label as well as legacy single outputs.
 */
export function extractBuildSnapshots(
  messages: ModelMessage[],
  fallbackSnapshot?: BuildSnapshot | BuildSnapshot[] | null
): BuildSnapshot[] {
  const validateCallIds = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part && typeof part === "object") {
          const p = part as Record<string, unknown>;
          if (p.type === "tool-call" && p.toolName === "validate_build" && typeof p.toolCallId === "string") {
            validateCallIds.add(p.toolCallId);
          }
        }
      }
    }
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === "tool" && Array.isArray(message.content)) {
      for (let j = message.content.length - 1; j >= 0; j--) {
        const part = message.content[j];
        if (
          isValidateBuildToolResult(part) &&
          (part.toolName === "validate_build" || validateCallIds.has(part.toolCallId))
        ) {
          const rawOutput = part.output ?? part.result;
          const output =
            rawOutput && typeof rawOutput === "object" && "value" in rawOutput
              ? (rawOutput as { value: unknown }).value
              : rawOutput;

          if (output && typeof output === "object") {
            const outObj = output as Record<string, unknown>;
            const snapshots: BuildSnapshot[] = [];

            if (outObj.builds && typeof outObj.builds === "object") {
              if (Array.isArray(outObj.builds)) {
                for (const b of outObj.builds) {
                  if (b && typeof b === "object") {
                    if ("snapshot" in b && b.snapshot && typeof b.snapshot === "object") {
                      snapshots.push(b.snapshot as BuildSnapshot);
                    } else if ("components" in b && Array.isArray((b as Record<string, unknown>).components)) {
                      snapshots.push(b as unknown as BuildSnapshot);
                    }
                  }
                }
              } else {
                for (const val of Object.values(outObj.builds as Record<string, unknown>)) {
                  if (val && typeof val === "object") {
                    if ("snapshot" in val && val.snapshot && typeof val.snapshot === "object") {
                      snapshots.push(val.snapshot as BuildSnapshot);
                    } else if ("components" in val && Array.isArray((val as Record<string, unknown>).components)) {
                      snapshots.push(val as unknown as BuildSnapshot);
                    }
                  }
                }
              }
            }

            if (snapshots.length === 0 && outObj.snapshot && typeof outObj.snapshot === "object") {
              snapshots.push(outObj.snapshot as BuildSnapshot);
            }

            if (snapshots.length > 0) {
              return snapshots;
            }
          }
        }
      }
    }
  }

  if (fallbackSnapshot) {
    if (Array.isArray(fallbackSnapshot)) {
      return fallbackSnapshot.filter(Boolean);
    }
    return [fallbackSnapshot];
  }

  return [];
}

export function extractMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === "object" && "text" in c && typeof c.text === "string" ? c.text : ""))
      .filter(Boolean)
      .join(" ");
  }
  return "";
}

/**
 * Prepare a compact extraction of history to pass to the handoff summarizer.
 * Preserves prior handoff, recent assistant rationale, user corrections, snapshot, and search dead ends.
 */
function prepareSummarizerPrompt(
  messages: ModelMessage[],
  snapshots?: BuildSnapshot[] | null,
  contextLimit = 32768
): string {
  const userMessages = messages.filter((m) => m.role === "user");
  const firstUser = userMessages[0];
  const initialBrief = firstUser ? extractMessageText(firstUser.content) : "PC build request";

  let priorHandoff = "";
  for (const m of messages) {
    if (m.role === "assistant") {
      const text = extractMessageText(m.content);
      if (text.includes("[Progress & Handoff Summary]")) {
        priorHandoff = text;
      }
    }
  }

  const assistantNotes: string[] = [];
  for (const m of messages.slice(-8)) {
    if (m.role === "assistant") {
      const text = extractMessageText(m.content);
      if (text && !text.includes("[Progress & Handoff Summary]") && text.length > 20) {
        assistantNotes.push(text.slice(0, 300));
      }
    }
  }

  const corrections = userMessages
    .slice(1)
    .map((m) => extractMessageText(m.content))
    .filter(Boolean)
    .slice(-10);

  const unsuccessful = extractUnsuccessfulSearches(messages);
  const shortlist = extractRecentSearchShortlist(messages);

  const sections = [
    `=== ORIGINAL USER REQUEST & CONSTRAINTS ===\n${initialBrief.slice(0, 1500)}`,
    priorHandoff ? `=== PREVIOUS HANDOFF ===\n${priorHandoff.slice(0, 2000)}` : "",
    corrections.length > 0 ? `=== USER CORRECTIONS & FOLLOW-UPS ===\n${corrections.join("\n").slice(0, 2000)}` : "",
    assistantNotes.length > 0 ? `=== RECENT COMPONENT DECISIONS & TRADEOFFS ===\n${assistantNotes.join("\n---\n").slice(0, 1500)}` : "",
    snapshots && snapshots.length > 0 ? `=== CURRENT CODE-CALCULATED BUILD SNAPSHOT ===\n${formatSnapshotsForContext(snapshots)}` : "",
    unsuccessful.length > 0 ? `=== SEARCH DEAD ENDS ===\n${unsuccessful.join("\n")}` : "",
    shortlist.length > 0 ? `=== RECENT SEARCH SHORTLIST ===\n${formatShortlistForContext(shortlist)}` : ""
  ].filter(Boolean);

  let prompt = sections.join("\n\n");
  const maxChars = Math.max(10_000, (contextLimit - 8_000) * 3);
  if (prompt.length > maxChars) {
    prompt = prompt.slice(0, maxChars) + "\n[Earlier history truncated for budget]";
  }
  return prompt;
}

/**
 * Generate a model-written handoff covering progress, decisions, and intended next step.
 */
export async function generateHandoff({
  chain,
  contextData,
  abortSignal
}: {
  chain: LLMChainEntry[];
  contextData: string;
  abortSignal?: AbortSignal;
}): Promise<string> {
  const systemInstruction = [
    "You are an internal summarizer for PCBuildSage.",
    "Provide a concise, factual handoff summary for the assistant to continue the conversation in a fresh context.",
    "Cover:",
    "1. Original User Request & Hard Constraints (budget, form factor, workload, owned parts).",
    "2. Key Decisions & Component Choices Made So Far.",
    "3. Alternatives Checked & Unsuccessful Searches (note dead ends so they are not repeated).",
    "4. Unresolved Questions & Compatibility Gaps.",
    "5. Intended Immediate Next Step.",
    "CRITICAL: Do NOT invent or recalculate product IDs, prices, or totals—those are maintained authoritatively by code. Keep the summary dense and factual under 400 words."
  ].join("\n");

  const prompt = `Review the work done so far and write the concise handoff summary:\n\n${contextData}`;

  const result = await generateTextWithFallback({
    chain,
    system: systemInstruction,
    prompt,
    abortSignal
  });

  return result.text;
}

/**
 * Retain a recent complete tool exchange by matching call IDs and all corresponding results.
 * Only retained when the conversation is mid-turn at an active tool exchange tail (last message is tool).
 */
function extractRetainedToolExchange(messages: ModelMessage[]): ModelMessage[] {
  const lastMsg = messages[messages.length - 1];
  if (!lastMsg || lastMsg.role !== "tool") {
    return [];
  }

  for (let i = messages.length - 2; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      const toolCalls = msg.content.filter(
        (part): part is ToolCallPart =>
          Boolean(part && typeof part === "object" && (part as { type?: string }).type === "tool-call")
      );
      if (toolCalls.length === 0) continue;

      const callIds = new Set(toolCalls.map((tc) => tc.toolCallId));
      const matchingToolResults: ToolResultPart[] = [];

      for (let j = i + 1; j < messages.length; j++) {
        const nextMsg = messages[j];
        if (nextMsg.role === "tool" && Array.isArray(nextMsg.content)) {
          for (const part of nextMsg.content) {
            if (part && typeof part === "object" && (part as { type?: string }).type === "tool-result") {
              const res = part as ToolResultPart;
              if (res.toolCallId && callIds.has(res.toolCallId)) {
                matchingToolResults.push(res);
                callIds.delete(res.toolCallId);
              }
            }
          }
        }
      }

      if (callIds.size === 0 && matchingToolResults.length > 0) {
        const toolMsg: ModelMessage = {
          role: "tool",
          content: matchingToolResults
        };
        return [msg, toolMsg];
      }
    }
  }
  return [];
}

/**
 * Compact a conversation's working context using model assistance when usage approaches threshold
 * or when forced during error recovery.
 */
export async function compactConversation(params: CompactionParams): Promise<CompactionResult> {
  const {
    chain,
    systemPrompt,
    messages,
    snapshot,
    snapshots: paramSnapshots,
    contextLimit,
    force = false,
    abortSignal
  } = params;

  const tokensBefore = estimateTokens(messages) + estimateTokens(systemPrompt);

  if (!force && !shouldTriggerCompaction(tokensBefore, contextLimit)) {
    return {
      compacted: false,
      messages,
      tokensBefore,
      tokensAfter: tokensBefore,
      reason: "Usage below compaction threshold."
    };
  }

  // Extract snapshots across batched validate_build or fallback to params
  const fallbackSnapshots = paramSnapshots ?? snapshot;
  const snapshots = extractBuildSnapshots(messages, fallbackSnapshots);

  // 1. Prepare fitted summary request
  const contextData = prepareSummarizerPrompt(messages, snapshots, contextLimit);

  // 2. Generate model handoff
  let handoffText: string;
  try {
    handoffText = await generateHandoff({ chain, contextData, abortSignal });
  } catch (err) {
    if (abortSignal?.aborted) throw err;
    return {
      compacted: false,
      messages,
      tokensBefore,
      tokensAfter: tokensBefore,
      reason: `Handoff generation failed: ${err instanceof Error ? err.message : String(err)}`
    };
  }

  // 3. Validate handoff usability
  if (!handoffText || handoffText.trim().length < 20) {
    return {
      compacted: false,
      messages,
      tokensBefore,
      tokensAfter: tokensBefore,
      reason: "Handoff generation produced unusable or empty summary."
    };
  }

  // 4. Extract original user message to preserve initial prompt, and latest user message
  const userMessages = messages.filter((m) => m.role === "user");
  const firstUser = userMessages[0];
  const latestUser = userMessages.length > 0 ? userMessages[userMessages.length - 1] : undefined;
  const userContent = firstUser?.content ?? "Build a PC";

  // 5. Build fresh model messages starting with initial user prompt and assistant handoff
  const newMessages: ModelMessage[] = [
    {
      role: "user",
      content: userContent
    },
    {
      role: "assistant",
      content: `[Progress & Handoff Summary]\n${handoffText.trim()}`
    }
  ];

  // 6. Merge synthetic context (snapshot, search notes, shortlist, latest follow-up) into one user message
  const syntheticParts: string[] = [];

  if (snapshots.length > 0) {
    syntheticParts.push(
      `[Authoritative Build Snapshot]\n${formatSnapshotsForContext(snapshots)}`
    );
  }

  const deadEnds = extractUnsuccessfulSearches(messages);
  if (deadEnds.length > 0) {
    syntheticParts.push(
      `[Search History Notes]\nThe following searches returned 0 results; avoid repeating them:\n${deadEnds.map((d) => `- ${d}`).join("\n")}`
    );
  }

  const shortlist = extractRecentSearchShortlist(messages);
  if (shortlist.length > 0) {
    syntheticParts.push(formatShortlistForContext(shortlist));
  }

  // Keep latest user message word for word alongside the first one
  if (latestUser && latestUser !== firstUser) {
    const latestUserText = extractMessageText(latestUser.content);
    if (latestUserText) {
      syntheticParts.push(`[Latest User Request]\n${latestUserText}`);
    }
  }

  if (syntheticParts.length > 0) {
    newMessages.push({
      role: "user",
      content: syntheticParts.join("\n\n")
    });
  } else {
    newMessages.push({
      role: "user",
      content: "Continue with the build based on the handoff summary."
    });
  }

  // 7. Retain completed recent tool exchange if present
  const toolExchange = extractRetainedToolExchange(messages);
  if (toolExchange.length > 0) {
    newMessages.push(...toolExchange);
  }

  const tokensAfter = estimateTokens(newMessages) + estimateTokens(systemPrompt);

  // 8. Enforce headroom check
  const maxAllowedTokens = contextLimit - RESERVED_OUTPUT_TOKENS;
  if (tokensAfter >= maxAllowedTokens || tokensAfter >= tokensBefore) {
    return {
      compacted: false,
      messages,
      tokensBefore,
      tokensAfter,
      reason: "Compacted context does not leave required output headroom."
    };
  }

  return {
    compacted: true,
    messages: newMessages,
    handoffText,
    tokensBefore,
    tokensAfter
  };
}
