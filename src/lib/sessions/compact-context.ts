import type { ModelMessage } from "ai";

export type StoredCompactContext = {
  messages: ModelMessage[];
  boundaryMessageId?: string;
  snapshot?: unknown | null;
};

function isValidModelMessage(m: unknown): m is ModelMessage {
  if (!m || typeof m !== "object") return false;
  const rec = m as Record<string, unknown>;
  if (typeof rec.role !== "string") return false;
  if (!["user", "assistant", "system", "tool"].includes(rec.role)) return false;
  return rec.content !== undefined || Array.isArray(rec.parts);
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
    if (parsed.length > 0 && parsed.every(isValidModelMessage)) {
      return { messages: parsed as ModelMessage[] };
    }
    return null;
  }

  const rec = parsed as Record<string, unknown>;
  if (Array.isArray(rec.messages) && rec.messages.length > 0 && rec.messages.every(isValidModelMessage)) {
    return {
      messages: rec.messages as ModelMessage[],
      boundaryMessageId: typeof rec.boundaryMessageId === "string" ? rec.boundaryMessageId : undefined,
      snapshot: rec.snapshot ?? null
    };
  }

  return null;
}
