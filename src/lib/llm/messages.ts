import { type UIMessage } from "ai";
import { toCompactSearchResult } from "@/lib/catalog/compact";

/** The message-part union the AI SDK accepts on a UIMessage. */
export type ChatMessagePart = UIMessage["parts"][number];

export type ChatMessage = {
  id?: string;
  role: "user" | "assistant" | "system";
  content?: string;
  parts?: ChatMessagePart[];
};

/**
 * A message as it arrives over HTTP: the route's zod schema only guarantees a
 * `type` string per part, so parts stay loosely typed until compaction hands
 * them to the SDK.
 */
export type IncomingChatMessage = {
  role: string;
  content?: string;
  parts?: Array<{ type: string } & Record<string, unknown>>;
};

/**
 * Scan for the LAST `tool-*` part whose tool name contains `validate_build` and
 * return its `input.parts` plus a compact verdict distilled from its output.
 * Powers "resume this build" on continue. Pure; returns null when no
 * validate_build call with parts exists.
 */
export function deriveBuildState(uiMessages: UIMessage[]): { parts: unknown; verdict?: unknown; snapshot?: unknown } | null {
  let found: { parts: unknown; verdict?: unknown; snapshot?: unknown } | null = null;
  for (const message of uiMessages) {
    if (!message.parts) continue;
    for (const part of message.parts) {
      const name = toolNameOf(part);
      if (!name || !name.includes("validate_build")) continue;
      const input = (part as { input?: unknown }).input;
      const parts = input && typeof input === "object" ? (input as Record<string, unknown>).parts : undefined;
      if (parts === undefined) continue;
      const output = (part as { output?: unknown }).output;
      const verdict = compactVerdict(output);
      const snapshot = output && typeof output === "object" ? (output as Record<string, unknown>).snapshot : undefined;
      found = {
        parts,
        ...(verdict !== undefined ? { verdict } : {}),
        ...(snapshot !== undefined ? { snapshot } : {})
      };
    }
  }
  return found;
}

/**
 * Compact chat messages for LLM context.
 * - Non-text parts are stripped to keep memory usage low (compact memory).
 * - Exception: tool parts (calls and results) are kept for the last assistant turn only,
 *   so immediately-preceding search results are still exact if the user references them.
 * - For search_products tool parts, compacts product fields across ALL historical candidates
 *   (preserving all returned parts while eliminating duplicate arrays and verbose metadata).
 */
export function compactChatMessages(messages: IncomingChatMessage[]): ChatMessage[] {
  const lastAssistantIdx = messages.reduce(
    (last, msg, idx) => (msg.role === "assistant" ? idx : last),
    -1
  );

  return messages.map((message, idx) => {
    const isLastAssistant = idx === lastAssistantIdx;
    if (isLastAssistant && message.parts) {
      // Keep tool parts for the last assistant turn only, compacting search outputs across all candidates
      const compactedParts = message.parts.map((part) => {
        const name = toolNameOf(part);
        if (name === "search_products") {
          const rawOutput = (part as { output?: unknown }).output;
          if (rawOutput && typeof rawOutput === "object") {
            return {
              ...part,
              output: toCompactSearchResult(rawOutput as Record<string, unknown>)
            };
          }
        }
        return part;
      });

      return {
        role: message.role as "user" | "assistant" | "system",
        content: message.content,
        parts: compactedParts as ChatMessagePart[]
      };
    }
    // Compact memory: strip non-text parts and merge text parts into content
    const textContent =
      message.content ??
      message.parts
        ?.flatMap((part) => (part.type === "text" && typeof part.text === "string" ? [part.text] : []))
        .join("\n") ??
      "";
    return {
      role: message.role as "user" | "assistant" | "system",
      content: textContent,
      parts: [{ type: "text", text: textContent }]
    };
  });
}

export const MAX_RESUME_MESSAGES = 40;

/**
 * Long-session guardrail: caps the replayed history at MAX_RESUME_MESSAGES.
 * Always keeps the first user message (which states the goal/budget).
 */
export function capMessages(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length <= MAX_RESUME_MESSAGES) {
    return messages;
  }
  const firstUser = messages.find((m) => m.role === "user");
  const recentCount = MAX_RESUME_MESSAGES - 1;
  const recent = messages.slice(-recentCount);
  const includesFirstUser = firstUser && recent.some((m) => m === firstUser);
  if (includesFirstUser) {
    return messages.slice(-MAX_RESUME_MESSAGES);
  }
  if (firstUser) {
    return [firstUser, ...recent];
  }
  return messages.slice(-MAX_RESUME_MESSAGES);
}

function compactVerdict(output: unknown): unknown | undefined {
  if (!output || typeof output !== "object") return undefined;
  const value = output as Record<string, unknown>;
  const issues = Array.isArray(value.issues) ? (value.issues as Array<{ severity?: string }>) : [];
  const blocking = issues.filter((issue) => issue?.severity === "blocking").length;
  return { valid: Boolean(value.valid), blocking, issues: issues.length };
}

function toolNameOf(part: unknown): string | null {
  if (!part || typeof part !== "object") return null;
  const type = (part as { type?: unknown }).type;
  if (typeof type !== "string") return null;
  if (type === "dynamic-tool") {
    const toolName = (part as { toolName?: unknown }).toolName;
    return typeof toolName === "string" ? toolName : null;
  }
  return type.startsWith("tool-") ? type.slice("tool-".length) : null;
}
