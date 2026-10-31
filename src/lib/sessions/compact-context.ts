import type { ModelMessage } from "ai";

export type StoredCompactContext = {
  messages: ModelMessage[];
  boundaryMessageId?: string;
  snapshot?: unknown | null;
};

/**
 * Compacted context comes back from the browser in hosted mode, so it is
 * untrusted input. Compaction only ever produces user/assistant/tool messages,
 * so a system message here could only be injected; the caps keep a crafted
 * payload from outgrowing what a real handoff produces.
 */
const COMPACT_CONTEXT_ROLES = ["user", "assistant", "tool"];
export const MAX_COMPACT_CONTEXT_MESSAGES = 50;
export const MAX_COMPACT_CONTEXT_CHARS = 400_000;

function isValidModelMessage(m: unknown): m is ModelMessage {
  if (!m || typeof m !== "object") return false;
  const rec = m as Record<string, unknown>;
  if (typeof rec.role !== "string") return false;
  if (!COMPACT_CONTEXT_ROLES.includes(rec.role)) return false;
  return rec.content !== undefined || Array.isArray(rec.parts);
}

function isAcceptableMessageList(messages: unknown[]): boolean {
  if (messages.length === 0 || messages.length > MAX_COMPACT_CONTEXT_MESSAGES) return false;
  if (!messages.every(isValidModelMessage)) return false;
  return JSON.stringify(messages).length <= MAX_COMPACT_CONTEXT_CHARS;
}

export function parseCompactContext(raw: unknown): StoredCompactContext | null {
  if (!raw) return null;
  let parsed = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object") return null;

  if (Array.isArray(parsed)) {
    if (isAcceptableMessageList(parsed)) {
      return { messages: parsed as ModelMessage[] };
    }
    return null;
  }

  const rec = parsed as Record<string, unknown>;
  if (Array.isArray(rec.messages) && isAcceptableMessageList(rec.messages)) {
    return {
      messages: rec.messages as ModelMessage[],
      boundaryMessageId: typeof rec.boundaryMessageId === "string" ? rec.boundaryMessageId : undefined,
      snapshot: rec.snapshot ?? null
    };
  }

  return null;
}
