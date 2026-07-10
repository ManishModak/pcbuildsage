import { convertToModelMessages, type ModelMessage, type UIMessage } from "ai";

/**
 * Model-memory depth chosen per chat on *continue* (see the sessions/restore
 * design, Phase 3). Purely controls how history is replayed to the model — the
 * sessions store always keeps the complete UIMessage[] either way.
 */
export type MemoryMode = "full" | "compact";

type AnyPart = UIMessage["parts"][number];

/**
 * Prepare the model-facing history from the persisted UIMessage[].
 *
 * - `full`: replay everything verbatim (raw tool results included) — exact
 *   recall, largest context.
 * - `compact` (default): keep the conversation text + reasoning, but strip the
 *   bulky raw tool-result payloads down to a tiny stub. This is a PURE
 *   structural filter — no LLM summarization call. Call/result pairing stays
 *   intact so `convertToModelMessages` still produces well-formed messages.
 *
 * `convertToModelMessages` is async in this AI SDK version
 * (Promise<ModelMessage[]>), so this helper is async too.
 */
export async function prepareModelMessages(uiMessages: UIMessage[], mode: MemoryMode): Promise<ModelMessage[]> {
  const prepared = mode === "compact" ? uiMessages.map(compactMessage) : uiMessages;
  return convertToModelMessages(prepared);
}

/**
 * Scan for the LAST `tool-*` part whose tool name contains `validate_build` and
 * return its `input.parts` plus a compact verdict distilled from its output.
 * Powers "resume this build" on continue. Pure; returns null when no
 * validate_build call with parts exists.
 */
export function deriveBuildState(uiMessages: UIMessage[]): { parts: unknown; verdict?: unknown } | null {
  let found: { parts: unknown; verdict?: unknown } | null = null;
  for (const message of uiMessages) {
    for (const part of message.parts) {
      const name = toolNameOf(part);
      if (!name || !name.includes("validate_build")) continue;
      const input = (part as { input?: unknown }).input;
      const parts = input && typeof input === "object" ? (input as Record<string, unknown>).parts : undefined;
      if (parts === undefined) continue;
      const verdict = compactVerdict((part as { output?: unknown }).output);
      found = verdict === undefined ? { parts } : { parts, verdict };
    }
  }
  return found;
}

function compactMessage(message: UIMessage): UIMessage {
  return { ...message, parts: message.parts.map(compactPart) };
}

function compactPart(part: AnyPart): AnyPart {
  const record = part as { type?: string; state?: string; output?: unknown };
  const isTool = typeof record.type === "string" && (record.type.startsWith("tool-") || record.type === "dynamic-tool");
  if (isTool && record.state === "output-available") {
    return { ...part, output: stubToolOutput(record.output) } as AnyPart;
  }
  return part;
}

/** Replace a bulky tool result with a tiny placeholder, keeping a one-line count when derivable. */
function stubToolOutput(output: unknown): unknown {
  const summary = summarizeOutput(output);
  return summary ? { omitted: true, summary } : { omitted: true };
}

function summarizeOutput(output: unknown): string | null {
  if (!output || typeof output !== "object") return null;
  const value = output as Record<string, unknown>;
  if (Array.isArray(value.results)) return `${value.results.length} result${value.results.length === 1 ? "" : "s"}`;
  if (Array.isArray(value.issues)) return `${value.issues.length} issue${value.issues.length === 1 ? "" : "s"}`;
  return null;
}

/** A compact, low-token summary of a validate_build result (valid + issue counts). */
function compactVerdict(output: unknown): unknown | undefined {
  if (!output || typeof output !== "object") return undefined;
  const value = output as Record<string, unknown>;
  const issues = Array.isArray(value.issues) ? (value.issues as Array<{ severity?: string }>) : [];
  const blocking = issues.filter((issue) => issue?.severity === "blocking").length;
  return { valid: Boolean(value.valid), blocking, issues: issues.length };
}

/** Extract a tool's bare name from a UI message part (`tool-<name>` or `dynamic-tool`). */
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
