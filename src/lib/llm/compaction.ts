import type { ModelMessage, ToolCallPart, ToolResultPart } from "ai";
import type { LLMChainEntry } from "@/types";
import { generateTextWithFallback } from "./client";
import type { BuildSnapshot } from "../catalog/build-snapshot";
import { formatSnapshotForContext } from "./snapshot-formatter";
import { estimateTokens, shouldTriggerCompaction, RESERVED_OUTPUT_TOKENS } from "./context-budget";

export interface CompactionParams {
  chain: LLMChainEntry[];
  systemPrompt: string;
  messages: ModelMessage[];
  snapshot?: BuildSnapshot | null;
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
  total_matching?: number;
  in_stock_total?: number;
  error?: string;
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

/**
 * Extract a concise list of unsuccessful tool calls (e.g. search_products returning 0 matches)
 * preserving query and filter criteria so the resumed turn avoids repeating identical dead ends.
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
              callArgs.set(p.toolCallId, {
                category: typeof argsObj.category === "string" ? argsObj.category : undefined,
                query: typeof argsObj.query === "string" ? argsObj.query : undefined,
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
            const count = Array.isArray(outObj.results) ? outObj.results.length : 0;
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

function extractMessageText(content: unknown): string {
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
  snapshot?: BuildSnapshot | null,
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

  const sections = [
    `=== ORIGINAL USER REQUEST & CONSTRAINTS ===\n${initialBrief.slice(0, 1500)}`,
    priorHandoff ? `=== PREVIOUS HANDOFF ===\n${priorHandoff.slice(0, 2000)}` : "",
    corrections.length > 0 ? `=== USER CORRECTIONS & FOLLOW-UPS ===\n${corrections.join("\n").slice(0, 2000)}` : "",
    assistantNotes.length > 0 ? `=== RECENT COMPONENT DECISIONS & TRADEOFFS ===\n${assistantNotes.join("\n---\n").slice(0, 1500)}` : "",
    snapshot ? `=== CURRENT CODE-CALCULATED BUILD SNAPSHOT ===\n${formatSnapshotForContext(snapshot)}` : "",
    unsuccessful.length > 0 ? `=== SEARCH DEAD ENDS ===\n${unsuccessful.join("\n")}` : ""
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
 */
function extractRetainedToolExchange(messages: ModelMessage[]): ModelMessage[] {
  for (let i = messages.length - 1; i >= 0; i--) {
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
  const { chain, systemPrompt, messages, snapshot, contextLimit, force = false, abortSignal } = params;

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

  // 1. Prepare fitted summary request
  const contextData = prepareSummarizerPrompt(messages, snapshot, contextLimit);

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

  // 4. Extract original user message to preserve initial prompt
  const firstUser = messages.find((m) => m.role === "user");
  const userContent = firstUser?.content ?? "Build a PC";

  // 5. Build fresh model messages
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

  // 6. Carry authoritative build snapshot directly by code
  if (snapshot) {
    newMessages.push({
      role: "user",
      content: `[Authoritative Build Snapshot]\n${formatSnapshotForContext(snapshot)}`
    });
  }

  // 7. Retain unsuccessful searches as conversation data
  const deadEnds = extractUnsuccessfulSearches(messages);
  if (deadEnds.length > 0) {
    newMessages.push({
      role: "user",
      content: `[Search History Notes]\nThe following searches returned 0 results; avoid repeating them:\n${deadEnds.map((d) => `- ${d}`).join("\n")}`
    });
  }

  // 8. Retain completed recent tool exchange
  const toolExchange = extractRetainedToolExchange(messages);
  if (toolExchange.length > 0) {
    newMessages.push(...toolExchange);
  }

  const tokensAfter = estimateTokens(newMessages) + estimateTokens(systemPrompt);

  // 9. Enforce headroom check (Fix 4)
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
